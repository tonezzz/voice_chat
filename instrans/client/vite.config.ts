import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const env = loadEnv(mode, root, '');
  const base = env.VITE_INSTRANS_BASE_PATH || '/';

  return {
    base,
    plugins: [react()],
    server: {
      port: 5175,
      host: true,
      proxy: {
        '/api': {
          target: env.VITE_INSTRANS_API_PROXY || env.VITE_INSTRANS_API_BASE || 'http://localhost:3100',
          changeOrigin: true,
        },
      },
    },
  };
});
