import {
  unconfiguredPolicy, policyVersion, validatePolicyText, validateRevision,
  type PolicyHistory, type PolicyRevision, type PolicyState, type PolicyWriteResult,
} from './response-policy.js';

const CURRENT_KEY = 'response-policy:current';
const revisionKey = (revision: number) => `response-policy:revision:${revision}`;

/** Internal storage helper: all callers must pass the owner gate in BridgeStateDO. */
export class ResponsePolicyStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly now: () => number) {}

  async current(): Promise<PolicyState> {
    const current = await this.storage.get<PolicyRevision>(CURRENT_KEY);
    // Reads never seed or reset storage. Legacy revisions remain unchanged.
    return current ? { ...current, configured: true } : unconfiguredPolicy();
  }

  async history(beforeRevision?: number): Promise<PolicyHistory> {
    const current = await this.current();
    if (beforeRevision !== undefined) validateRevision(beforeRevision);
    const start = Math.min((beforeRevision ?? current.revision + 1) - 1, current.revision);
    const revisions: PolicyRevision[] = [];
    for (let revision = start; revision >= Math.max(1, start - 9); revision--) {
      const entry = await this.storage.get<PolicyRevision>(revisionKey(revision));
      if (!entry) throw new Error('Policy history is unavailable.');
      revisions.push(entry);
    }
    return { revisions, nextBeforeRevision: start > 10 ? start - 9 : null };
  }

  async update(expectedRevision: number, markdown: string, via: 'admin' | 'mcp', restoredFrom?: number): Promise<PolicyWriteResult> {
    validateRevision(expectedRevision, 0);
    if (via !== 'admin' && via !== 'mcp') throw new TypeError('Invalid policy management channel.');
    const text = validatePolicyText(markdown);
    const version = await policyVersion(text);
    return this.storage.transaction(async (tx) => {
      const current = await tx.get<PolicyRevision>(CURRENT_KEY);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedRevision) return { ok: false, reason: 'conflict', currentRevision };
      const policy: PolicyRevision = {
        revision: currentRevision + 1, markdown: text, version,
        updatedAt: new Date(this.now()).toISOString(), via,
        ...(restoredFrom === undefined ? {} : { restoredFrom }),
      };
      await tx.put(revisionKey(policy.revision), policy);
      await tx.put(CURRENT_KEY, policy);
      return { ok: true, policy: { ...policy, configured: true } };
    });
  }

  async rollback(expectedRevision: number, revision: number, via: 'admin' | 'mcp'): Promise<PolicyWriteResult> {
    validateRevision(expectedRevision, 0);
    validateRevision(revision);
    const current = await this.current();
    if (current.revision !== expectedRevision) return { ok: false, reason: 'conflict', currentRevision: current.revision };
    const target = await this.storage.get<PolicyRevision>(revisionKey(revision));
    if (!target) return { ok: false, reason: 'not_found', currentRevision: current.revision };
    return this.update(expectedRevision, target.markdown, via, revision);
  }
}
