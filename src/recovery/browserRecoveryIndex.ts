// "Does a recovery exist for this email?" — recovery-sdk indexes seals by vaultId, not by condition
// input, so the lookup panel needs its own small index. Tiny and non-secret (it holds no key
// material), so localStorage is fine; the seal itself lives in IndexedDB.
import type { Address } from 'viem';

const KEY = 'keyless-recovery/index';

export interface RecoveryIndexEntry {
  userId: string;
  smartAccount: Address;
  vaultId: string;
  epoch: number;
  recoveryOwner: Address;
  registeredAt: number;
}

type IndexFile = Record<string, RecoveryIndexEntry>;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function load(): IndexFile {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as IndexFile) : {};
  } catch {
    return {};
  }
}

export function putRecoveryIndexEntry(email: string, entry: RecoveryIndexEntry) {
  const index = load();
  index[normalize(email)] = entry;
  try {
    localStorage.setItem(KEY, JSON.stringify(index));
  } catch {
    // ignore storage failures (private browsing)
  }
}

export function lookupRecoveryIndexEntry(email: string): RecoveryIndexEntry | null {
  return load()[normalize(email)] ?? null;
}
