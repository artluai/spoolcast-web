import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    fs: {
      allow: [
        '/Users/ralphxu/Documents/Projects/spoolcast-web',
        '/Users/ralphxu/Documents/Projects/spoolcast-content',
      ],
    },
  },
})
