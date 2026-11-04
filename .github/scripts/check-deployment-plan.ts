import { readFileSync } from 'node:fs';

type Binding = { name: string; type: string; [key: string]: unknown };
type State = { id?: string; account_id?: string; script_name?: string; migrations?: unknown; bindings?: Binding[] };
type Resource = { mode: string; address: string; change: { actions: string[]; before: State | null; after: State | null } };
type Plan = { errored?: boolean; resource_changes?: Resource[] };

try {
  let plan: Plan;
  try { plan = JSON.parse(readFileSync(0, 'utf8')); }
  catch { throw new Error('Terraform plan JSON is invalid.'); }
  if (plan.errored || !Array.isArray(plan.resource_changes)) throw new Error('Terraform plan is incomplete.');
  const resources = plan.resource_changes.filter((resource) => resource.mode === 'managed');
  for (const resource of resources) {
    const actions = resource.change?.actions;
    if (!Array.isArray(actions) || actions.length !== 1 || !['no-op', 'update'].includes(actions[0])) {
      throw new Error('Resource creation, deletion or replacement requires a separate migration.');
    }
  }
  const worker = resources.find((resource) => resource.address === 'cloudflare_workers_script.discord_dot')?.change;
  const oauth = resources.find((resource) => resource.address === 'cloudflare_workers_kv_namespace.oauth')?.change;
  if (!worker?.before || !worker.after || !oauth?.before || !oauth.after) throw new Error('Existing Worker and OAuth storage are required.');
  for (const field of ['account_id', 'script_name'] as const) {
    if (!worker.before[field] || worker.before[field] !== worker.after[field]) throw new Error('Worker identity must remain unchanged.');
  }
  if (!oauth.before.id || oauth.before.id !== oauth.after.id) throw new Error('OAuth storage must remain unchanged.');
  if (worker.after.migrations != null) throw new Error('Do not replay Durable Object migrations during an update.');
  for (const [name, fields] of [
    ['OAUTH_KV', ['namespace_id']],
    ['BRIDGE_STATE', ['class_name', 'script_name']],
    ['MCP_ISSUER_URL', ['text']],
    ['DISCORD_BOT_USER_ID', ['text']],
  ] as const) {
    const before = worker.before.bindings?.find((binding) => binding.name === name);
    const after = worker.after.bindings?.find((binding) => binding.name === name);
    if (!before || !after || before.type !== after.type || fields.some((field) => (before[field] ?? null) !== (after[field] ?? null))) {
      throw new Error('Bot, endpoint and storage bindings must remain unchanged.');
    }
  }
  console.log(`Plan verified: ${resources.filter((resource) => resource.change.actions[0] === 'update').length} updates; existing bot and storage preserved.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment plan verification failed.');
  process.exitCode = 1;
}
