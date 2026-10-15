import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 3100,
    proxy: {
      '/api': {
        target: 'http://localhost:3101',
        changeOrigin: true
      },
      // M64 online table: the play client's WebSocket. Do not set
      // rewriteWsOrigin — the server checks the browser's real Origin.
      '/ws': {
        target: 'ws://localhost:3101',
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Two pages: the forge (index.html) and the M64 online-table
      // client (play.html). They share only pure modules.
      input: {
        main: 'index.html',
        play: 'play.html'
      }
    }
  }
});
