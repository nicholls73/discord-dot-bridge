import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { BridgeStateDO } from './bridge-state.js';

export interface Env {
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  BRIDGE_STATE?: DurableObjectNamespace<BridgeStateDO>;
  MCP_ISSUER_URL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ADMIN_AUD?: string;
  ACCESS_OWNER_EMAIL?: string;
  ALLOW_LOCAL_AUTH?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_BOT_USER_ID?: string;
  DISCORD_OAUTH_CLIENT_SECRET?: string;
}

export interface BridgeAuthProps {
  email: string;
}
