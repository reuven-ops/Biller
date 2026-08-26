import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'evals/test/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
