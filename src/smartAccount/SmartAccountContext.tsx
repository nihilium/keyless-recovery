// One source of truth for "what account am I". Without this every component calling
// useAppSmartAccount() got its own state — its own provisioning timer in stub mode, its own
// timeout in Privy mode — so cards could disagree about whether an account existed yet, and any
// remount silently restarted provisioning.
import { createContext, useContext, type ReactNode } from 'react';
import { useResolveSmartAccount, type AppSmartAccount } from './useAppSmartAccount';

const SmartAccountContext = createContext<AppSmartAccount | null>(null);

export function SmartAccountProvider({ children }: { children: ReactNode }) {
  const value = useResolveSmartAccount();
  return <SmartAccountContext.Provider value={value}>{children}</SmartAccountContext.Provider>;
}

export function useAppSmartAccount(): AppSmartAccount {
  const value = useContext(SmartAccountContext);
  if (!value) throw new Error('useAppSmartAccount must be used within SmartAccountProvider.');
  return value;
}
