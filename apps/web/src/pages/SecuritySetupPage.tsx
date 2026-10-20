// Full-screen step shown before the app when the server requires it (spec 13):
// change an admin-issued temporary password, then set up 2FA if the role needs it.
import { KeyRound, Lightbulb, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useSession } from '@/stores/session';
import { fill, useDict, useLabels } from '@/i18n';
import { SETUP } from '@/i18n/dict/account';
import { SHELL } from '@/i18n/dict/shell';
import { ChangePasswordForm, TotpEnroll } from '@/components/security';
import { Button, ToastHost } from '@/components/ui';

export function SecuritySetupPage({ step }: { step: 'password' | 'totp' }) {
  const { user, setUser } = useSession();
  const t = useDict(SETUP);
  const shell = useDict(SHELL);
  const L = useLabels();
  if (!user) return null;
  const logout = () => api.logout().finally(() => setUser(null));
  const refresh = () => api.me().then(setUser);

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-panel p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white"><Lightbulb className="h-4 w-4" /></div>
            <div>
              <div className="font-semibold">CityLight</div>
              <div className="text-xs text-subtle">{user.email} · {L.role[user.role]}</div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={logout}><LogOut className="h-4 w-4" /> {shell.logout}</Button>
        </div>
        {step === 'password' ? (
          <>
            <h1 className="flex items-center gap-2 text-base font-semibold"><KeyRound className="h-5 w-5" /> {t.newPasswordTitle}</h1>
            <p className="text-sm text-subtle">{t.newPasswordBody}</p>
            <ChangePasswordForm forced onDone={refresh} />
          </>
        ) : (
          <>
            <h1 className="flex items-center gap-2 text-base font-semibold"><ShieldCheck className="h-5 w-5" /> {t.totpTitle}</h1>
            <p className="text-sm text-subtle">{fill(t.totpBody, { role: L.role[user.role] })}</p>
            <TotpEnroll onDone={setUser} />
          </>
        )}
      </div>
      <ToastHost />
    </div>
  );
}
