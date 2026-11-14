// Who may use Jarvis (G4, spec 8.1). The CityLight role comes from GET /auth/me; the grants live here only.
//  - admin: always uses Jarvis; grants / revokes can_use for anyone; can_grant and can_view_chats for managers only
//  - manager with can_use + can_grant: can_use for operator / viewer / maintenance (roles below), not for itself
//  - manager with can_view_chats: reads the chats of operator / viewer / maintenance
//  - everybody reads their own chats
// Revoking a manager does not revoke what that manager granted (README).
import type { RoleKey } from '@citylight/shared';
import { canManageRole } from '@citylight/shared';
import type { Db } from './db';

export interface Access {
  userId: string;
  email: string;
  roleAtGrant: RoleKey;
  canUse: boolean;
  canGrant: boolean;
  canViewChats: boolean;
  grantedBy: string | null;
  grantedAt: string;
}

export interface Actor {
  id: string;
  role: RoleKey;
  access: Access | null;
}

export type Flag = 'canUse' | 'canGrant' | 'canViewChats';

/** Effective rights of a signed-in user: admin always has everything. */
export function rights(a: Actor) {
  if (a.role === 'admin') return { canUse: true, canGrant: true, canViewChats: true };
  return { canUse: !!a.access?.canUse, canGrant: !!a.access?.canUse && !!a.access?.canGrant, canViewChats: !!a.access?.canUse && !!a.access?.canViewChats };
}

/** May `actor` set `flag` on an account with role `targetRole`? */
export function canGrant(actor: Actor, target: { id: string; role: RoleKey }, flag: Flag): boolean {
  if (actor.role === 'admin') return flag === 'canUse' ? target.role !== 'admin' || target.id !== actor.id : target.role === 'manager';
  if (actor.role !== 'manager' || !rights(actor).canGrant) return false;
  if (target.id === actor.id || flag !== 'canUse') return false;
  return canManageRole('manager', target.role);
}

/** May `viewer` read the chats of an account that had `ownerRole` when it chatted? */
export function canViewChatsOf(viewer: Actor, owner: { id: string; role: RoleKey }): boolean {
  if (viewer.id === owner.id) return true;
  if (viewer.role === 'admin') return true;
  return viewer.role === 'manager' && rights(viewer).canViewChats && canManageRole('manager', owner.role);
}

/** May `actor` change Jarvis settings (spec 8.3)? */
export const canEditSettings = (a: Actor) => a.role === 'admin' || (a.role === 'manager' && rights(a).canGrant);

interface Row {
  user_id: string; email: string; role_at_grant: RoleKey; can_use: number; can_grant: number; can_view_chats: number; granted_by: string | null; granted_at: string;
}
const fromRow = (r: Row): Access => ({
  userId: r.user_id, email: r.email, roleAtGrant: r.role_at_grant, canUse: !!r.can_use, canGrant: !!r.can_grant, canViewChats: !!r.can_view_chats,
  grantedBy: r.granted_by, grantedAt: r.granted_at,
});

export function getAccess(db: Db, userId: string): Access | null {
  const r = db.prepare('SELECT * FROM access WHERE user_id = ?').get(userId) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function listAccess(db: Db): Access[] {
  return (db.prepare('SELECT * FROM access ORDER BY email').all() as unknown as Row[]).map(fromRow);
}

export function setAccess(db: Db, target: { id: string; email: string; role: RoleKey }, flags: Partial<Record<Flag, boolean>>, by: string): Access {
  const cur = getAccess(db, target.id);
  const next = {
    canUse: flags.canUse ?? cur?.canUse ?? false,
    canGrant: flags.canGrant ?? cur?.canGrant ?? false,
    canViewChats: flags.canViewChats ?? cur?.canViewChats ?? false,
  };
  db.prepare(
    `INSERT INTO access (user_id, email, role_at_grant, can_use, can_grant, can_view_chats, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, role_at_grant = excluded.role_at_grant, can_use = excluded.can_use,
       can_grant = excluded.can_grant, can_view_chats = excluded.can_view_chats, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
  ).run(target.id, target.email, target.role, Number(next.canUse), Number(next.canGrant), Number(next.canViewChats), by, new Date().toISOString());
  return getAccess(db, target.id)!;
}

/** First CityLight admin to sign in becomes the first Jarvis manager on record (spec 8.1). Returns true when it did. */
export function bootstrapAdmin(db: Db, user: { id: string; email: string; role: RoleKey }): boolean {
  if (user.role !== 'admin') return false;
  const any = db.prepare("SELECT 1 AS x FROM access WHERE role_at_grant = 'admin' LIMIT 1").get();
  if (any) return false;
  setAccess(db, user, { canUse: true, canGrant: true, canViewChats: true }, 'bootstrap');
  return true;
}

export function rememberUser(db: Db, u: { id: string; email: string; fullName: string; role: RoleKey }) {
  db.prepare(
    `INSERT INTO users_seen (user_id, email, full_name, role, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, full_name = excluded.full_name, role = excluded.role, last_seen = excluded.last_seen`,
  ).run(u.id, u.email, u.fullName, u.role, new Date().toISOString());
}
