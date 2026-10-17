import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import './index.css';
import './stores/session';

// VITE_API_MODE: 'mock' (default, Cloudflare demo) | 'hybrid' (real API + mock for routes not built yet) | 'real'.
const MODE = (import.meta.env.VITE_API_MODE ?? (import.meta.env.VITE_USE_MOCK === 'false' ? 'real' : 'mock')) as 'mock' | 'hybrid' | 'real';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
  },
});

async function boot() {
  if (MODE === 'mock' || MODE === 'hybrid') {
    const { startMocks } = await import('./mocks/browser');
    await startMocks(MODE);
  } else {
    const { createSocketRealtime } = await import('./lib/realtime-socket');
    const { setRealtime } = await import('./lib/realtime');
    setRealtime(createSocketRealtime());
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

void boot();
