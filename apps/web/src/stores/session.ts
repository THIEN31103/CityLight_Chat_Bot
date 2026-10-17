import { create } from 'zustand';
import type { User } from '@citylight/shared';
import { hasPermission, type Permission } from '@citylight/shared';

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
