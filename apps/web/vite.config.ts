import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // Sub-path hosting (GitLab Pages serves the site under /<project>/): CI passes VITE_BASE. Local dev = '/'.
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // MapLibre 6 loads its worker via new URL('./maplibre-gl-worker.mjs', import.meta.url); pre-bundling breaks that path.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  server: {
    port: 5173,
    // Real API (M1+). In mock mode MSW answers /api in the browser.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
