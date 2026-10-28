import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const terraformResources = readFileSync(
  fileURLToPath(new URL('../terraform/resources.tf', import.meta.url)),
  'utf8',
);

describe('production Durable Object migration configuration', () => {
  it('keeps the existing SQLite class binding without replaying a migration on Worker updates', () => {
    const bridgeStateBindings = [
      ...terraformResources.matchAll(/\{\s*name\s*=\s*"BRIDGE_STATE"[^{}]*\}/g),
    ].map(([binding]) => binding);

    expect(bridgeStateBindings).toHaveLength(1);
    expect(bridgeStateBindings[0]).toMatch(/type\s*=\s*"durable_object_namespace"/);
    expect(bridgeStateBindings[0]).toMatch(/class_name\s*=\s*"BridgeStateDO"/);
    expect(terraformResources).not.toMatch(/^\s*migrations\s*=/m);
  });

  it('keeps first-install registration in an inactive, locally enabled template', () => {
    const template = readFileSync(new URL('../terraform/bootstrap_override.tf.example', import.meta.url), 'utf8');
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(template).toMatch(/resource "cloudflare_workers_script" "discord_dot"/);
    expect(template).toMatch(/new_tag\s*=\s*"v1"/);
    expect(template).toMatch(/new_sqlite_classes\s*=\s*\["BridgeStateDO"\]/);
    expect(template).not.toMatch(/old_tag|deleted_classes|renamed_classes|transferred_classes/);
    expect(ignore).toContain('terraform/*_override.tf');
  });
});
