import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
export default defineConfig({ plugins: [vue()], test: { environment: 'node', globals: true, include: ['tests/unit/**/*.test.ts'], coverage: { provider: 'v8', include: ['server/api/**/*.ts', 'server/credentials.ts', 'server/plugins/configuration-guard.ts', 'server/s3.ts', 'server/storage-adapter.ts', 'server/user-errors.ts', 'shared/**/*.ts'], thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 } } } })
