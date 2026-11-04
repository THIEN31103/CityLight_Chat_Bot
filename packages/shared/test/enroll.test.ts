import { describe, expect, it } from 'vitest';
import { DEFAULT_CABINET_LOCATION, inRegion, judgeEnrollment, parseCabinetCode } from '../src';
import { loadServiceRegion } from '../src/region-node';

describe('QR registration verdict', () => {
  it('one unregistered device reporting the code is ready', () => {
    expect(judgeEnrollment({ registered: false, devices: 1, imeiConflict: false })).toBe('ready');
  });
  it('no device yet means waiting, not an error', () => {
    expect(judgeEnrollment({ registered: false, devices: 0, imeiConflict: false })).toBe('waiting');
  });
  it('two devices with one code are never registered automatically', () => {
    expect(judgeEnrollment({ registered: false, devices: 2, imeiConflict: false })).toBe('conflict');
  });
  it('one device seen with two IMEIs needs a person', () => {
    expect(judgeEnrollment({ registered: false, devices: 1, imeiConflict: true })).toBe('conflict');
  });
  it('a code already in use stays registered even when a new device reports it', () => {
    expect(judgeEnrollment({ registered: true, devices: 1, imeiConflict: false })).toBe('registered');
  });
});

describe('default cabinet position', () => {
  it('lies inside the trial region, or a cabinet without coordinates could not be registered', () => {
    const region = loadServiceRegion('hcm-2025');
    expect(region).not.toBeNull();
    expect(inRegion(region!, DEFAULT_CABINET_LOCATION)).toBe(true);
  });
});

describe('cabinet code from a QR label', () => {
  it('keeps the code and drops surrounding spaces', () => {
    expect(parseCabinetCode(' TM0001\n')).toBe('TM0001');
    expect(parseCabinetCode('TL01.0123')).toBe('TL01.0123');
  });
  it('refuses what is not a cabinet code', () => {
    expect(parseCabinetCode('')).toBeNull();
    expect(parseCabinetCode('A')).toBeNull();
    expect(parseCabinetCode('https://example.com/x')).toBeNull();
    expect(parseCabinetCode('TM 0001')).toBeNull();
    expect(parseCabinetCode('X'.repeat(41))).toBeNull();
  });
});
