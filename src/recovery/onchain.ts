// On-chain reads, straight from the browser. Only *writes* need the relayer (they cost gas and the
// recovering user has none), so status polling, epoch/nonce lookup and intent hashing all happen
// client-side against a public RPC.
import { createPublicClient, getAddress, http, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { recoveryModuleAbi, recoveryModuleAddress, VetoStateOrdinal } from '@nihilium/recovery-onchain-evm';

const RPC_URL =
  (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ?? 'https://ethereum-sepolia-rpc.publicnode.com';

export const CHAIN_ID = 11155111;
export const RECOVERY_MODULE_ADDRESS = recoveryModuleAddress(CHAIN_ID) as Address;

/**
 * Rhinestone's OwnableValidator — the validator RecoveryModule installs on a recovered account, with
 * the recovered owner as its sole owner. Same address on every chain it's deployed to (confirmed
 * live on Sepolia). Canonical here, not duplicated: recoveredAccount.ts uses it to drive a recovered
 * account, and rootValidatorOf() below uses it to detect that an account has been recovered away
 * from whatever key its *previous* controller (e.g. Privy) still assumes is root.
 */
export const OWNABLE_VALIDATOR_ADDRESS: Address = '0x2483DA3A338895199E5e538530213157e931Bf06';

export const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

const kernelAbi = [
  { type: 'function', name: 'rootValidator', inputs: [], outputs: [{ type: 'bytes21' }], stateMutability: 'view' },
] as const;

/** Kernel stores its root validator as `0x01 ++ address` (a one-byte validation type, then the validator). */
function validationIdToAddress(validationId: Hex): Address {
  return getAddress(`0x${validationId.slice(4)}`);
}

/**
 * The account's *current* Kernel root validator, read directly from the chain.
 *
 * This exists because nothing else answers it. Privy's smart-wallet client always assumes its own
 * embedded-wallet ECDSA validator is root — it derives the smart account address deterministically
 * from that key and has no way to ask "is that still true?", so it will keep offering transactions
 * through a key that recovery may have long since demoted. This is that ask, done independently.
 *
 * `null` for an undeployed (counterfactual) account, or if the read otherwise fails — absence of an
 * answer, not evidence that anything is wrong.
 */
export async function rootValidatorOf(account: Address): Promise<Address | null> {
  try {
    const validationId = await publicClient.readContract({
      address: account,
      abi: kernelAbi,
      functionName: 'rootValidator',
    });
    return validationIdToAddress(validationId);
  } catch {
    return null;
  }
}

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
  const remaining =
    veto.timelockSeconds > attempt.accruedSeconds ? veto.timelockSeconds - attempt.accruedSeconds : 0n;
  // The module's clock is wall-clock seconds, so this is exact rather than a per-chain estimate.
  return Number(remaining) * 1_000;
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
  /**
   * This account's own configured timelock, read from its installed veto config — not a demo-wide
   * default. Each account can be installed with a different value (see RecoveryCard), so this is
   * the only place that answers "what did *this* account's install actually set".
   */
  timelockSeconds: bigint;
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
  return {
    installed,
    recoveryOwner: config.recoveryOwner,
    epoch: config.epoch,
    timelockSeconds: config.veto.timelockSeconds,
    recoveryState,
  };
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
