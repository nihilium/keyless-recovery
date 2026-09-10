import { createPublicClient, createWalletClient, http, getContract, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { recoveryModuleAbi, recoveryModuleAddress, VetoStateOrdinal } from "@nihilium-recovery/onchain-evm";
import { config } from "./config.js";

export const RECOVERY_MODULE_ADDRESS = recoveryModuleAddress(config.networkId) as Address;

export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(config.sepoliaRpcUrl),
});

const relayerAccount = privateKeyToAccount(config.relayerPrivateKey);
const guardianPauseAccount = privateKeyToAccount(config.guardianPauseKey);
const guardianAbortAccount = privateKeyToAccount(config.guardianAbortKey);
const guardianResumeAccount = privateKeyToAccount(config.guardianResumeKey);

export const relayerAddress = relayerAccount.address;
export const guardianAddresses = {
  pause: guardianPauseAccount.address,
  abort: guardianAbortAccount.address,
  resume: guardianResumeAccount.address,
};

const relayerWalletClient = createWalletClient({ account: relayerAccount, chain: sepolia, transport: http(config.sepoliaRpcUrl) });
const guardianPauseWalletClient = createWalletClient({ account: guardianPauseAccount, chain: sepolia, transport: http(config.sepoliaRpcUrl) });
const guardianAbortWalletClient = createWalletClient({ account: guardianAbortAccount, chain: sepolia, transport: http(config.sepoliaRpcUrl) });

export const relayerRecoveryModule = getContract({
  address: RECOVERY_MODULE_ADDRESS,
  abi: recoveryModuleAbi,
  client: { public: publicClient, wallet: relayerWalletClient },
});

export const guardianPauseRecoveryModule = getContract({
  address: RECOVERY_MODULE_ADDRESS,
  abi: recoveryModuleAbi,
  client: { public: publicClient, wallet: guardianPauseWalletClient },
});

export const guardianAbortRecoveryModule = getContract({
  address: RECOVERY_MODULE_ADDRESS,
  abi: recoveryModuleAbi,
  client: { public: publicClient, wallet: guardianAbortWalletClient },
});

// resume() needs a quorum signature over resumeDigest(), not just a plain call from the guardian's
// own address — see RecoveryModule.sol's `resume`. We use a 1-of-1 resume quorum for this demo (the
// resumeMembers array has one member: the resume guardian), so the guardian signs its own digest.
export { guardianResumeAccount };

export { VetoStateOrdinal };

export type GradualVetoConfig = {
  pauseAuthority: Address;
  abortAuthority: Address;
  resumeMembers: readonly Address[];
  resumeThreshold: number;
  timelockSeconds: bigint;
  pauseCeilingSeconds: bigint;
};

export const demoVetoConfig: GradualVetoConfig = {
  pauseAuthority: guardianAddresses.pause,
  abortAuthority: guardianAddresses.abort,
  resumeMembers: [guardianAddresses.resume],
  resumeThreshold: 1,
  timelockSeconds: config.timelockSeconds,
  pauseCeilingSeconds: config.pauseCeilingSeconds,
};
