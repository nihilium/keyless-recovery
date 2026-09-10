// The on-chain half of "opt into recovery" for the real provider: install RecoveryModule as an
// executor on the user's own Kernel smart account, gated by the recoveryOwner the backend's seal()
// just produced. Only the account itself can install its own module, so this runs client-side via
// the live smart-wallet client — never the backend relayer (see plan.md).
import { encodeAbiParameters, encodeFunctionData, encodePacked, zeroAddress, type Address, type Hex } from 'viem';
import type { SmartWalletClientType } from '@privy-io/react-auth/smart-wallets';

const BACKEND_URL = (import.meta.env.VITE_RECOVERY_BACKEND_URL as string | undefined) ?? 'http://localhost:8787';

// Generic ERC-7579 account interface — not part of recovery-sdk's own ABI (that's RecoveryModule's
// ABI, not the account's), so declared locally.
const erc7579AccountAbi = [
  {
    type: 'function',
    name: 'installModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'initData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'uninstallModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'deInitData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const MODULE_TYPE_EXECUTOR = 2n;

// Mirrors `GradualVeto.Config` in recovery-sdk (onchain/evm/src/GradualVeto.sol). ABI encoding is
// positional, so a drift in field *order* or *type* here produces silently-wrong calldata rather
// than a compile error — and a drift in units does the same. That is exactly how the v1 -> v2 clock
// change bit: `timelock*` stayed a uint64 and kept encoding fine while its meaning went from blocks
// to wall-clock seconds. Any change to that struct must be mirrored here by hand.
const gradualVetoConfigAbiType = {
  type: 'tuple',
  components: [
    { name: 'pauseAuthority', type: 'address' },
    { name: 'abortAuthority', type: 'address' },
    { name: 'resumeMembers', type: 'address[]' },
    { name: 'resumeThreshold', type: 'uint8' },
    { name: 'timelockSeconds', type: 'uint64' },
    { name: 'pauseCeilingSeconds', type: 'uint64' },
  ],
} as const;

interface VetoConfigResponse {
  recoveryModuleAddress: Address;
  pauseAuthority: Address;
  abortAuthority: Address;
  resumeMembers: Address[];
  resumeThreshold: number;
  timelockSeconds: string;
  pauseCeilingSeconds: string;
}

export async function fetchVetoConfig(): Promise<VetoConfigResponse> {
  const res = await fetch(`${BACKEND_URL}/api/relay/config`);
  if (!res.ok) throw new Error('Could not reach the relayer. Is `npm run dev:server` running?');
  return res.json();
}

/**
 * Kernel does not forward `installModule`'s initData to the module untouched. For validators and
 * executors it reads:
 *
 *     hook (20 bytes, packed) ++ abi.encode(bytes installData, bytes hookData)
 *
 * where only `installData` reaches the module's `onInstall`. Passing the module's own init data
 * directly makes Kernel take its first 20 bytes as a hook address and misparse the rest, which
 * reverts during simulation with empty data — the notoriously unhelpful `reason: 0x`.
 *
 * `zeroAddress` here means "no hook", matching @rhinestone/module-sdk's Kernel encoder.
 *
 * Other ERC-7579 accounts (Nexus, Safe7579) take the module's init data as-is, so this wrapping is
 * applied only for Kernel.
 */
function wrapInitDataForKernel(moduleInitData: Hex): Hex {
  return encodePacked(
    ['address', 'bytes'],
    [zeroAddress, encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [moduleInitData, '0x'])],
  );
}

function buildInstallCalldata(config: VetoConfigResponse, recoveryOwner: Address, smartWalletType?: string): Hex {
  const moduleInitData = encodeAbiParameters(
    [{ type: 'address' }, gradualVetoConfigAbiType],
    [
      recoveryOwner,
      {
        pauseAuthority: config.pauseAuthority,
        abortAuthority: config.abortAuthority,
        resumeMembers: config.resumeMembers,
        resumeThreshold: config.resumeThreshold,
        timelockSeconds: BigInt(config.timelockSeconds),
        pauseCeilingSeconds: BigInt(config.pauseCeilingSeconds),
      },
    ],
  );

  const initData = smartWalletType === 'kernel' ? wrapInitDataForKernel(moduleInitData) : moduleInitData;

  return encodeFunctionData({
    abi: erc7579AccountAbi,
    functionName: 'installModule',
    args: [MODULE_TYPE_EXECUTOR, config.recoveryModuleAddress, initData],
  });
}

/** Kernel passes deInitData to the module untouched; RecoveryModule.onUninstall ignores it. */
function buildUninstallCalldata(config: VetoConfigResponse): Hex {
  return encodeFunctionData({
    abi: erc7579AccountAbi,
    functionName: 'uninstallModule',
    args: [MODULE_TYPE_EXECUTOR, config.recoveryModuleAddress, '0x'],
  });
}

export async function installRecoveryModule(
  client: SmartWalletClientType,
  smartAccount: Address,
  recoveryOwner: Address,
  smartWalletType?: string,
): Promise<Hex> {
  const config = await fetchVetoConfig();
  const data = buildInstallCalldata(config, recoveryOwner, smartWalletType);
  return client.sendTransaction({ to: smartAccount, data, value: 0n });
}

/**
 * Rotate the recovery key (and, with it, the guardian set).
 *
 * RecoveryModule has no setter: `onInstall` reverts with `AlreadyInstalled` if a config exists, and
 * `onUninstall` is what clears `recoveryOwner`, the veto config and any in-flight attempt. So
 * replacing means uninstall-then-install — sent as **one UserOp with two calls** so the account is
 * never left momentarily unprotected, and so a half-applied rotation can't strand it.
 *
 * The epoch deliberately survives uninstall (it's replay-protection state), so intents signed for
 * the old key stay invalid.
 */
export async function replaceRecoveryModule(
  client: SmartWalletClientType,
  smartAccount: Address,
  newRecoveryOwner: Address,
  smartWalletType?: string,
): Promise<Hex> {
  const config = await fetchVetoConfig();
  return client.sendTransaction({
    calls: [
      { to: smartAccount, value: 0n, data: buildUninstallCalldata(config) },
      { to: smartAccount, value: 0n, data: buildInstallCalldata(config, newRecoveryOwner, smartWalletType) },
    ],
  });
}
