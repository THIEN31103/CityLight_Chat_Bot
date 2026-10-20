// VI / EN switch (S49): changes the UI at once and saves the choice for the signed-in user (Telegram and exports follow).
import { LANGS, type Lang } from '@citylight/shared';
import { api } from '@/lib/api';
import { useDict, useLang } from '@/i18n';
import { SHELL } from '@/i18n/dict/shell';
import { useSession } from '@/stores/session';
import { cn } from '@/lib/utils';

export function LangSwitch({ className }: { className?: string }) {
  const { lang, setLang } = useLang();
  const user = useSession((s) => s.user);
  const t = useDict(SHELL);
  const choose = (l: Lang) => {
    if (l === lang) return;
    setLang(l);
    if (user) api.savePreferences({ lang: l }).then((u) => useSession.setState({ user: u }), () => undefined);
  };
  return (
    <div role="group" aria-label={t.langSwitch} title={t.langSwitch} className={cn('flex rounded-md border p-0.5 text-xs font-semibold', className)}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={l === lang}
          onClick={() => choose(l)}
          className={cn('rounded px-1.5 py-1 uppercase', l === lang ? 'bg-primary text-white' : 'text-subtle hover:bg-muted')}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
