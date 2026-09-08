import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/database/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    maxWorkers: 2,
    environmentOptions: {
      jsdom: { url: 'https://ayushghbk-afk.github.io/3d/' },
    },
  },
});
