import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG, ERROR_CATALOG_EN, INCIDENT_CATEGORIES, INCIDENT_CATEGORY_LABELS, INCIDENT_TRANSITIONS, SECURITY_KIND_LABELS,
  SECURITY_KIND_LABELS_I18N, activeHealthAlarms, buildDiagnostics, decodeRs485SelfTest, defaultFieldMap, DEFAULT_FIELD_MAP, errorCatalog,
  errorOf, incidentTransitions, judgeGpsSuggestion, parseImportRows, shortUserAgent, validateDimming, type HealthInput,
} from '../src';

const VI_CHARS = /[À-ɏḀ-ỿ]/; // Latin letters with diacritics (Greek Ω / φ are fine)

describe('error catalog (S49)', () => {
  it('ERROR_CATALOG_EN has every code, with no Vietnamese left', () => {
    for (const e of ERROR_CATALOG) {
      const en = ERROR_CATALOG_EN[e.code];
      expect(en, e.code).toBeDefined();
      expect(en!.checks.length, e.code).toBe(e.checks.length);
      for (const s of [en!.title, en!.source, en!.cause, ...en!.checks]) expect(VI_CHARS.test(s), `${e.code}: ${s}`).toBe(false);
    }
    expect(Object.keys(ERROR_CATALOG_EN).sort()).toEqual(ERROR_CATALOG.map((e) => e.code).sort());
  });
  it('errorCatalog / errorOf keep the Vietnamese default', () => {
    expect(errorCatalog('vi')).toBe(ERROR_CATALOG);
    expect(errorOf('offline')!.title).toBe('Mất kết nối tủ');
    expect(errorOf('offline', 'en')).toMatchObject({ code: 'E101', title: 'Cabinet offline', severity: 'critical', category: 'Kết nối' });
  });
  it('RS485 self-test verdicts', () => {
    expect(decodeRs485SelfTest('A1D1B1C0')).toMatchObject({ rx: 'OK — RO được lái, bus rảnh mức cao', fail: false });
    expect(decodeRs485SelfTest('A1D1B1C1', 'en')).toEqual({
      rx: 'OK — RO driven, bus idle high',
      de: 'OK — driver off when DE=0',
      tx: 'Inconclusive — RO always 1 when DE=1 (driver not pulling low, or RE tied to DE + pull-up). Check with the slave LEDs / a multimeter',
      fail: true,
    });
    expect(decodeRs485SelfTest('junk', 'en').rx).toBe('Report could not be read');
  });
});

const NOW = Date.parse('2026-10-17T12:00:00Z');
const base: HealthInput = {
  online: true, lastSeenAt: '2026-10-17T11:59:55Z', busStatus: '0', plcOnline: true, pmOnline: true, branch1On: true, branch2On: false,
  vL1: 222, vL2: 223, vL3: 221, iL1: 18, iL2: 17, iL3: 19, leakMa: 12, tempC: 35, tempSensorFault: false, gpsDevice: { lat: 10.77, lng: 106.7 },
  batteryMv: 4000, deviceTime: '2026-10-17T11:59:00Z', deviceTimeChangedAt: '2026-10-17T11:59:30Z', lastBootAt: '2026-10-17T08:00:00Z',
  bootsLastHour: 0, bootsLast24h: 1, fwProfile: 'v2-current',
};

