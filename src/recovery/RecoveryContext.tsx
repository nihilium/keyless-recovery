// THE SWAP POINT. Exactly one RecoveryProvider is bound here, chosen by VITE_RECOVERY_PROVIDER
// ("fictive" — the default — or "nihilium"). Nothing else in the app imports a concrete provider.
//
// The provider and its capability flags are declared together on purpose: they have to move as a
// unit, and hand-editing them separately is how you end up offering World ID against a backend that
// only speaks email.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { RecoveryProvider } from './RecoveryProvider';
import { FictiveRecoveryProvider } from './providers/FictiveRecoveryProvider';
import { NihiliumRecoveryProvider } from './providers/NihiliumRecoveryProvider';

export interface RecoveryProviderCapabilities {
  /** Email is the only condition Nihilium supports; the fictive provider also does World ID. */
  worldId: boolean;
  /** Nihilium installs an ERC-7579 module, so it needs a real smart account. */
  requiresSmartAccount: boolean;
  /** Whether the graduated veto is real, on-chain state worth showing guardians for. */
  onChainVeto: boolean;
}

const MODE = (import.meta.env.VITE_RECOVERY_PROVIDER as string | undefined) ?? 'fictive';

export const RECOVERY_PROVIDER_MODE: 'fictive' | 'nihilium' = MODE === 'nihilium' ? 'nihilium' : 'fictive';

export const RECOVERY_PROVIDER_CAPABILITIES: RecoveryProviderCapabilities =
  RECOVERY_PROVIDER_MODE === 'nihilium'
    ? { worldId: false, requiresSmartAccount: true, onChainVeto: true }
    : { worldId: true, requiresSmartAccount: false, onChainVeto: false };

const RecoveryProviderContext = createContext<RecoveryProvider | null>(null);

export function RecoveryContextProvider({ children }: { children: ReactNode }) {
  // Created once: rebuilding it mid-recovery would swap the instance under useRecoverFunds (and
  // with it the in-flight ceremony's job map), restarting status polling against nothing.
  const provider = useMemo<RecoveryProvider>(
    () => (RECOVERY_PROVIDER_MODE === 'nihilium' ? new NihiliumRecoveryProvider() : new FictiveRecoveryProvider()),
    [],
  );
  return <RecoveryProviderContext.Provider value={provider}>{children}</RecoveryProviderContext.Provider>;
}

export function useRecoveryProvider(): RecoveryProvider {
  const provider = useContext(RecoveryProviderContext);
  if (!provider) throw new Error('useRecoveryProvider must be used within RecoveryContextProvider.');
  return provider;
}
