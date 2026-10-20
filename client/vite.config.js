import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server on 5173 (matches CLIENT_ORIGIN in the server's .env.example).
// /api is proxied to the Express server, so the browser never makes a cross-origin call.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.VITE_API_TARGET || 'http://localhost:4000' },
  },
});
