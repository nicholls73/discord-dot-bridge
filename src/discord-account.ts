import { isDiscordSnowflake } from './policy.js';

export interface DiscordGuildCandidate {
  guildId: string;
  name: string;
}

export interface DiscordRoleOption {
  roleId: string;
  name: string;
}

export interface LinkedDiscordAccount {
  userId: string;
  displayName: string;
  linkedAt: number;
  candidates: DiscordGuildCandidate[];
  candidatesExpireAt: number;
}

export function isLinkedDiscordAccount(value: unknown): value is LinkedDiscordAccount {
  if (!isRecord(value) || !isDiscordSnowflake(value.userId) ||
      typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 128 ||
      typeof value.linkedAt !== 'number' || !Number.isFinite(value.linkedAt) ||
      typeof value.candidatesExpireAt !== 'number' || !Number.isFinite(value.candidatesExpireAt) ||
      !Array.isArray(value.candidates) || value.candidates.length > 200) return false;
  return value.candidates.every((candidate) => isRecord(candidate) &&
    isDiscordSnowflake(candidate.guildId) && typeof candidate.name === 'string' &&
    candidate.name.length >= 1 && candidate.name.length <= 100) &&
    new Set(value.candidates.map((candidate) => candidate.guildId)).size === value.candidates.length;
}

export function managedGuildCandidates(value: unknown): DiscordGuildCandidate[] {
  if (!Array.isArray(value) || value.length > 200) throw new TypeError('Discord returned an invalid server list.');
  const candidates = new Map<string, DiscordGuildCandidate>();
  for (const item of value) {
    if (!isRecord(item) || !isDiscordSnowflake(item.id) || typeof item.name !== 'string' ||
        item.name.length < 1 || item.name.length > 100) continue;
    const canManage = item.owner === true || hasGuildManagementPermission(item.permissions);
    if (canManage) candidates.set(item.id, { guildId: item.id, name: item.name });
  }
  return [...candidates.values()].sort((left, right) => left.name.localeCompare(right.name) || left.guildId.localeCompare(right.guildId));
}

export function selectableDiscordRoles(value: unknown, guildId: string): DiscordRoleOption[] {
  if (!isDiscordSnowflake(guildId) || !Array.isArray(value) || value.length > 500) {
    throw new TypeError('Discord returned an invalid role list.');
  }
  const roles = new Map<string, DiscordRoleOption>();
  for (const item of value) {
    if (!isRecord(item) || !isDiscordSnowflake(item.id) || typeof item.name !== 'string' ||
        item.name.length < 1 || item.name.length > 100) continue;
    if (item.id === guildId || item.name.toLowerCase() === '@everyone') continue;
    roles.set(item.id, { roleId: item.id, name: item.name });
  }
  return [...roles.values()].sort((left, right) => left.name.localeCompare(right.name) || left.roleId.localeCompare(right.roleId));
}

function hasGuildManagementPermission(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
  try {
    const permissions = BigInt(value);
    return (permissions & (0x8n | 0x20n)) !== 0n;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
