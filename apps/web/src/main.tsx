import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import './index.css';
import './stores/session';

// Mock API is on unless VITE_USE_MOCK=false (M1-UI has no backend yet).
const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
  },
});

async function boot() {
  if (USE_MOCK) {
    const { startMocks } = await import('./mocks/browser');
    await startMocks();
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
