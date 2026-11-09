import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PROJECT_IDS: '98765432-aaaa-4bbb-8ccc-0123456789ab, 11111111-2222-4333-8444-555555555555',
            ADMIN_TOKEN: 'test-admin-token-0123456789-abcdefghijklmnop',
            PEPPER: 'test-pepper-0123456789',
            // Tests never reach Expo: the forwarding tests stub fetch and switch it on per request.
            FORWARD_TO_EXPO: '0',
            RETENTION_DAYS: '30',
            ALLOWED_ORIGINS: '',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
