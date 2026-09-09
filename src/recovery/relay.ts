// The only thing still server-side: broadcasting transactions.
//
// Not because the logic needs a server — the ceremony, the signing and every read now happen in the
// browser — but because these calls cost gas that a just-recovered user doesn't have, and because
// pause/abort are `msg.sender`-gated to guardian keys that must not ship to a browser. The module is
// explicitly designed for this: "anyone may submit — the authority is the signature, not the sender."
import type { Address, Hex } from 'viem';
import type { RecoveryIntent } from './onchain';

const BACKEND_URL = (import.meta.env.VITE_RECOVERY_BACKEND_URL as string | undefined) ?? 'http://localhost:8787';

async function post(path: string, body: unknown): Promise<{ txHash: Hex }> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // bigints don't survive JSON.stringify
    body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json as { error?: string } | null)?.error ?? `${path} failed (${res.status}).`);
  return json as { txHash: Hex };
}

export interface RelayConfig {
  recoveryModuleAddress: Address;
  recoveryValidator: Address;
  pauseAuthority: Address;
  abortAuthority: Address;
  resumeMembers: Address[];
  resumeThreshold: number;
  timelockBlocks: string;
  pauseCeilingBlocks: string;
}

export async function fetchRelayConfig(): Promise<RelayConfig> {
  const res = await fetch(`${BACKEND_URL}/api/relay/config`);
  if (!res.ok) throw new Error('Could not reach the relayer. Is `npm run dev:server` running?');
  return res.json();
}

export function relayInitiate(intent: RecoveryIntent, signature: Hex) {
  return post('/api/relay/initiate', { intent, signature });
}

export function relayComplete(intent: RecoveryIntent) {
  return post('/api/relay/complete', { intent });
}

export function relayVeto(action: 'pause' | 'resume' | 'abort', account: Address) {
  return post(`/api/relay/${action}`, { account });
}
