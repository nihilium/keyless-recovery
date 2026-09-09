// Only used when Privy is configured — the smart-wallet client, both for display (via
// useAppSmartAccount) and for sending the "install recovery module" UserOp (see RecoveryCard),
// which needs the raw client, not just the narrow SmartAccountAdapter shape.
import { usePrivy } from '@privy-io/react-auth';
import { useSmartWallets } from '@privy-io/react-auth/smart-wallets';
import type { Address } from 'viem';

/**
 * Privy smart-wallet types that are actually ERC-7579 modular accounts, i.e. the ones that expose
 * `installModule` and can therefore host the recovery module.
 *
 * `light_account` (Alchemy), `coinbase_smart_wallet`, `biconomy` (v2) and `thirdweb` are not — they
 * have no `installModule`, so the call reverts with empty data ("reason: 0x") during simulation.
 * `safe` only qualifies via the Safe7579 adapter, which isn't verifiable from the client, so it's
 * treated as unsupported here rather than failing later on-chain.
 */
const ERC7579_WALLET_TYPES = ['kernel', 'nexus'] as const;

export function useKernelSmartWallet() {
  const { client } = useSmartWallets();
  const { user } = usePrivy();
  const smartAccount = client?.account.address as Address | undefined;
  const smartWalletType = user?.smartWallet?.smartWalletType;
  const supportsModules =
    smartWalletType === undefined || (ERC7579_WALLET_TYPES as readonly string[]).includes(smartWalletType);

  return { client, smartAccount, smartWalletType, supportsModules };
}
