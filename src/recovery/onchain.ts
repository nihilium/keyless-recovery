// On-chain reads, straight from the browser. Only *writes* need the relayer (they cost gas and the
// recovering user has none), so status polling, epoch/nonce lookup and intent hashing all happen
// client-side against a public RPC.
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { recoveryModuleAbi, recoveryModuleAddress, VetoStateOrdinal } from '@nihilium-recovery/onchain-evm';

const RPC_URL =
  (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ?? 'https://ethereum-sepolia-rpc.publicnode.com';

export const CHAIN_ID = 11155111;
export const RECOVERY_MODULE_ADDRESS = recoveryModuleAddress(CHAIN_ID) as Address;

export const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

export interface RecoveryIntent {
  account: Address;
  epoch: bigint;
  nonce: bigint;
  newValidator: Address;
  newValidatorInitData: Hex;
  expiry: number; // uint48
}

export async function readAccountConfig(account: Address) {
  const [recoveryOwner, epoch, nonce, veto] = await publicClient.readContract({
    address: RECOVERY_MODULE_ADDRESS,
    abi: recoveryModuleAbi,
    functionName: 'configOf',
    args: [account],
  });
  return { recoveryOwner, epoch, nonce, veto };
}

export function hashIntent(intent: RecoveryIntent): Promise<Hex> {
  return publicClient.readContract({
    address: RECOVERY_MODULE_ADDRESS,
    abi: recoveryModuleAbi,
    functionName: 'hashIntent',
    args: [intent],
  });
}

export function stateOf(account: Address): Promise<number> {
  return publicClient.readContract({
    address: RECOVERY_MODULE_ADDRESS,
    abi: recoveryModuleAbi,
    functionName: 'stateOf',
    args: [account],
  });
}

export async function remainingTimelockMs(account: Address): Promise<number> {
  const [, attempt] = await publicClient.readContract({
    address: RECOVERY_MODULE_ADDRESS,
    abi: recoveryModuleAbi,
    functionName: 'attemptOf',
    args: [account],
  });
  const { veto } = await readAccountConfig(account);
  const remaining = veto.timelockBlocks > attempt.accruedBlocks ? veto.timelockBlocks - attempt.accruedBlocks : 0n;
  // ~12s/block on Sepolia — an estimate for the countdown, not a guarantee.
  return Number(remaining) * 12_000;
}

export { VetoStateOrdinal };

export const VETO_STATE_LABELS: Record<number, string> = {
  0: 'none',
  1: 'initiated',
  2: 'paused',
  3: 'executable',
  4: 'executed',
  5: 'aborted',
};

export interface OnChainProtection {
  installed: boolean;
  recoveryOwner: Address;
  epoch: bigint;
  /** Current graduated-veto state of any recovery attempt on this account. */
  recoveryState: number;
}

/**
 * The durable truth about whether an account is protected. Component state doesn't survive a
 * reload (and a seal in this browser says nothing about what's on-chain), so the badge is derived
 * from the module itself.
 */
export async function readProtection(account: Address): Promise<OnChainProtection> {
  const [installed, config, recoveryState] = await Promise.all([
    publicClient.readContract({
      address: RECOVERY_MODULE_ADDRESS,
      abi: recoveryModuleAbi,
      functionName: 'isInitialized',
      args: [account],
    }),
    readAccountConfig(account),
    stateOf(account),
  ]);
  return { installed, recoveryOwner: config.recoveryOwner, epoch: config.epoch, recoveryState };
}

/** EXECUTED and ABORTED are terminal; anything else blocks a new initiateRecovery. */
export function isTerminalVetoState(state: number): boolean {
  return state === VetoStateOrdinal.EXECUTED || state === VetoStateOrdinal.ABORTED;
}

/**
 * The intent hash of the account's *current* attempt. The module keeps one attempt slot per
 * account, so this is how a client tells "the chain is describing my recovery" from "the chain is
 * describing an older one that hasn't been replaced yet".
 */
export async function currentAttemptIntentHash(account: Address): Promise<Hex> {
  const [intentHash] = await publicClient.readContract({
    address: RECOVERY_MODULE_ADDRESS,
    abi: recoveryModuleAbi,
    functionName: 'attemptOf',
    args: [account],
  });
  return intentHash;
}
