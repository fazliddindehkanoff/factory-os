import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // During dev the API runs separately (npm run dev in the repo root, :3000).
    proxy: {
      '/api': 'http://localhost:3000',
      '/snab-dashboard': 'http://localhost:3000',
    },
    // Allow the ngrok tunnel to reach the dev server. The `.` prefix whitelists
    // any subdomain, so a rotated ngrok URL keeps working.
    allowedHosts: ['0955-144-124-196-117.ngrok-free.app', '.ngrok-free.app'],
  },
  build: { outDir: 'dist' },
});
