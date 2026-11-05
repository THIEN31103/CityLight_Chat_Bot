// QR cabinet registration: what a scanned cabinet code means for the person standing at the cabinet.

/**
 * Position of a cabinet registered with no coordinates and no GPS fix yet. Once the device has a fix further than
 * 200 m away, E802 opens and a person applies "update from GPS": the position never moves on its own.
 */
export const DEFAULT_CABINET_LOCATION = { lat: 10.7769, lng: 106.7009 };

export type EnrollStatus =
  /** exactly one unregistered device reports this code: ready to confirm */
  | 'ready'
  /** no device reports this code yet: not powered, or not on the network yet */
  | 'waiting'
  /** a cabinet already has this code and no new board reports it */
  | 'registered'
  /** a cabinet has this code and one new board reports it: the board was replaced */
  | 'replace'
  /** several devices report this code, or one LTID was seen with two IMEIs: a person must check */
  | 'conflict';

export function judgeEnrollment(input: { registered: boolean; devices: number; imeiConflict: boolean }): EnrollStatus {
  if (input.devices > 1 || input.imeiConflict) return 'conflict';
  if (input.registered) return input.devices === 1 ? 'replace' : 'registered';
  return input.devices === 1 ? 'ready' : 'waiting';
}

/** Text read from a QR label or typed by hand -> cabinet code, or null when it cannot be one. */
export function parseCabinetCode(text: string): string | null {
  const s = text.trim();
  return /^[\w.-]{2,40}$/.test(s) ? s : null;
}
