// Operator view, read from the chain rather than from server memory.
//
// It reports two different things, and conflating them was a bug worth naming: the *current* state
// of each account (a live `stateOf` read) and the *history* of what happened (the module's events).
// An earlier version only queried RecoveryInitiated and kept the newest one per account, so a pause,
// a resume or an abort left no trace at all — and starting a second recovery erased the first one
// from the view entirely.
import { Router } from "express";
import { getAddress, parseAbiItem, type Address } from "viem";
import { recoveryModuleAbi } from "@nihilium-recovery/onchain-evm";
import { publicClient, RECOVERY_MODULE_ADDRESS } from "../chain.js";
import { config } from "../config.js";
import { requireAdminToken } from "../adminAuth.js";

export const adminRouter = Router();
adminRouter.use(requireAdminToken);

const VETO_STATE_NAMES = ["none", "initiated", "paused", "executable", "executed", "aborted"] as const;

/** Every event the module emits — the whole lifecycle, not just the start of it. */
const EVENT_SIGNATURES = {
  registered: "event RecoveryRegistered(address indexed account, address indexed recoveryOwner, uint256 epoch)",
  initiated: "event RecoveryInitiated(address indexed account, bytes32 indexed intentHash, uint256 epoch)",
  paused: "event RecoveryPaused(address indexed account, bytes32 indexed intentHash)",
  resumed: "event RecoveryResumed(address indexed account, bytes32 indexed intentHash)",
  aborted: "event RecoveryAborted(address indexed account, bytes32 indexed intentHash)",
  executed: "event RecoveryExecuted(address indexed account, bytes32 indexed intentHash, uint256 newEpoch)",
} as const;

type EventType = keyof typeof EVENT_SIGNATURES;

interface TimelineEvent {
  type: EventType;
  account: Address;
  intentHash?: string;
  recoveryOwner?: string;
  blockNumber: string;
  txHash: string;
  logIndex: number;
}

adminRouter.get("/recoveries", async (_req, res) => {
  try {
    const fromBlock = BigInt(config.deploymentBlock);

    const perType = await Promise.all(
      (Object.keys(EVENT_SIGNATURES) as EventType[]).map(async (type) => {
        const logs = await publicClient.getLogs({
          address: RECOVERY_MODULE_ADDRESS,
          event: parseAbiItem(EVENT_SIGNATURES[type]),
          fromBlock,
          toBlock: "latest",
        });
        return logs.map((log) => {
          const args = log.args as { account?: Address; intentHash?: string; recoveryOwner?: string };
          return {
            type,
            account: getAddress(args.account!),
            ...(args.intentHash ? { intentHash: args.intentHash } : {}),
            ...(args.recoveryOwner ? { recoveryOwner: args.recoveryOwner } : {}),
            blockNumber: log.blockNumber.toString(),
            txHash: log.transactionHash,
            logIndex: log.logIndex,
          } satisfies TimelineEvent;
        });
      }),
    );

    const events = perType
      .flat()
      .sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? b.logIndex - a.logIndex
          : Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)),
      );

    // Current state per account, straight from the module (projected, so a lapsed pause reads right).
    const accountAddresses = [...new Set(events.map((e) => e.account))];
    const accounts = await Promise.all(
      accountAddresses.map(async (account) => {
        const [state, config_] = await Promise.all([
          publicClient.readContract({
            address: RECOVERY_MODULE_ADDRESS, abi: recoveryModuleAbi, functionName: "stateOf", args: [account],
          }),
          publicClient.readContract({
            address: RECOVERY_MODULE_ADDRESS, abi: recoveryModuleAbi, functionName: "configOf", args: [account],
          }),
        ]);
        const [recoveryOwner, epoch] = config_;
        return {
          account,
          state: VETO_STATE_NAMES[state] ?? String(state),
          recoveryOwner,
          epoch: epoch.toString(),
          protected: recoveryOwner !== "0x0000000000000000000000000000000000000000",
        };
      }),
    );

    res.json({ accounts, events });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
