import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../.github/scripts/check-deployment-plan.ts', import.meta.url));
function fixture() {
  const worker = {
    account_id: 'example-account', script_name: 'discord-dot', migrations: null,
    bindings: [
      { name: 'OAUTH_KV', type: 'kv_namespace', namespace_id: 'existing-oauth' },
      { name: 'BRIDGE_STATE', type: 'durable_object_namespace', class_name: 'BridgeStateDO', script_name: null },
      { name: 'MCP_ISSUER_URL', type: 'plain_text', text: 'https://discord-dot.example.test' },
      { name: 'DISCORD_BOT_USER_ID', type: 'plain_text', text: '10000000000000001' },
    ],
    content_sha256: 'old-bundle',
  };
  return { resource_changes: [
    { mode: 'managed', address: 'cloudflare_workers_script.discord_dot', type: 'cloudflare_workers_script',
      change: { actions: ['update'], before: worker, after: { ...structuredClone(worker), content_sha256: 'new-bundle' } } },
    { mode: 'managed', address: 'cloudflare_workers_kv_namespace.oauth', type: 'cloudflare_workers_kv_namespace',
      change: { actions: ['no-op'], before: { id: 'existing-oauth' }, after: { id: 'existing-oauth' } } },
  ] };
}
function run(plan: unknown) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(plan), encoding: 'utf8' });
}
describe('existing-installation deployment plan', () => {
  it('allows a bundle update preserving the bot, endpoints and storage', () => {
    expect(run(fixture()).status).toBe(0);
  });
  it.each([['create'], ['delete'], ['delete', 'create']])('rejects resource lifecycle action %j', (...actions) => {
    const plan = fixture();
    plan.resource_changes[0]!.change.actions = actions;
    expect(run(plan).status).not.toBe(0);
  });
  it.each(['account_id', 'script_name'])('rejects a changed Worker %s', (key) => {
    const plan = fixture();
    (plan.resource_changes[0]!.change.after as Record<string, unknown>)[key] = 'different';
    expect(run(plan).status).not.toBe(0);
  });
  it.each([[0, 'namespace_id'], [1, 'class_name'], [2, 'text'], [3, 'text']] as const)('rejects a changed binding %i %s', (index, field) => {
    const plan = fixture();
    const after = plan.resource_changes[0]!.change.after as ReturnType<typeof fixture>['resource_changes'][0]['change']['before'];
    if ('bindings' in after) (after.bindings[index] as Record<string, unknown>)[field] = 'different';
    expect(run(plan).status).not.toBe(0);
  });
  it('rejects replaying bootstrap migrations', () => {
    const plan = fixture();
    (plan.resource_changes[0]!.change.after as Record<string, unknown>).migrations = { new_tag: 'v1', new_sqlite_classes: ['BridgeStateDO'] };
    expect(run(plan).status).not.toBe(0);
  });
  it('rejects incomplete plans and hides malformed input', () => {
    expect(run({}).status).not.toBe(0);
    const result = spawnSync(process.execPath, [script], { input: '{"secret":"private-value"', encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('private-value');
  });
});
