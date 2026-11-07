import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lightbulb, ShieldCheck } from 'lucide-react';
import { LANGS, LANG_NAMES, type Lang } from '@citylight/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/stores/session';
import { useDict, useLang } from '@/i18n';
import { COMMON } from '@/i18n/dict/common';
import { LOGIN } from '@/i18n/dict/login';
import { Button, Checkbox, Field, Input, Select } from '@/components/ui';
import { LoginParticles } from '@/components/LoginParticles';

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const setUser = useSession((s) => s.setUser);
  const { lang, setLang } = useLang();
  const t = useDict(LOGIN);
  const c = useDict(COMMON);
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
    <div className="dark login-void">
      <LoginParticles />
      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl content-center items-center gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10 lg:px-8">
        <header>
          <div className="mb-5 flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-[#241a00]">
              <Lightbulb className="h-4 w-4" />
            </span>
            CityLight
          </div>
          <h1 className="login-headline">
            <span className="login-headline-line">{t.heroLine}</span>
            <span className="login-headline-fill">{t.heroFill}</span>
          </h1>
          <p className="mt-4 max-w-sm text-sm text-subtle">{t.heroText}</p>
        </header>
        <form onSubmit={submit} className="login-glass mx-auto w-full max-w-sm space-y-4 rounded-2xl border p-6 lg:max-w-none lg:p-7">
          <div>
            <h2 className="text-xl font-bold">{step === 'creds' ? t.signIn : t.verify}</h2>
            <p className="mt-0.5 text-xs text-subtle">{t.tagline}</p>
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
        <Button type="submit" className="login-cta w-full text-[#241a00]" loading={loading}>
          {step === 'creds' ? t.signIn : t.verify}
        </Button>
        </form>
      </div>
    </div>
  );
}