describe('health in English', () => {
  it('alarm messages', () => {
    expect(activeHealthAlarms({ ...base, busStatus: '4' }, NOW, 'en').get('bus_down')).toBe('LCLI=4: PLC_KEY, PM_KEY and CT_KEY all not responding');
    expect(activeHealthAlarms({ ...base, bootsLastHour: 3 }, NOW, 'en').get('flapping')).toBe('3 restarts within 1 hour');
    expect(activeHealthAlarms({ ...base, bootsLastHour: 3 }, NOW).get('flapping')).toBe('3 lần khởi động lại trong 1 giờ');
  });
  it('diagnostics items', () => {
    const d = buildDiagnostics({ ...base, busStatus: '4', plcOnline: false, pmOnline: false }, NOW, 'en');
    const by = Object.fromEntries(d.map((i) => [i.subsystem, i]));
    expect(by['RS485 bus']).toMatchObject({ code: 'E204', role: 'LTE ↔ PLC / PM / CT', evidence: 'LCLI=4' });
    expect(by['RS485 bus']!.detail).toBe('None of the 3 slaves respond — suspect a bus fault on the LTE side. Run the RS485 self-test.');
    expect(by['DH power meter']!.status).toBe('unknown');
    for (const i of d) for (const s of [i.subsystem, i.role, i.evidence, i.detail]) expect(VI_CHARS.test(s), s).toBe(false);
    // same items, same order as Vietnamese
    expect(buildDiagnostics(base, NOW).map((i) => [i.status, i.code])).toEqual(buildDiagnostics(base, NOW, 'en').map((i) => [i.status, i.code]));
  });
});

describe('other modules in English', () => {
  it('relocate judgment', () => {
    expect(judgeGpsSuggestion({ samples: 4, spreadM: 5, distanceM: 300 }, 'en').reason).toBe('Only 4 GPS fixes in 30 min, at least 10 needed');
    expect(judgeGpsSuggestion({ samples: 1, spreadM: 5, distanceM: 300 }, 'en').reason).toBe('Only 1 GPS fix in 30 min, at least 10 needed');
    expect(judgeGpsSuggestion({ samples: 4, spreadM: 5, distanceM: 300 }).reason).toBe('Mới có 4 điểm GPS trong 30 phút, cần ít nhất 10');
  });
  it('GIS import errors and English headers', () => {
    const rows = [
      { 'Cabinet code': 'TL01.0001', Branch: 'B2', 'Pole no.': 1, Latitude: 10.77, Longitude: 106.7, Lamps: 2, 'Power (W)': 150, 'Lamp group': 1 },
      { 'Cabinet code': 'TL01.0001', Branch: 'N3', 'Pole no.': 2, Latitude: 10.77, Longitude: 106.7 },
      { 'Cabinet code': 'TL01.0001', Branch: '1', 'Pole no.': 3, Latitude: 106.7, Longitude: 10.77 },
    ];
    const { poles, errors } = parseImportRows(rows, 'en');
    expect(poles).toHaveLength(1);
    expect(poles[0]).toMatchObject({ cabinetCode: 'TL01.0001', branch: 2, seq: 1, lampCount: 2, ratedPowerW: 150, lampGroup: 1 });
    expect(errors).toEqual([
      { row: 3, message: 'Branch must be 1/2, N1/N2 or B1/B2 (found "N3")' },
      { row: 4, message: 'Coordinates 106.7, 10.77 are outside Vietnam (latitude / longitude swapped?)' },
    ]);
    expect(parseImportRows(rows).errors[0]!.message).toBe('Nhánh phải là 1/2 hoặc N1/N2 (đang là "N3")');
  });
  it('dimming validation', () => {
    expect(validateDimming([{ enabled: true, startMin: 1200, endMin: 1100, levelPct: 50 }], 'en')).toEqual(['Period 1: end time must be after the start time']);
  });
  it('incidents, security, field map', () => {
    expect(incidentTransitions('resolved', 'en').map((t) => t.label)).toEqual(['Close incident', 'Reassign']);
    expect(incidentTransitions('resolved')).toEqual(INCIDENT_TRANSITIONS.resolved);
    expect(Object.keys(INCIDENT_CATEGORY_LABELS.en).sort()).toEqual([...INCIDENT_CATEGORIES].sort());
    expect(Object.keys(SECURITY_KIND_LABELS_I18N.en).sort()).toEqual(Object.keys(SECURITY_KIND_LABELS).sort());
    expect(shortUserAgent(null, 'en')).toBe('unknown browser');
    expect(shortUserAgent('curl/8.5.0', 'en')).toBe('command-line tool');
    expect(defaultFieldMap()).toBe(DEFAULT_FIELD_MAP);
    for (const e of defaultFieldMap('en')) expect(VI_CHARS.test(e.note), e.key).toBe(false);
  });
});
