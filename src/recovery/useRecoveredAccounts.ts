// Asks the backend "does this wallet control a recovered smart account?" — keyed on the connected
// wallet, answered from chain state.
//
// Deliberately not localStorage: a recovered owner should see their account from any browser or
// device, and remembering it client-side only works on the machine that ran the ceremony.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

const BACKEND_URL = (import.meta.env.VITE_RECOVERY_BACKEND_URL as string | undefined) ?? 'http://localhost:8787';

export interface RecoveredAccount {
  account: Address;
  owners: Address[];
  /** wei, as a string — bigints don't survive JSON */
  balance: string;
  epoch: string;
  recoveryValidator: Address;
  rootValidator: Address | null;
  /** True until the recovered validator has been promoted to root; both keys work in the meantime. */
  oldKeyStillValid: boolean;
}

export function useRecoveredAccounts(owner: Address | null | undefined) {
  const [accounts, setAccounts] = useState<RecoveredAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!owner) {
      setAccounts([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/accounts/by-owner?address=${owner}`);
      if (!res.ok) throw new Error('Could not reach the relayer to look up recovered accounts.');
      const body = (await res.json()) as { accounts: RecoveredAccount[] };
      setAccounts(body.accounts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { accounts, loading, error, refresh };
}
