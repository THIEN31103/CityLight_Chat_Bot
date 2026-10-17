import { describe, expect, it } from 'vitest';
import { activeHealthAlarms, buildDiagnostics, deriveCabinetStatus, type HealthInput } from '../src';

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
  gpsDevice: { lat: 10.77, lng: 106.7 },
  batteryMv: 4000,
  deviceTime: '2026-10-17T11:59:00Z',
  deviceTimeChangedAt: '2026-10-17T11:59:30Z',
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
  it('LOGO lost when PTIM frozen > 5 min while PCON=1', () => {
    expect(types({ deviceTimeChangedAt: '2026-10-17T11:50:00Z' })).toEqual(['logo_lost']);
    expect(types({ deviceTimeChangedAt: '2026-10-17T11:50:00Z', plcOnline: false, busStatus: '1' })).toEqual(['plc_lost']);
  });
  it('DH meter lost vs phase loss', () => {
    expect(types({ vL1: 0, vL2: 0, vL3: 0, iL1: 0, iL2: 0, iL3: 0 })).toEqual(['dh_meter_lost']);
    expect(types({ vL3: 0, iL3: 0 })).toEqual(['phase_loss']);
  });
  it('sensor, gps, firmware, flapping', () => {
    expect(types({ tempSensorFault: true })).toEqual(['temp_sensor_fault']);
    expect(types({ tempSensorFault: true, busStatus: '3' })).toEqual(['ct_lost']);
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
  it('marks dependents unknown when their bridge is lost', () => {
    const d = buildDiagnostics({ ...base, busStatus: '4', plcOnline: false, pmOnline: false }, NOW);
    const by = Object.fromEntries(d.map((i) => [i.subsystem, i]));
    expect(by['Bus RS485']!.code).toBe('E204');
    expect(by['LOGO (qua module ETH)']!.status).toBe('unknown');
    expect(by['Đồng hồ điện DH']!.status).toBe('unknown');
    expect(by['Cảm biến nhiệt DS18B20']!.status).toBe('unknown');
  });
});
