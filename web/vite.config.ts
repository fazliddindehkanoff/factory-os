import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // During dev the API runs separately (npm run dev in the repo root, :3000).
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist' },
});
