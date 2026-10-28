import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const preflight = workflow.match(/node -e '\n([\s\S]*?)\n          '\n        env:/)?.[1];
if (!preflight) throw new Error('Deployment preflight was not found.');
const settings = {
  TF_STATE_R2_ACCOUNT_ID: '00000000000000000000000000000000',
  TF_STATE_R2_BUCKET: 'example-private-state',
  CLOUDFLARE_ACCOUNT_ID: '11111111111111111111111111111111',
  DISCORD_BOT_USER_ID: '22222222222222222',
  ACCESS_OWNER_EMAIL: 'owner@example.test',
  WORKERS_DEV_SUBDOMAIN: 'example-team',
  ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com',
  ACCESS_IDENTITY_PROVIDER_ID: '00000000-0000-4000-8000-000000000000',
};

function runPreflight(overrides: Record<string, string | undefined> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'discord-dot-preflight-'));
  try {
    const result = spawnSync(process.execPath, ['-e', preflight!], {
      env: { ...settings, ...overrides, RUNNER_TEMP: directory }, encoding: 'utf8',
    });
    const path = join(directory, 'discord-dot-backend.hcl');
    return { ...result, backend: existsSync(path) ? readFileSync(path, 'utf8') : null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('deployment configuration preflight', () => {
  it.each(Object.keys(settings))('rejects a missing %s before writing backend configuration', (name) => {
    const result = runPreflight({ [name]: undefined });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Required production variable ${name} is missing`);
    expect(result.backend).toBeNull();
  });

  it('writes only backend settings when the deployment has its own identity', () => {
    const result = runPreflight();
    expect(result.status).toBe(0);
    expect(result.backend).toContain('bucket = "example-private-state"');
    expect(result.backend).toContain('https://00000000000000000000000000000000.r2.cloudflarestorage.com');
    expect(result.backend).not.toContain(settings.ACCESS_OWNER_EMAIL);
    expect(result.backend).not.toContain(settings.ACCESS_IDENTITY_PROVIDER_ID);
  });
});
