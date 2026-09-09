// Account seam — drives the delegation badge. Kept separate from
// RecoveryProvider because "what is my account/delegation state" and "how do
// I recover it" are different concerns with different lifecycles.
import type { Address } from 'viem';

export type DelegationStatus = 'eoa' | '7702-delegated' | 'smart-wallet' | 'stub';

export interface SmartAccountAdapter {
  getAccount(): Promise<{ eoa: Address; smartAccount: Address }>;
  getDelegationStatus(): Promise<DelegationStatus>;
}
