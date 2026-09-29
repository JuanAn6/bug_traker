import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          environment: 'node',
          setupFiles: ['./test/setup-env.ts'],
          // A real MariaDB schema; serialized because the suites truncate tables.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.spec.ts'],
          environment: 'node',
          setupFiles: ['./test/setup-env.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
