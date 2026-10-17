import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@citylight/shared';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';
import { Spinner } from '../ui';
import { ForbiddenPage } from '@/pages/ErrorPages';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, setUser } = useSession();
  const [checked, setChecked] = useState(!!user);
  const loc = useLocation();

  useEffect(() => {
    if (user) return;
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setChecked(true));
  }, [user, setUser]);

  if (!checked)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

/** Missing permission shows a clear 403 page — never a redirect to login. */
export function RequirePerm({ perm, children }: { perm: Permission; children: React.ReactNode }) {
  const can = useSession((s) => s.can(perm));
  return can ? <>{children}</> : <ForbiddenPage />;
}
