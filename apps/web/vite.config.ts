import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * S10.i — Vite dev server config. The web client uses relative URLs
 * (`/api/rooms`, `/api/rooms/<slug>/ws`); in dev + Playwright E2E the
 * `server.proxy` config forwards them to the local wrangler at
 * 127.0.0.1:8787. `ws: true` covers the WebSocket upgrade for the room
 * realtime channel. Production hits the same paths against the deployed
 * worker on the same origin — no client code changes between envs.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
