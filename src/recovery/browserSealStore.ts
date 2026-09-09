// SealStore for the browser-run ceremony.
//
// The ceremony itself stays client-side; this only decides *where the resulting blob lives*. It
// writes through to the relayer's seal vault and reads from there, with IndexedDB as a local cache.
//
// Server-backed on purpose: a seal that only existed in this browser's IndexedDB would die with the
// device, and "recover onto a new device" — the entire point — would be impossible. The seal is a
// bearer artifact; holding it still gets you nothing without satisfying the identity gate and
// surviving the on-chain veto.
import type { SealBlob, SealStore, SealRef } from '@nihilium-recovery/core';

const BACKEND_URL = (import.meta.env.VITE_RECOVERY_BACKEND_URL as string | undefined) ?? 'http://localhost:8787';
const DB_NAME = 'keyless-recovery';
const STORE = 'seals';

interface StoredSeal {
  vaultId: string;
  storedAt: number;
  blob: SealBlob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'vaultId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

/** Extra context the vault needs to answer "is there a recovery for this email?" later. */
export interface SealPublishContext {
  email: string;
  userId: string;
  smartAccount: string;
  recoveryOwner: string;
  epoch: number;
}

export class BrowserSealStore implements SealStore {
  readonly domain = 'provider';
  /** Set by the provider immediately before seal(), since putSeal() only receives a vaultId. */
  publishContext: SealPublishContext | null = null;

  async putSeal(vaultId: string, blob: SealBlob): Promise<void> {
    await idb('readwrite', (store) =>
      store.put({ vaultId, storedAt: Math.floor(Date.now() / 1000), blob } satisfies StoredSeal),
    );

    const ctx = this.publishContext;
    if (!ctx) throw new Error('Seal publish context missing — cannot store the seal for recovery.');

    const res = await fetch(`${BACKEND_URL}/api/seals/${encodeURIComponent(vaultId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob, ...ctx }),
    });
    if (!res.ok) {
      // Loud, not silent: a seal that never reached the vault can't be recovered from another
      // device, and the user just paid for it.
      throw new Error(
        `The seal was created but could not be stored for recovery (${res.status}). Is the relayer running?`,
      );
    }
  }

  async getSeal(vaultId: string): Promise<SealBlob> {
    const res = await fetch(`${BACKEND_URL}/api/seals/${encodeURIComponent(vaultId)}`);
    if (res.ok) return ((await res.json()) as { blob: SealBlob }).blob;

    const cached = await idb<StoredSeal | undefined>('readonly', (store) => store.get(vaultId));
    if (!cached) throw new Error(`No seal available for vault "${vaultId}".`);
    return cached.blob;
  }

  async deleteSeal(vaultId: string): Promise<void> {
    await idb('readwrite', (store) => store.delete(vaultId));
  }

  async listSeals(): Promise<SealRef[]> {
    const records = await idb<StoredSeal[]>('readonly', (store) => store.getAll());
    return records.map(({ vaultId, storedAt }) => ({ vaultId, storedAt }));
  }
}

export async function lookupSealByEmail(email: string) {
  const res = await fetch(`${BACKEND_URL}/api/seals/lookup?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error('Could not reach the seal vault. Is `npm run dev:server` running?');
  return (await res.json()) as
    | { found: true; userId: string; vaultId: string; smartAccount: string; recoveryOwner: string; epoch?: number }
    | { found: false };
}
