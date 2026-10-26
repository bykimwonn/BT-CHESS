import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web/src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: true,
    setupFiles: ['tests/ui/setup.ts'],
    include: ['tests/ui/**/*.test.tsx', 'tests/ui/**/*.test.ts'],
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
});
