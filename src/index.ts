import { BridgeStateDO } from './bridge-state.js';
import type { Env } from './types.js';
import { fetchWorker } from './worker.js';

export { BridgeStateDO };
export { fetchWorker };

export default {
  fetch: fetchWorker,
} satisfies ExportedHandler<Env>;
