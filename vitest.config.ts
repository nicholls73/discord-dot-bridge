import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    clearMocks: true,
    restoreMocks: true,
  },
});
