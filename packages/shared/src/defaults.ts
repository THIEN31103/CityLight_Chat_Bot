// Defaults used when a cabinet / zone has no stored configuration, and capability sets per firmware.
import type { Capability, CommandType, FwProfile, Schedule, Thresholds } from './domain';

export function defaultSchedule(): Schedule {
  return {
    mode: 1,
    source: 'manual',
    on1: '18:00',
    off1: '05:45',
    on2: '18:15',
    off2: '23:00',
    branch1Enabled: true,
    branch2Enabled: true,
    offsetOnMin: 10,
    offsetOffMin: -10,
    appliedAt: null,
    inheritedFromZone: true,
  };
}

export function defaultThresholds(): Thresholds {
  return {
    voltageHigh: { enabled: true, value: 240 },
    voltageLow: { enabled: true, value: 200 },
    voltageSwing: { enabled: false, value: 15 },
    currentHigh: { enabled: true, value: 45 },
    currentLow: { enabled: false, value: 2 },
    currentSwing: { enabled: false, value: 10 },
    currentNoLoad: { enabled: true, value: 0.5 },
    leakMa: { enabled: true, value: 30 },
    tempC: { enabled: true, value: 55 },
    batteryLowMv: { enabled: true, value: 3600 },
  };
}

/** spec 4.2 */
export function capabilitiesFor(fw: FwProfile): Capability[] {
  const base: Capability[] = ['telemetry.basic', 'schedule_write'];
  if (fw === 'v2-1307ebc') return base;
  const current: Capability[] = [...base, 'branch_state', 'manual_control', 'ltid_filter'];
  if (fw === 'v3') return [...current, 'per_cabinet_topic'];
  return current;
}

/** Capability a command needs on the device; types not listed need only telemetry + the shared cmd topic. */
export const COMMAND_CAPABILITY: Partial<Record<CommandType, Capability>> = {
  MANUAL_ALL: 'manual_control',
  MANUAL_BRANCH: 'manual_control',
  AUTO: 'manual_control',
  SET_SCHEDULE: 'schedule_write',
  SET_DIMMING: 'dimming',
  LAMP_CONTROL: 'smart_lamps',
};

/** Old field firmware 1307ebc does not filter LTID: any command would run on every cabinet (spec 4.2). */
export const firmwareBlocksCommands = (fw: FwProfile) => fw === 'v2-1307ebc';

/** Commands whose effect shows in telemetry (confirmed); the others end at "acked" (coreif confirmRule). */
export const CONFIRMED_BY_TELEMETRY: readonly CommandType[] = ['MANUAL_ALL', 'MANUAL_BRANCH', 'AUTO', 'SET_TIME'];
