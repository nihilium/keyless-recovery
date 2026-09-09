// "Remove" here can only ever mean "stop showing me this" — a completed recovery is a permanent
// on-chain event (RecoveryExecuted), so there's nothing to delete server-side. This is purely a
// per-browser, per-owner UI preference, kept in localStorage so it survives a reload but never
// hides the account from a different browser or a different signed-in identity.
import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

function storageKey(owner: Address): string {
  return `keyless-recovery:dismissed-accounts:${owner.toLowerCase()}`;
}

function readDismissed(owner: Address): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(list.map((a) => a.toLowerCase()));
  } catch {
    return new Set();
  }
}

function writeDismissed(owner: Address, dismissed: Set<string>) {
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify([...dismissed]));
  } catch {
    // Best-effort only — private browsing / storage-full shouldn't break the app.
  }
}

export function useDismissedAccounts(owner: Address | null) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDismissed(owner ? readDismissed(owner) : new Set());
  }, [owner]);

  const dismiss = useCallback(
    (account: Address) => {
      if (!owner) return;
      setDismissed((prev) => {
        const next = new Set(prev).add(account.toLowerCase());
        writeDismissed(owner, next);
        return next;
      });
    },
    [owner],
  );

  const restoreAll = useCallback(() => {
    if (!owner) return;
    setDismissed(new Set());
    writeDismissed(owner, new Set());
  }, [owner]);

  const isDismissed = useCallback((account: Address) => dismissed.has(account.toLowerCase()), [dismissed]);

  return { isDismissed, dismiss, restoreAll, dismissedCount: dismissed.size };
}
