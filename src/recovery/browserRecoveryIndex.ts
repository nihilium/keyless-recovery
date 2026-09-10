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
  /**
   * The whole guardian set, ORDERED to match the seal's Shamir member indices (entry `i` is member
   * `i + 1`). Recovery needs this to offer "pick 2 of your 3" and to translate that pick back into
   * member indices — the seal itself deliberately records only each member's *domain*, since it
   * travels as a bearer artifact and must not disclose the guardians.
   */
  emails: string[];
  /** k — how many of `emails` a recovery must contact. */
  threshold: number;
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

/**
 * Index one entry under *every* one of its guardian emails, so a recovery can be started from any
 * of them. They all point at the same vaultId: a quorum is one seal, not n.
 */
export function putRecoveryIndexEntry(entry: RecoveryIndexEntry) {
  const index = load();
  for (const email of entry.emails) index[normalize(email)] = entry;
  try {
    localStorage.setItem(KEY, JSON.stringify(index));
  } catch {
    // ignore storage failures (private browsing)
  }
}

export function lookupRecoveryIndexEntry(email: string): RecoveryIndexEntry | null {
  return load()[normalize(email)] ?? null;
}

/**
 * The account's own guardian set, for the "you are protected by 2 of 3" panel.
 *
 * Keyed by account rather than email because that panel renders after a page reload, when the
 * component no longer knows which address was typed. Browser-local, so it answers only where the
 * account was set up — the on-chain module records one recovery key and nothing about the gate
 * behind it, by design.
 */
export function findRecoveryIndexEntryByAccount(smartAccount: string): RecoveryIndexEntry | null {
  const wanted = smartAccount.toLowerCase();
  for (const entry of Object.values(load())) {
    if (entry.smartAccount.toLowerCase() === wanted) return entry;
  }
  return null;
}
