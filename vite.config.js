import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH || './',
  server: {
    host: true,
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
