import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Tooling (e.g. the Claude preview harness) assigns a port via $PORT;
    // plain `npm run dev` keeps the 5173 default.
    port: Number(process.env.PORT) || 5173,
    // PERMANENT FIX: Prevent browser caching of index.html during local dev
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
    fs: {
      allow: [
        '/Users/ralphxu/Documents/Projects/spoolcast-web',
        '/Users/ralphxu/Documents/Projects/spoolcast-content',
      ],
    },
  },
  preview: {
    // Also prevent caching when testing the production build locally via `npm run preview`
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  },
})
