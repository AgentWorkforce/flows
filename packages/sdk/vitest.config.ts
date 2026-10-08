import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { FLOWS_NO_DAEMON_CHECK: '1' },
    include: ['tests/**/*.test.ts'],
    globals: false,
    setupFiles: ['tests/isolate-workspace.ts'],
  },
});
