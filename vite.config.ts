import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'client/public',
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', xfwd: true },
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
