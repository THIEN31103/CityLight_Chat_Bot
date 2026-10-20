import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lightbulb, ShieldCheck } from 'lucide-react';
import { LANGS, LANG_NAMES, type Lang } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession, useUi } from '@/stores/session';
import { useDict, useLang } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { LOGIN } from '@/i18n/dict/login';
import { SHELL } from '@/i18n/dict/shell';
import { Button, Checkbox, Field, Input, Select, ThemeIcon } from '@/components/ui';

const USE_MOCK = (import.meta.env.VITE_API_MODE ?? 'mock') === 'mock' && import.meta.env.VITE_USE_MOCK !== 'false';

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const setUser = useSession((s) => s.setUser);
  const { theme, toggleTheme } = useUi();
  const { lang, setLang } = useLang();
  const t = useDict(LOGIN);
  const c = useDict(COMMON);
  const shell = useDict(SHELL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [step, setStep] = useState<'creds' | 'totp'>('creds');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const done = (u: Parameters<typeof setUser>[0]) => {
    // the language picked here becomes the account's (S49)
    if (u && u.lang !== lang) {
      api.savePreferences({ lang }).then((x) => setUser(x), () => undefined);
      u = { ...u, lang };
    }
    setUser(u);
    nav(params.get('next') || '/', { replace: true });
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (step === 'creds') {
        const r = await api.login(email, password, remember);
        if (r.requires2fa) setStep('totp');
        else done(r.user!);
      } else {
        const r = await api.verify2fa(useRecovery ? { recoveryCode: code } : { code });
        done(r.user);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : c.networkError);
      // 5-minute 2FA window passed, or the account got locked: start again from the password
      if (err instanceof ApiError && (err.code === 'challenge_expired' || err.code === 'account_locked')) {
        setStep('creds');
        setCode('');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <button className="absolute right-4 top-4 rounded-md p-2 hover:bg-muted" onClick={toggleTheme} aria-label={shell.themeToggle}>
        <ThemeIcon dark={theme === 'dark'} />
      </button>
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border bg-panel p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-white">
            <Lightbulb className="h-5 w-5" />
          </div>
          <div>
            <div className="text-lg font-semibold">CityLight</div>
            <div className="text-xs text-subtle">{t.tagline}</div>
          </div>
        </div>

        {step === 'creds' ? (
          <>
            <Field label={t.email}>
              <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label={t.password}>
              <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <div className="flex items-center justify-between">
              <Checkbox label={t.remember} checked={remember} onChange={setRemember} />
              <Select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="h-8" aria-label={c.language}>
                {LANGS.map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}
              </Select>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-5 w-5 text-st-on" /> {useRecovery ? t.recoveryPrompt : t.totpPrompt}
            </div>
            {useRecovery ? (
              <Field label={t.recoveryCode}>
                <Input key="rc" autoComplete="off" maxLength={12} placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus className="font-mono" />
              </Field>
            ) : (
              <Field label={t.totpCode}>
                <Input key="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus className="font-mono tracking-widest" />
              </Field>
            )}
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? t.useApp : t.lostPhone}
            </button>
          </>
        )}

        {error && <div className="rounded-md bg-st-offline/10 px-3 py-2 text-sm text-st-offline">{error}</div>}
        <Button type="submit" className="w-full" loading={loading}>
          {step === 'creds' ? t.signIn : t.verify}
        </Button>
        {USE_MOCK && (
          <div className="rounded-md bg-muted px-3 py-2 text-xs text-subtle">
            {t.mockNote} <code>server/README.md</code>.
          </div>
        )}
      </form>
    </div>
  );
}
