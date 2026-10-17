import { create } from 'zustand';
import type { User } from '@citylight/shared';
import { hasPermission, type Permission } from '@citylight/shared';
import { api, AUTH_EVENT } from '@/lib/api';

interface SessionState {
  user: User | null;
  setUser: (u: User | null) => void;
  can: (p: Permission) => boolean;
}

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  setUser: (user) => set({ user }),
  can: (p) => {
    const u = get().user;
    return !!u && hasPermission(u.role, p);
  },
}));

// Session gone (expired / revoked by an admin) -> back to login; forced step -> reload the user so the
// guard shows the 2FA-setup or password-change screen.
window.addEventListener(AUTH_EVENT, (e) => {
  const code = (e as CustomEvent<string>).detail;
  if (!useSession.getState().user) return;
  if (code === 'totp_setup_required' || code === 'password_change_required') {
    api.me().then((u) => useSession.getState().setUser(u), () => useSession.getState().setUser(null));
  } else useSession.getState().setUser(null);
});

type Theme = 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('cl.theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage blocked */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
}

interface UiState {
  theme: Theme;
  toggleTheme: () => void;
}

export const useUi = create<UiState>((set, get) => {
  const initial = readTheme();
  applyTheme(initial);
  return {
    theme: initial,
    toggleTheme: () => {
      const t: Theme = get().theme === 'dark' ? 'light' : 'dark';
      applyTheme(t);
      try {
        localStorage.setItem('cl.theme', t);
      } catch {
        /* storage blocked */
      }
      set({ theme: t });
    },
  };
});
