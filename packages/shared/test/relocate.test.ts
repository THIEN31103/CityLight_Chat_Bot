import { describe, expect, it } from 'vitest';
import { GPS_RELOCATE_MAX_SPREAD_M, GPS_RELOCATE_MIN_MOVE_M, GPS_RELOCATE_MIN_SAMPLES, judgeGpsSuggestion } from '../src';

const good = { samples: 120, spreadM: 12, distanceM: 480 };

describe('judgeGpsSuggestion', () => {
  it('accepts many tight fixes far from the declared point', () => {
    expect(judgeGpsSuggestion(good)).toEqual({ ok: true, reason: null });
  });
  it('refuses without fixes or with too few', () => {
    expect(judgeGpsSuggestion({ ...good, samples: 0, spreadM: null, distanceM: null }).ok).toBe(false);
    const few = judgeGpsSuggestion({ ...good, samples: GPS_RELOCATE_MIN_SAMPLES - 1 });
    expect(few.ok).toBe(false);
    expect(few.reason).toContain(String(GPS_RELOCATE_MIN_SAMPLES - 1));
    expect(judgeGpsSuggestion({ ...good, samples: GPS_RELOCATE_MIN_SAMPLES }).ok).toBe(true);
  });
  it('refuses a jumping GPS', () => {
    expect(judgeGpsSuggestion({ ...good, spreadM: GPS_RELOCATE_MAX_SPREAD_M + 1 }).reason).toContain('chưa ổn định');
    expect(judgeGpsSuggestion({ ...good, spreadM: GPS_RELOCATE_MAX_SPREAD_M }).ok).toBe(true);
    expect(judgeGpsSuggestion({ ...good, spreadM: null }).ok).toBe(false);
  });
  it('nothing to do when it already matches', () => {
    expect(judgeGpsSuggestion({ ...good, distanceM: GPS_RELOCATE_MIN_MOVE_M - 1 }).reason).toContain('đã khớp');
  });
});
