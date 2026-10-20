import { describe, expect, it } from 'vitest';
import { parseTelemetry, sanitizeTelemetry } from '../src';
import { TELE_OK } from './fixtures';

const NOW = Date.parse('2026-10-20T03:00:00Z');
const frame = (extra: string) => parseTelemetry(TELE_OK.replace(/\$$/, `&${extra}$`));

describe('sanitizeTelemetry', () => {
  it('keeps a real frame untouched', () => {
    const t = parseTelemetry(TELE_OK);
    const { patch, dropped } = sanitizeTelemetry(t, NOW);
    expect(dropped).toEqual([]);
    expect(patch).toEqual(t);
  });
  it('drops impossible electrical values only', () => {
    const { patch, dropped } = sanitizeTelemetry(frame("MPU1'5000&MPI2'-3&CTTE'300"), NOW);
    expect(patch.vL1).toBeNull();
    expect(patch.iL2).toBeNull();
    expect(patch.tempC).toBeNull();
    expect(dropped).toEqual(['vL1=5000', 'iL2=-3', 'tempC=300']);
    expect(patch.ltid).toBe(parseTelemetry(TELE_OK).ltid); // the rest of the frame stays
  });
  it('drops a GPS fix outside Vietnam and a LOGO clock from the past', () => {
    const { patch, dropped } = sanitizeTelemetry(frame("LGPS'48.85'2.35'7&PTIM'1990-01-01T00:00:00+07:00"), NOW);
    expect(patch.gps).toBeNull();
    expect(patch.deviceTime).toBeNull();
    expect(dropped).toHaveLength(2);
  });
});
