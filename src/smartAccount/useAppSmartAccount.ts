import { useEffect, useState } from 'react';
import { getAddress, type Address } from 'viem';
import { useAppAuth, isPrivyConfigured } from '../auth/login';
import { createStub7702Adapter } from './stub7702';
import { useKernelSmartWallet } from './useKernelSmartWallet';
import type { DelegationStatus } from './SmartAccountAdapter';
import { RECOVERY_PROVIDER_CAPABILITIES } from '../recovery/RecoveryContext';
import { rootValidatorOf, OWNABLE_VALIDATOR_ADDRESS } from '../recovery/onchain';

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
  /**
   * True once this smart account's Kernel root validator has been promoted to OwnableValidator —
   * i.e. a recovery executed and "Revoke old key" ran. Privy derives this address from the
   * embedded-wallet key alone and never checks on-chain state, so it keeps presenting the account as
   * this session's to control forever; this is the one place in the app that actually asks the chain.
   *
   * `null` means "not applicable" (fictive mode, no smart account yet) or "not answered yet" — both
   * read the same as "not recovered away" everywhere this is consumed.
   */
  recoveredAway: boolean | null;
}

// Simulated "provisioning" latency so onboarding has something to show —
// there's no live 7702 bundler in this build (see plan.md non-goals), so
// setup is otherwise instantaneous.
const SETUP_DELAY_MS = 1100;

// How long to wait for Privy to hand over a smart-wallet client before calling it unavailable.
const SMART_WALLET_TIMEOUT_MS = 8000;

// How often to re-read the account's root validator. Cheap single-slot read; no need to be tighter.
const ROOT_VALIDATOR_POLL_MS = 12_000;

function useStubSmartAccount(): AppSmartAccount {
  const { user } = useAppAuth();
  const [state, setState] = useState<AppSmartAccount>({
    loading: true,
    eoa: null,
    smartAccount: null,
    delegationStatus: null,
    address: null,
    unavailableReason: null,
    recoveredAway: null,
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
        recoveredAway: null,
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
      recoveredAway: null,
    });
    const adapter = createStub7702Adapter(user.eoa);
    const timer = setTimeout(async () => {
      const [{ eoa, smartAccount }, delegationStatus] = await Promise.all([
        adapter.getAccount(),
        adapter.getDelegationStatus(),
      ]);
      if (!cancelled) {
        setState({
          loading: false,
          eoa,
          smartAccount,
          delegationStatus,
          address: smartAccount,
          unavailableReason: null,
          recoveredAway: null,
        });
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
  const [recoveredAway, setRecoveredAway] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user || smartAccount) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), SMART_WALLET_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [user, smartAccount]);

  // Independent of the timeout above: this is the one on-chain check in the whole Privy path,
  // asking "does the key this session is about to sign with still control the account", which
  // nothing else here ever does.
  useEffect(() => {
    if (!RECOVERY_PROVIDER_CAPABILITIES.onChainVeto || !smartAccount) {
      setRecoveredAway(null);
      return;
    }
    let cancelled = false;
    const check = () =>
      rootValidatorOf(smartAccount)
        .then((root) => {
          if (cancelled) return;
          setRecoveredAway(root !== null && getAddress(root) === getAddress(OWNABLE_VALIDATOR_ADDRESS));
        })
        .catch(() => !cancelled && setRecoveredAway(null));
    check();
    const timer = setInterval(check, ROOT_VALIDATOR_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [smartAccount]);

  if (!user) {
    return {
      loading: false,
      eoa: null,
      smartAccount: null,
      delegationStatus: null,
      address: null,
      unavailableReason: null,
      recoveredAway: null,
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
      recoveredAway,
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
      recoveredAway: null,
    };
  }

  return {
    loading: true,
    eoa: user.eoa,
    smartAccount: null,
    delegationStatus: null,
    address: null,
    unavailableReason: null,
    recoveredAway: null,
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
