import { describe, expect, it } from 'vitest';
import { fetchWorker } from '../src/worker.js';

const context = {} as ExecutionContext;
const issuer = 'https://discord-dot.example.test';
const guildId = '10000000000000001';
const userId = '10000000000000002';
const roleId = '10000000000000003';

interface RuntimeGrantState {
  guilds: Record<string, { userIds: string[]; roleIds: string[] }>;
}

type RuntimeMutation =
  | { action: 'approve-server'; guildId: string }
  | { action: 'grant-user' | 'grant-role'; guildId: string; id: string };

interface RuntimePolicyContract {
  emptyDiscordAuthorization?: () => RuntimeGrantState;
  applyAuthorizationMutation?: (state: RuntimeGrantState, mutation: RuntimeMutation) => RuntimeGrantState;
  hasDiscordAccess?: (state: RuntimeGrantState, guildId: string, userId: string, currentRoleIds: readonly string[]) => boolean;
}

describe('production runtime compatibility gate', () => {
  it('has a deny-by-default server, user, and role authorization policy', async () => {
    const policy = await import('../src/policy.js') as unknown as RuntimePolicyContract;
    expect(policy.emptyDiscordAuthorization).toBeTypeOf('function');
    expect(policy.applyAuthorizationMutation).toBeTypeOf('function');
    expect(policy.hasDiscordAccess).toBeTypeOf('function');
    if (!policy.emptyDiscordAuthorization || !policy.applyAuthorizationMutation || !policy.hasDiscordAccess) return;

    const empty = policy.emptyDiscordAuthorization();
    expect(empty).toEqual({ guilds: {} });
    expect(policy.hasDiscordAccess(empty, guildId, userId, [roleId])).toBe(false);

    const approved = policy.applyAuthorizationMutation(empty, { action: 'approve-server', guildId });
    const roleGranted = policy.applyAuthorizationMutation(approved, { action: 'grant-role', guildId, id: roleId });
    expect(policy.hasDiscordAccess(roleGranted, guildId, userId, [roleId])).toBe(true);
    expect(policy.hasDiscordAccess(roleGranted, guildId, userId, [])).toBe(false);

    const userGranted = policy.applyAuthorizationMutation(approved, { action: 'grant-user', guildId, id: userId });
    expect(policy.hasDiscordAccess(userGranted, guildId, userId, [])).toBe(true);
  });

  it('routes /admin through the owner authentication gate instead of returning 404', async () => {
    const response = await fetchWorker(new Request(`${issuer}/admin`), {}, context);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Owner authentication required');
  });
});
