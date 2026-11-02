import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Each isolated development instance can target its own loopback API.
const apiPort=Number(process.env.KNOWLEDGE_DEV_API_PORT??4311);
if(!Number.isInteger(apiPort)||apiPort<1||apiPort>65535)throw new Error('KNOWLEDGE_DEV_API_PORT must be a valid loopback port');
// An explicit preview target remains available for the R1 isolated stress harness.
const apiTarget=process.env.KNOWLEDGE_WEB_API_TARGET??`http://127.0.0.1:${apiPort}`;

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
