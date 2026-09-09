// Fallback SmartAccountAdapter used whenever a live 7702 bundler isn't
// configured (always, in this build — see plan.md non-goals). Derives a
// deterministic, fake "smart account" address from the EOA so the UI has a
// stable second address to display, without ever touching a real bundler.
import { keccak256, toBytes, getAddress, type Address } from 'viem';
import type { SmartAccountAdapter, DelegationStatus } from './SmartAccountAdapter';

export function deriveStubSmartAccount(eoa: Address): Address {
  const hash = keccak256(toBytes(`stub-smart-account:${eoa.toLowerCase()}`));
  // Last 20 bytes of the hash, as an address.
  return getAddress(`0x${hash.slice(-40)}`);
}

export function createStub7702Adapter(eoa: Address): SmartAccountAdapter {
  const smartAccount = deriveStubSmartAccount(eoa);
  return {
    async getAccount() {
      return { eoa, smartAccount };
    },
    async getDelegationStatus(): Promise<DelegationStatus> {
      return 'stub';
    },
  };
}
