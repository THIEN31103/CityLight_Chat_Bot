// One fake cabinet = one MQTT client behaving like BOARD_LTE_KEY (dev_key_uid_dgb):
//  - anonymous connect, client id "ec25_<tick>", keepalive 60 s, QoS 0
//  - telemetry every 10 s on electrical_cabinets_default (same key order / formats as publish_frame_all)
//  - LQ2/LQ3/PMAN change -> publish after 0.5 s (FAST_FEEDBACK), other changes after 2 s, >= 1 s between frames
//  - commands on stm32/ec25/cmd: drop frames for other LTIDs, ack JSON on stm32/ec25/echo
//  - boot JSON on stm32/ec25/boot, LDIA report on stm32/ec25/demo
import mqtt, { type MqttClient } from 'mqtt';
import { TOPICS, encodeFrame, isoVn, parseFrame, parseIso } from '@citylight/coreif';

export type Fault =
  | 'none'
  | 'offline'
  | 'plc_lost'
  | 'bus_down'
  | 'pm_lost'
  | 'ct_lost'
  | 'dh_meter_lost'
  | 'phase_loss'
  | 'temp_sensor_fault'
  | 'logo_lost'
  | 'old_firmware'
  | 'ack_lost';

export interface CabinetOptions {
  ltid: string;
  brokerUrl: string;
  fault: Fault;
  location: { lat: number; lng: number };
  telemetryMs?: number;
  log?: (msg: string) => void;
  /** default: derived from the LTID (stable across runs: the server locks a cabinet to its first IMEI, S42) */
  imei?: string;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Stable 15-digit IMEI-like id for an LTID (FNV-1a), so a restarted simulator is the same "modem". */
export function imeiFor(ltid: string): string {
  let h = 0x811c9dc5;
  for (const ch of ltid.toUpperCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  let h2 = h;
  for (const ch of `${ltid}#imei`) h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `86${String(h).padStart(10, '0').slice(0, 7)}${String(h2).padStart(10, '0').slice(0, 6)}`;
}
const f1 = (n: number) => n.toFixed(1);

function minutes(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

export class SimCabinet {
  readonly ltid: string;
  readonly imei: string;
  private client: MqttClient | null = null;
  private bootTick = Date.now();
  private teleTimer: NodeJS.Timeout | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private lastPub = 0;
  // LOGO-side state
  private onTime = '18:00';
  private offTime = '05:45';
  private mode2 = false;
  private line1 = true;
  private line2 = true;
  private manual = false;
  private pln1 = false;
  private pln2 = false;
  private logoClockOffsetMs = 0;
  private frozenPtim: string | null = null;
  stats = { telemetry: 0, acks: 0, commands: 0 };

  constructor(private readonly o: CabinetOptions) {
    this.ltid = o.ltid.toUpperCase();
    this.imei = o.imei ?? imeiFor(this.ltid);
    if (o.fault === 'logo_lost') this.frozenPtim = isoVn(new Date(Date.now() - 14 * 60_000)).replace('+07:00', '.000+07:00');
  }

  private get newFirmware() {
    return this.o.fault !== 'old_firmware';
  }

  start() {
    if (this.o.fault === 'offline') return; // never connects: server must flag E101
    this.client = mqtt.connect(this.o.brokerUrl, {
      clientId: `ec25_${Math.floor(Math.random() * 2 ** 31)}`,
      keepalive: 60,
      reconnectPeriod: 30_000,
      connectTimeout: 10_000,
      clean: true,
    });
    this.client.on('connect', () => {
      this.bootTick = Date.now();
      this.client!.subscribe(TOPICS.command, { qos: 0 });
      this.client!.publish(TOPICS.boot, JSON.stringify({ boot: 'ok', imei: this.imei, tick: 3000 + Math.floor(rand(0, 2000)) }));
      this.client!.publish(
        TOPICS.demo,
        encodeFrame([['LTID', this.ltid], ['LDOM', 'sim.local'], ['LPOR', 1883], ['LIME', this.imei], ['LGPS', this.gps()]]),
      );
      this.publishTelemetry();
    });
    this.client.on('message', (topic, payload) => {
      if (topic === TOPICS.command) this.onCommand(payload.toString());
    });
    this.client.on('error', (e) => this.o.log?.(`[${this.ltid}] mqtt error: ${e.message}`));
    const every = this.o.telemetryMs ?? 10_000;
    // spread cabinets over the period like real devices booting at different times
    setTimeout(() => {
      this.teleTimer = setInterval(() => this.publishTelemetry(), every);
    }, Math.random() * every);
  }

  async stop() {
    if (this.teleTimer) clearInterval(this.teleTimer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    await this.client?.endAsync();
  }

  // ---------------- state ----------------

  private plcOk() {
    return !['plc_lost', 'bus_down'].includes(this.o.fault);
  }
  private pmOk() {
    return !['pm_lost', 'bus_down'].includes(this.o.fault);
  }
  private ctOk() {
    return !['ct_lost', 'bus_down'].includes(this.o.fault);
  }

  private scheduleOn(nowMin: number, on: string, off: string) {
    const a = minutes(on);
    const b = minutes(off);
    return a <= b ? nowMin >= a && nowMin < b : nowMin >= a || nowMin < b;
  }

  /** Real branch outputs (LOGO Q2/Q3). */
  private branches(): [boolean, boolean] {
    if (this.manual) return [this.pln1, this.pln2];
    const now = new Date(Date.now() + 7 * 3600_000 + this.logoClockOffsetMs);
    const m = now.getUTCHours() * 60 + now.getUTCMinutes();
    const lit = this.scheduleOn(m, this.onTime, this.offTime);
    if (this.mode2 && (this.line1 || this.line2)) return [lit && this.line1, lit && this.line2];
    return [lit, lit];
  }

  private gps() {
    const { lat, lng } = this.o.location;
    return `${lat.toFixed(7)}'${lng.toFixed(7)}'${Math.floor(rand(4, 9)) + 3}`;
  }

  private ptim(): string {
    if (this.frozenPtim) return this.frozenPtim;
    const d = new Date(Date.now() + this.logoClockOffsetMs);
    return isoVn(new Date(Math.floor(d.getTime() / 60_000) * 60_000)).replace('+07:00', `.${String(Date.now() % 1000).padStart(3, '0')}+07:00`);
  }

  buildTelemetry(): string {
    const plc = this.plcOk();
    const pm = this.pmOk();
    const ct = this.ctOk();
    const [b1, b2] = this.branches();
    const lit = b1 || b2;
    const lcliMask = (plc ? 0 : 1) | (pm ? 0 : 2) | (ct ? 0 : 4);
    const lcli = ({ 0: '0', 1: '1', 2: '2', 4: '3', 7: '4' } as Record<number, string>)[lcliMask] ?? 'X';
    const dh = pm && this.o.fault !== 'dh_meter_lost';
    const v = (base: number) => (dh ? f1(base + rand(-4, 4)) : '0.0');
    const i = (on: boolean) => (dh ? f1(on ? rand(14, 22) : rand(0, 0.3)) : '0.0');
    const pf = () => (dh && lit ? String(Math.round(rand(90, 97))) : '0');
    const pairs: [string, string | number][] = [
      ['LTID', this.ltid],
      ['LDOM', 'sim.local'],
      ['LPOR', 1883],
      ['LIME', this.imei],
      ['LGPS', this.gps()],
      ['LTIM', 'X'],
      ['LCLI', lcli],
      ['LBAT', Math.floor(rand(3900, 4150))],
      ['LACI', 'X'],
      ['LERR', 0],
      ['CTVL', ct ? Math.floor(rand(5, 25)) : 0],
      ['CTTE', ct ? (this.o.fault === 'temp_sensor_fault' ? 1000 : Math.floor(rand(30, 42))) : 0],
      ['MCON', pm ? 1 : 0],
      ['MPU1', v(222)],
      ['MPU2', v(223)],
      ['MPU3', this.o.fault === 'phase_loss' ? '0.0' : v(221)],
      ['MPI1', i(b1)],
      ['MPI2', i(b2)],
      ['MPI3', this.o.fault === 'phase_loss' ? '0.0' : i(lit)],
      ['MCO1', pf()],
      ['MCO2', pf()],
      ['MCO3', pf()],
      ['MCOS', pf()],
      ['MPOW', dh ? f1(lit ? rand(9, 13) : 0.1) : '0.0'],
      ['PCON', plc ? 1 : 0],
      ['PIN5', this.mode2 ? 1 : 0],
      ['LINE1', this.line1 ? 1 : 0],
      ['LINE2', this.line2 ? 1 : 0],
    ];
    if (this.newFirmware) {
      pairs.push(['LQ2', plc ? (b1 ? 1 : 0) : 'X'], ['LQ3', plc ? (b2 ? 1 : 0) : 'X'], ['PMAN', plc ? (this.manual ? 1 : 0) : 'X']);
    }
    pairs.push(['PTIM', plc ? this.ptim() : 'X']);
    return encodeFrame(pairs);
  }

  publishTelemetry() {
    if (!this.client?.connected) return;
    this.client.publish(TOPICS.telemetry, this.buildTelemetry(), { qos: 0 });
    this.lastPub = Date.now();
    this.stats.telemetry++;
  }

  /** FAST_FEEDBACK: branch/manual change -> 0.5 s, other change -> 2 s, >= 1 s between frames. */
  private schedulePublish(fast: boolean) {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    const wait = Math.max(fast ? 500 : 2000, 1000 - (Date.now() - this.lastPub));
    this.pendingTimer = setTimeout(() => this.publishTelemetry(), wait);
  }

  // ---------------- commands ----------------

  private onCommand(raw: string) {
    let fields: Record<string, string>;
    let order: string[];
    try {
      ({ fields, order } = parseFrame(raw));
    } catch {
      return; // firmware echoes nothing useful for garbage frames
    }
    const target = (fields.LTID ?? '').toUpperCase();
    if (this.newFirmware) {
      if (!target) return; // frames without LTID are dropped silently
      if (target !== this.ltid && target !== 'ALL') return;
    }
    this.stats.commands++;
    const acks: { k: string; rc: number }[] = [];
    let branchTouched = false;
    let other = false;
    const logoApplies = this.o.fault !== 'logo_lost';
    for (const key of order) {
      if (key === 'LTID') continue;
      const val = fields[key]!;
      if (target === 'ALL' && key !== 'LTIM') {
        acks.push({ k: key, rc: -2 });
        continue;
      }
      const bit = val === '1' ? true : val === '0' ? false : null;
      let rc = 0;
      switch (key) {
        case 'PMAN':
        case 'PLN1':
        case 'PLN2':
          if (!this.newFirmware) rc = -2;
          else if (bit === null && val.toUpperCase() !== 'X') rc = -1;
          else if (!this.plcOk()) rc = -1;
          else if (bit !== null && logoApplies) {
            // LOGO applies the change ~1-3 s later (PLC_KEY write + Q poll)
            setTimeout(() => {
              if (key === 'PMAN') this.manual = bit;
              if (key === 'PLN1') this.pln1 = bit;
              if (key === 'PLN2') this.pln2 = bit;
              this.schedulePublish(true);
            }, rand(1000, 3000));
            branchTouched = true;
          }
          break;
        case 'PI50':
        case 'LINE1':
        case 'LINE2':
        case 'PI2O':
          if (bit === null) rc = val.toUpperCase() === 'X' ? 0 : -1;
          else if (!this.plcOk()) rc = -1;
          else {
            if (key === 'PI50') this.mode2 = bit;
            if (key === 'LINE1') this.line1 = bit;
            if (key === 'LINE2') this.line2 = bit;
            other = true;
          }
          break;
        case 'T10':
        case 'T20':
        case 'T11':
        case 'T21': {
          const m = /T(\d{2}):(\d{2})/.exec(val);
          if (!m) rc = -1;
          else if (!this.plcOk()) rc = -1;
          else {
            if (key === 'T10') this.onTime = `${m[1]}:${m[2]}`;
            if (key === 'T20') this.offTime = `${m[1]}:${m[2]}`;
            other = true;
          }
          break;
        }
        case 'T12':
        case 'T22':
          rc = -2; // TIETGIAM_ENABLE 0
          break;
        case 'LTIM': {
          const iso = parseIso(val);
          if (!iso) rc = -1;
          else {
            if (!this.frozenPtim) this.logoClockOffsetMs = 0;
            other = true;
          }
          break;
        }
        case 'LDIA': {
          const report =
            `[RS485] id=${this.ltid}\r\n` +
            '[RS485] A DE=0 DI=1 RO=1 | D DE=0 DI=0 RO=1 | B DE=1 DI=1 RO=1 | C DE=1 DI=0 RO=1\r\n' +
            '[RS485] RX path : OK (RO driven, bus idle high)\r\n' +
            '[RS485] DE off  : OK (driver off when DE=0)\r\n' +
            '[RS485] TX path : INCONCLUSIVE: RO stays 1 with DE=1.\r\n' +
            '[RS485] RESULT: FAIL\r\n';
          this.client?.publish(TOPICS.demo, report);
          rc = -1; // firmware returns -1 when the self-test is not conclusive
          break;
        }
        default:
          rc = this.newFirmware ? -2 : 0; // old firmware acks stubs with 0
      }
      acks.push({ k: key, rc });
    }
    const ack = this.newFirmware ? { id: this.ltid, ack: acks, ts: Date.now() - this.bootTick } : { ack: acks, ts: Date.now() - this.bootTick };
    // ack_lost: the command runs but the echo never reaches the server (server must time out / retry)
    if (this.o.fault !== 'ack_lost') {
      this.client?.publish(TOPICS.echo, JSON.stringify(ack));
      this.stats.acks++;
    }
    if (branchTouched || other) this.schedulePublish(branchTouched);
  }
}
