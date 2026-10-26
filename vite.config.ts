import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'web',
  envDir: '..',
  publicDir: 'public',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web/src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:3001', ws: true, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('chess.js') || id.includes('react-chessboard')) return 'chess';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('react-router') || id.includes('scheduler')) return 'react';
          if (id.includes('@tanstack') || id.includes('socket.io')) return 'data';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
});
