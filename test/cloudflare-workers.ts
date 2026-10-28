/** Minimal Worker base-class stubs for Node-only unit tests. Runtime code uses Cloudflare's built-ins. */
export class WorkerEntrypoint<Env = unknown> {
  protected env: Env;
  protected ctx: unknown;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> {
  protected env: Env;
  protected ctx: unknown;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
