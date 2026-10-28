import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const authFixtureFiles = ['access.test.ts', 'mcp-auth.test.ts', 'oauth.test.ts'];

describe('authentication test identities', () => {
  it('uses a reserved synthetic owner address in each auth fixture', () => {
    for (const file of authFixtureFiles) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const owner = source.match(/const owner = '([^']+)'/)?.[1];
      expect(owner, file).toBe('owner@example.test');
    }
  });
});
