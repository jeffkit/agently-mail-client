import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:3030', changeOrigin: true },
    },
  },
  build: {
    outDir: '../src/dashboard-dist',
    emptyOutDir: true,
  },
});
