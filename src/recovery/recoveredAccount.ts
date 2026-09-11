// Controlling an account *after* recovery.
//
// executeRecovery installs OwnableValidator on the account with the recovered owner. That validator
// can validate UserOps, so the recovered owner drives the account by building a Kernel client
// pointed at the existing account address with OwnableValidator as the signing validator — no
// redeploy, no Privy smart-wallet involvement (Privy only provisions those for embedded wallets
// anyway, which is why an external EOA login gets none).
//
// At threshold 1, OwnableValidator's signature is a plain 65-byte ECDSA signature — the same shape
// Kernel's own ECDSA validator uses — so permissionless signs it correctly without custom code.
import {
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  http,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { concatHex, pad, toHex } from 'viem';
import { createSmartAccountClient } from 'permissionless';
import { toKernelSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
// Canonical in onchain.ts, not redefined here: the check that flags a Privy-derived account as
// recovered-away (AccountCard) needs the same address as the client that actually drives a
// recovered account (below), and two copies of the same magic address is how they'd drift.
import { OWNABLE_VALIDATOR_ADDRESS } from './onchain';

const RPC_URL =
  (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ?? 'https://ethereum-sepolia-rpc.publicnode.com';
// The same public Pimlico endpoint the Privy dashboard is configured with.
const BUNDLER_URL =
  (import.meta.env.VITE_BUNDLER_URL as string | undefined) ?? 'https://public.pimlico.io/v2/11155111/rpc';

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

const kernelAbi = [
  {
    type: 'function',
    name: 'changeRootValidator',
    inputs: [
      { name: '_rootValidator', type: 'bytes21' },
      { name: 'hook', type: 'address' },
      { name: 'validatorData', type: 'bytes' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

const entryPointAbi = [
  {
    type: 'function',
    name: 'getNonce',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'key', type: 'uint192' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/**
 * Kernel picks which validator checks a UserOp from the *nonce key*, laid out as
 * `mode(1) ++ validationType(1) ++ validator(20) ++ key(2)`.
 *
 * permissionless can't express this case: `getNonceKeyWithEncoding` hardcodes
 * `validationType = ROOT (0x00)`, because it assumes the validator you hand it is the account's
 * root validator. Ours isn't — recovery *installed* OwnableValidator alongside the existing root —
 * so a ROOT-typed nonce makes Kernel verify against the old Privy validator and reject the signature
 * with `AA24 signature error`. Type `0x01` (VALIDATOR) routes it to the installed validator instead.
 */
async function nonceForValidator(account: Address, validator: Address): Promise<bigint> {
  const key = BigInt(
    pad(concatHex(['0x00', '0x01', validator, toHex(0, { size: 2 })]), { size: 24 }),
  );
  return publicClient.readContract({
    address: entryPoint07Address,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [account, key],
  });
}

async function buildClient(account: Address, provider: EIP1193Provider) {
  const smartAccount = await toKernelSmartAccount({
    client: publicClient,
    version: '0.3.1',
    // The account already exists — don't derive a counterfactual one from the owner.
    address: account,
    owners: [provider],
    // Validate through the validator recovery installed, not Kernel's original root validator.
    validatorAddress: OWNABLE_VALIDATOR_ADDRESS,
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  // The bundler rejects a UserOp with no maxFeePerGas/maxPriorityFeePerGas — viem doesn't fill them
  // in on its own, and the failure surfaces confusingly as
  // `eth_estimateUserOperationGas does not exist` with a validation error underneath. Ask the
  // bundler for its own current prices; fall back to the chain's if that RPC isn't available.
  const pimlico = createPimlicoClient({ transport: http(BUNDLER_URL) });

  return createSmartAccountClient({
    account: smartAccount,
    chain: sepolia,
    bundlerTransport: http(BUNDLER_URL),
    userOperation: {
      estimateFeesPerGas: async () => {
        try {
          return (await pimlico.getUserOperationGasPrice()).fast;
        } catch {
          const fees = await publicClient.estimateFeesPerGas();
          return {
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          };
        }
      },
    },
  });
}

/** Send ETH (or an arbitrary call) from the recovered account. */
export async function sendFromRecoveredAccount(
  account: Address,
  provider: EIP1193Provider,
  { to, value, data }: { to: Address; value: bigint; data?: Hex },
): Promise<Hex> {
  return sendViaRecoveryValidator(account, provider, [{ to, value, data: data ?? '0x' }]);
}

/** Every call from a recovered account goes out under a VALIDATOR-typed nonce — see nonceForValidator. */
async function sendViaRecoveryValidator(
  account: Address,
  provider: EIP1193Provider,
  calls: { to: Address; value: bigint; data: Hex }[],
): Promise<Hex> {
  const client = await buildClient(account, provider);
  const nonce = await nonceForValidator(account, OWNABLE_VALIDATOR_ADDRESS);
  const userOpHash = await client.sendUserOperation({ calls, nonce });
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  return receipt.receipt.transactionHash;
}

/**
 * Revoke the pre-recovery key.
 *
 * Recovery *adds* a validator; it never removes the old one (the module says so explicitly — pulling
 * a module out of an ERC-7579 sentinel list needs a correct predecessor pointer and bricks the list
 * if it's wrong). On Kernel the superseded validator is the *root* validator, and uninstalling a root
 * validator reverts with `RootValidatorCannotBeRemoved()`. The supported move is to promote the
 * recovered validator to root instead, which is what actually takes the old key out of the picture.
 */
export async function promoteRecoveredValidatorToRoot(
  account: Address,
  provider: EIP1193Provider,
  newOwner: Address,
): Promise<Hex> {
  const validationId = encodePacked(['bytes1', 'address'], ['0x01', OWNABLE_VALIDATOR_ADDRESS]);
  const data = encodeFunctionData({
    abi: kernelAbi,
    functionName: 'changeRootValidator',
    // validatorData re-initialises the validator for its new role; hook 0 = no hook.
    args: [validationId, '0x0000000000000000000000000000000000000000', newOwner, '0x'],
  });
  return sendViaRecoveryValidator(account, provider, [{ to: account, value: 0n, data }]);
}
