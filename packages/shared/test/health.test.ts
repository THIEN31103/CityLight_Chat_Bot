import { describe, expect, it } from 'vitest';
import { activeHealthAlarms, buildDiagnostics, deriveCabinetStatus, healthChecksPaused, type HealthInput } from '../src';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const base: HealthInput = {
  online: true,
  lastSeenAt: '2026-10-17T11:59:55Z',
  busStatus: '0',
  plcOnline: true,
  pmOnline: true,
  branch1On: true,
  branch2On: false,
  vL1: 222,
  vL2: 223,
  vL3: 221,
  iL1: 18,
  iL2: 17,
  iL3: 19,
  leakMa: 12,
  tempC: 35,
  tempSensorFault: false,
  tempSensorInstalled: true,
  gpsDevice: { lat: 10.77, lng: 106.7 },
  batteryMv: 4000,
  deviceTime: '2026-10-17T11:59:00Z',
  deviceTimeChangedAt: '2026-10-17T11:59:30Z',
  deviceTimeMissingSince: null,
  logoLink: null,
  lastBootAt: '2026-10-17T08:00:00Z',
  bootsLastHour: 0,
  bootsLast24h: 1,
  fwProfile: 'v2-current',
};
const types = (h: Partial<HealthInput>) => [...activeHealthAlarms({ ...base, ...h }, NOW).keys()].sort();

describe('activeHealthAlarms', () => {
  it('healthy cabinet has no alarms', () => expect(types({})).toEqual([]));
  it('offline suppresses device rules', () => expect(types({ online: false, busStatus: '4' })).toEqual(['offline']));
  it('maps LCLI to slave alarms', () => {
    expect(types({ busStatus: '1', plcOnline: false })).toEqual(['plc_lost']);
    expect(types({ busStatus: '2', pmOnline: false })).toEqual(['pm_lost']);
    expect(types({ busStatus: '3' })).toEqual(['ct_lost']);
    expect(types({ busStatus: '4', plcOnline: false, pmOnline: false })).toEqual(['bus_down']);
    expect(types({ busStatus: 'X' })).toEqual(['multi_slave_lost']);
  });
  it('LOGO lost when the PTIM minute is frozen > 150 s while PCON=1', () => {
    expect(types({ deviceTimeChangedAt: '2026-10-17T11:57:00Z' })).toEqual(['logo_lost']);
    expect(types({ deviceTimeChangedAt: '2026-10-17T11:58:00Z' })).toEqual([]);
    expect(types({ deviceTimeChangedAt: '2026-10-17T11:50:00Z', plcOnline: false, busStatus: '1' })).toEqual(['plc_lost']);
  });
  it('LOGO lost on PTIM=X > 15 s while PCON=1', () => {
    expect(types({ deviceTime: null, deviceTimeMissingSince: '2026-10-17T11:59:40Z' })).toEqual(['logo_lost']);
    expect(types({ deviceTime: null, deviceTimeMissingSince: '2026-10-17T11:59:50Z' })).toEqual([]);
  });
  it('LOGO lost at once on PLGO 2..5, with the probed cause as message', () => {
    expect(types({ logoLink: 3 })).toEqual(['logo_lost']);
    expect(types({ logoLink: 0 })).toEqual([]);
    // PLGO=1 (not probed yet) alone is not enough: it waits for the PTIM rule
    expect(types({ logoLink: 1 })).toEqual([]);
    expect(activeHealthAlarms({ ...base, logoLink: 2 }, NOW).get('logo_lost')).toMatch(/^PLGO=2/);
    expect(activeHealthAlarms({ ...base, logoLink: 3 }, NOW, 'en').get('logo_lost')).toMatch(/TCP/);
    expect(types({ logoLink: 4, plcOnline: false, busStatus: '1' })).toEqual(['plc_lost']);
  });
  it('DH meter lost vs phase loss', () => {
    expect(types({ vL1: 0, vL2: 0, vL3: 0, iL1: 0, iL2: 0, iL3: 0 })).toEqual(['dh_meter_lost']);
    expect(types({ vL3: 0, iL3: 0 })).toEqual(['phase_loss']);
  });
  it('sensor, gps, firmware, flapping', () => {
    expect(types({ tempSensorFault: true })).toEqual(['temp_sensor_fault']);
    expect(types({ tempSensorFault: true, busStatus: '3' })).toEqual(['ct_lost']);
    // S54: no DS18B20 fitted -> CTTE=1000 is not a fault
    expect(types({ tempSensorFault: true, tempSensorInstalled: false })).toEqual([]);
    expect(types({ gpsDevice: null })).toEqual(['gps_nofix']);
    expect(types({ gpsDevice: null, lastBootAt: '2026-10-17T11:55:00Z' })).toEqual([]);
    expect(types({ fwProfile: 'v2-1307ebc' })).toEqual(['fw_unsafe']);
    expect(types({ bootsLastHour: 3 })).toEqual(['flapping']);
  });
});

describe('deriveCabinetStatus', () => {
  it('follows spec section 6 priority', () => {
    expect(deriveCabinetStatus({ ...base, online: false }, true)).toBe('offline');
    expect(deriveCabinetStatus(base, true)).toBe('fault');
    expect(deriveCabinetStatus({ ...base, plcOnline: false, branch1On: null }, false)).toBe('unknown');
    expect(deriveCabinetStatus(base, false)).toBe('on');
    expect(deriveCabinetStatus({ ...base, branch1On: false }, false)).toBe('off');
  });
});

describe('buildDiagnostics', () => {
  it('temperature sensor not fitted: unsupported, not E503 (S54)', () => {
    const temp = (h: Partial<HealthInput>) => buildDiagnostics({ ...base, ...h }, NOW).find((i) => i.evidence.startsWith('CTTE') || i.evidence.startsWith('has_temp'))!;
    expect(temp({ tempSensorFault: true, tempSensorInstalled: false })).toMatchObject({ status: 'unsupported', code: null });
    expect(temp({ tempSensorFault: true })).toMatchObject({ status: 'fault', code: 'E503' });
  });
  it('marks dependents unknown when their bridge is lost', () => {
    const d = buildDiagnostics({ ...base, busStatus: '4', plcOnline: false, pmOnline: false }, NOW);
    const by = Object.fromEntries(d.map((i) => [i.subsystem, i]));
    expect(by['Bus RS485']!.code).toBe('E204');
    expect(by['LOGO (qua module ETH)']!.status).toBe('unknown');
    expect(by['Đồng hồ điện DH']!.status).toBe('unknown');
    expect(by['Cảm biến nhiệt DS18B20']!.status).toBe('unknown');
  });
});

describe('healthChecksPaused (ingest lost the broker)', () => {
  const grace = 60_000;
  it('pauses while disconnected or before the first subscription', () => {
    expect(healthChecksPaused({ connected: false, upSinceMs: null }, NOW, grace)).toBe(true);
    expect(healthChecksPaused({ connected: true, upSinceMs: null }, NOW, grace)).toBe(true);
  });
  it('pauses for offline_after once the link is back, then runs', () => {
    expect(healthChecksPaused({ connected: true, upSinceMs: NOW - 59_000 }, NOW, grace)).toBe(true);
    expect(healthChecksPaused({ connected: true, upSinceMs: NOW - 60_000 }, NOW, grace)).toBe(false);
  });
});
