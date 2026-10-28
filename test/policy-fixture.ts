import { createHash } from 'node:crypto';
import { BridgeStateDO } from '../src/bridge-state.js';
import { type PolicyControls, type PolicyRevision } from '../src/response-policy.js';

export const POLICY_OWNER = 'owner@example.test';
export const POLICY_TIME = '2026-10-11T00:00:00.000Z';
export class PolicyMemoryStorage {
  values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async transaction<T>(callback: (tx: PolicyMemoryStorage) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const tx = new PolicyMemoryStorage();
      tx.values = structuredClone(this.values);
      const value = await callback(tx);
      this.values = tx.values;
      return value;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
export function policyFixture(storage = new PolicyMemoryStorage()) {
  const bridge = new BridgeStateDO({ storage } as never, { ACCESS_OWNER_EMAIL: POLICY_OWNER }, { now: () => Date.parse(POLICY_TIME) });
  const controls: PolicyControls = {
    getResponsePolicy: (...args) => bridge.getResponsePolicy(...args),
    listResponsePolicyRevisions: (...args) => bridge.listResponsePolicyRevisions(...args),
    updateResponsePolicy: (...args) => bridge.updateResponsePolicy(...args),
    rollbackResponsePolicy: (...args) => bridge.rollbackResponsePolicy(...args),
  };
  return { storage, bridge, controls };
}
export function fixturePolicyRevision(): PolicyRevision & { configured: true } {
  const markdown = '# Example policy\n\nUse the approved test workflow.\n';
  return { configured: true, markdown, version: `sha256:${createHash('sha256').update(markdown).digest('hex')}`, revision: 1, updatedAt: POLICY_TIME, via: 'admin' };
}
export function seededPolicyFixture() {
  const storage = new PolicyMemoryStorage();
  const { configured: _configured, ...revision } = fixturePolicyRevision();
  storage.values.set('response-policy:current', revision);
  storage.values.set('response-policy:revision:1', revision);
  return policyFixture(storage);
}
