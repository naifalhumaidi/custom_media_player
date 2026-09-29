import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom so the tests can load the real index.html and the real scripts.
    // Node alone has no document, and a hand-written stub would drift from the
    // shipped markup instead of testing it.
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js'],
    // the headless browser suites are run separately, by `npm run test:e2e`
    exclude: ['tests/e2e/**', 'node_modules/**'],
    restoreMocks: true,
  },
});
