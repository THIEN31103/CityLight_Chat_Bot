import { describe, expect, it } from 'vitest';
import { LOG_ACTIONS } from './logs';

describe('activity log action labels', () => {
  it('has the same stored actions in both languages', () => {
    expect(Object.keys(LOG_ACTIONS.en).sort()).toEqual(Object.keys(LOG_ACTIONS.vi).sort());
  });
  it('shows the Vietnamese text as stored', () => {
    for (const [k, v] of Object.entries(LOG_ACTIONS.vi)) expect(v).toBe(k);
  });
  it('has an English text for every action', () => {
    for (const v of Object.values(LOG_ACTIONS.en)) expect(v.trim()).not.toBe('');
  });
});
