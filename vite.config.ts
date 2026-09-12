import react from '@vitejs/plugin-react';
// From `vitest/config`, not `vite`: the plain `defineConfig` type has no `test` key, so
// the block below type-errors on `npm run build` while still working at runtime.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Set so the built app can be served from a subpath (GitHub Pages) without editing
  // asset URLs. Defaults to '/' for local development.
  base: process.env.BASE_PATH ?? '/',
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
