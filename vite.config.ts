import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // /api is the relay (`npm run relay:dev`). It is only called when the app is
  // built with VITE_MODEL=relay; the default build never calls it.
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:8787' } },
  preview: { port: 4173, strictPort: true, proxy: { '/api': 'http://localhost:8787' } },
  build: { target: 'es2022', sourcemap: true },
});
