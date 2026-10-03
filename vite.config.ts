import { defineConfig } from 'vite'

// base './' damit der Build unter https://<org>.github.io/port-experimente/ läuft
export default defineConfig({
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0])
