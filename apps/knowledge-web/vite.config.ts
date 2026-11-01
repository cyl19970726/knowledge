import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Server-side only: allow an isolated preview without redirecting another workspace's API.
const apiTarget = process.env.KNOWLEDGE_WEB_API_TARGET ?? 'http://127.0.0.1:4311';

export default defineConfig({
  plugins: [react()],
  root: import.meta.dirname,
  server: {
    host: '127.0.0.1',
    port: 4310,
    strictPort: true,
    proxy: { '/api': apiTarget },
  },
  preview: {
    host: '127.0.0.1',
    port: 4312,
    strictPort: true,
    proxy: { '/api': apiTarget },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        stress: resolve(import.meta.dirname, 'stress.html'),
      },
    },
  },
});
