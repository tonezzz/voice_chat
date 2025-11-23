import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_INSTRANS_API_PROXY || 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
});
