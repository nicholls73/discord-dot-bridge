import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

async function createRuntime() {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      contents: `
        import { BridgeStateDO } from './src/bridge-state.ts';
        export class AlarmProbe extends BridgeStateDO {
          async fetch(request) {
            const storage = this.ctx.storage;
            const base = Date.now();
            if (new URL(request.url).pathname === '/transaction') {
              const methods = await storage.transaction(async (txn) => {
                const types = { getAlarm: typeof txn.getAlarm, setAlarm: typeof txn.setAlarm, deleteAlarm: typeof txn.deleteAlarm };
                await txn.put('marker', 'committed');
                await txn.setAlarm(base + 600000);
                return { ...types, alarm: await txn.getAlarm() };
              });
              const committedAlarm = await storage.getAlarm();
              const rolledBack = [];
              for (const operation of ['set', 'delete']) {
                try {
                  await storage.transaction(async (txn) => {
                    await txn.put('marker', 'must roll back');
                    if (operation === 'set') await txn.setAlarm(base + 700000);
                    else await txn.deleteAlarm();
                    throw new Error('intentional rollback');
                  });
                } catch (error) {
                  if (error.message !== 'intentional rollback') throw error;
                }
                rolledBack.push({ alarm: await storage.getAlarm(), marker: await storage.get('marker') });
              }
              await storage.transaction(async (txn) => { await txn.deleteAlarm(); });
              return Response.json({ base, methods, committedAlarm, rolledBack, deletedAlarm: await storage.getAlarm() });
            }

            const observed = [];
            // Test-only JS access to the private method: bundle the production class
            // unchanged instead of duplicating scheduling logic or widening its API.
            const schedule = async () => {
              await this.scheduleNextWake();
              const alarm = await storage.getAlarm();
              observed.push(alarm === null ? null : alarm - base);
            };
            await storage.put('delivery:synthetic', { nextAttemptAt: base + 30000 });
            await storage.put('typing:channel:55555555555555555', {
              events: { '66666666666666666': base + 300000 }, nextAttemptAt: base + 60000, failures: 0,
            });
            await storage.put('gateway:next-alarm-at', base + 120000);
            await storage.put('origin:66666666666666666', { expiresAt: base + 180000 });
            await storage.put('discord:oauth-state', { expiresAt: base + 420000 });
            await schedule();
            await storage.delete('delivery:synthetic');
            await schedule();
            await storage.put('typing:global-backoff', base + 240000);
            await schedule();
            await storage.delete('gateway:next-alarm-at');
            await schedule();
            await storage.delete('origin:66666666666666666');
            await schedule();
            await storage.put('typing:global-backoff', base + 400000);
            await schedule();
            await storage.delete('typing:channel:55555555555555555');
            await storage.delete('typing:global-backoff');
            await schedule();
            await storage.delete('discord:oauth-state');
            await schedule();
            return Response.json({ observed });
          }
        }
        export default {
          fetch(request, env) {
            return env.PROBE.get(env.PROBE.idFromName(new URL(request.url).pathname)).fetch(request);
          },
        };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*'],
  });
  return new Miniflare({
    workers: [{
      config: {
        name: 'discord-dot-alarm-regression', compatibilityDate: '2026-10-04',
        compatibilityFlags: ['global_fetch_strictly_public'],
        manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
        exports: { AlarmProbe: { type: 'durable-object', storage: 'sqlite' } },
        env: { PROBE: { type: 'durable-object', worker: 'discord-dot-alarm-regression', exportName: 'AlarmProbe' } },
      },
      dev: { outboundService: { type: 'fetcher', handler: async () => { throw new Error('No external requests expected.'); } } },
    }],
  });
}

describe('actual SQLite Durable Object alarms in Workerd', () => {
  it('commits transactional alarm set/delete and rolls back alarm and data changes together', async () => {
    const runtime = await createRuntime();
    try {
      const response = await runtime.dispatchFetch('https://probe.invalid/transaction');
      expect(response.status).toBe(200);
      const result = await response.json() as { base: number; [key: string]: unknown };
      expect(result).toEqual({
        base: result.base,
        methods: { getAlarm: 'function', setAlarm: 'function', deleteAlarm: 'function', alarm: result.base + 600_000 },
        committedAlarm: result.base + 600_000,
        rolledBack: [
          { alarm: result.base + 600_000, marker: 'committed' },
          { alarm: result.base + 600_000, marker: 'committed' },
        ],
        deletedAlarm: null,
      });
    } finally { await runtime.dispose(); }
  }, 20_000);

  it('runs the unchanged scheduler across delivery, typing, Gateway, expiry and empty-state deadlines', async () => {
    const runtime = await createRuntime();
    try {
      const response = await runtime.dispatchFetch('https://probe.invalid/scheduler');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        // A global typing cooldown cannot postpone other work or the typing timeout.
        observed: [30_000, 60_000, 120_000, 180_000, 240_000, 300_000, 420_000, null],
      });
    } finally { await runtime.dispose(); }
  }, 20_000);
});
