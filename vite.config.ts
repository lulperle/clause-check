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
    // Two projects because the app runs in a browser and the three API interfaces run in
    // node. One shared jsdom environment would let an api test pass against a DOM that will
    // not exist in production, and `node:http` under jsdom is a different thing again.
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'api',
          environment: 'node',
          globals: true,
          include: ['api/**/*.test.ts'],
        },
      },
    ],
  },
});
