import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useAppAuth, isPrivyConfigured } from '../auth/login';
import { createStub7702Adapter } from './stub7702';
import { useKernelSmartWallet } from './useKernelSmartWallet';
import type { DelegationStatus } from './SmartAccountAdapter';

export interface AppSmartAccount {
  loading: boolean;
  eoa: Address | null;
  smartAccount: Address | null;
  delegationStatus: DelegationStatus | null;
  /** The address to show as *the* account: the smart account when there is one, else the EOA. */
  address: Address | null;
  /**
   * Set when Privy is configured but never handed us a smart-wallet client. Almost always means
   * smart wallets are disabled (or the current chain isn't configured for them) in the Privy
   * Dashboard — without this the UI just span on "Setting up account…" forever with no error.
   */
  unavailableReason: string | null;
}

// Simulated "provisioning" latency so onboarding has something to show —
// there's no live 7702 bundler in this build (see plan.md non-goals), so
// setup is otherwise instantaneous.
const SETUP_DELAY_MS = 1100;

// How long to wait for Privy to hand over a smart-wallet client before calling it unavailable.
const SMART_WALLET_TIMEOUT_MS = 8000;

function useStubSmartAccount(): AppSmartAccount {
  const { user } = useAppAuth();
  const [state, setState] = useState<AppSmartAccount>({
    loading: true,
    eoa: null,
    smartAccount: null,
    delegationStatus: null,
    address: null,
    unavailableReason: null,
  });

  useEffect(() => {
    if (!user) {
      setState({
        loading: false,
        eoa: null,
        smartAccount: null,
        delegationStatus: null,
        address: null,
        unavailableReason: null,
      });
      return;
    }
    let cancelled = false;
    // Clear the previous account rather than spreading it forward: during a switch (the loss lab's
    // "new identity") a stale address on screen claims the old account is still yours.
    setState({
      loading: true,
      eoa: null,
      smartAccount: null,
      delegationStatus: null,
      address: null,
      unavailableReason: null,
    });
    const adapter = createStub7702Adapter(user.eoa);
    const timer = setTimeout(async () => {
      const [{ eoa, smartAccount }, delegationStatus] = await Promise.all([
        adapter.getAccount(),
        adapter.getDelegationStatus(),
      ]);
      if (!cancelled) {
        setState({ loading: false, eoa, smartAccount, delegationStatus, address: smartAccount, unavailableReason: null });
      }
    }, SETUP_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [user]);

  return state;
}

/** Real Kernel smart account, provisioned by Privy (Dashboard-configured — see README). */
function useRealSmartAccount(): AppSmartAccount {
  const { user } = useAppAuth();
  const { smartAccount } = useKernelSmartWallet();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!user || smartAccount) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), SMART_WALLET_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [user, smartAccount]);

  if (!user) {
    return {
      loading: false,
      eoa: null,
      smartAccount: null,
      delegationStatus: null,
      address: null,
      unavailableReason: null,
    };
  }

  if (smartAccount) {
    return {
      loading: false,
      eoa: user.eoa,
      smartAccount,
      delegationStatus: 'smart-wallet',
      address: smartAccount,
      unavailableReason: null,
    };
  }

  if (timedOut) {
    // Degrade to the EOA rather than spinning forever. On-chain recovery needs a real smart
    // account, so the UI surfaces this instead of quietly pretending everything is fine.
    return {
      loading: false,
      eoa: user.eoa,
      smartAccount: null,
      delegationStatus: 'eoa',
      address: user.eoa,
      unavailableReason:
        'Privy returned no smart wallet. Enable smart wallets (provider: Kernel) for Sepolia in the Privy Dashboard, including a bundler URL.',
    };
  }

  return {
    loading: true,
    eoa: user.eoa,
    smartAccount: null,
    delegationStatus: null,
    address: null,
    unavailableReason: null,
  };
}

/**
 * Resolves the account once. Call this exactly once, from SmartAccountProvider — everything else
 * reads the shared value through `useAppSmartAccount()`.
 */
export function useResolveSmartAccount(): AppSmartAccount {
  // isPrivyConfigured is fixed for the lifetime of the app (env var), so this conditional hook call
  // is stable across renders — same pattern as useAppAuth.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return isPrivyConfigured ? useRealSmartAccount() : useStubSmartAccount();
}
