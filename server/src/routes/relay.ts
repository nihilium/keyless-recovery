// The backend is only a transaction relayer. The recovery ceremony (seal, the email round trip,
// unsealing, signing the intent) all happens in the browser — see
// src/recovery/providers/NihiliumRecoveryProvider.ts.
//
// What's left here is what a browser genuinely can't do: pay gas for a user who has none, and hold
// the three guardian keys, since pause/abort are msg.sender-gated on-chain.
import { Router } from "express";
import type { Address, Hex } from "viem";
import {
  relayerRecoveryModule,
  guardianPauseRecoveryModule,
  guardianAbortRecoveryModule,
  guardianResumeAccount,
  publicClient,
  RECOVERY_MODULE_ADDRESS,
  demoVetoConfig,
} from "../chain.js";
import { RECOVERY_VALIDATOR_ADDRESS } from "../kernelValidator.js";
import { logError, logInfo } from "../log.js";

export const relayRouter = Router();

const VETO_STATE_NAMES = ["none", "initiated", "paused", "executable", "executed", "aborted"] as const;

interface WireIntent {
  account: Address;
  epoch: string;
  nonce: string;
  newValidator: Address;
  newValidatorInitData: Hex;
  expiry: number;
}

/** bigints cross the wire as strings; the ABI needs them back as bigints. */
function toIntent(wire: WireIntent) {
  return {
    account: wire.account,
    epoch: BigInt(wire.epoch),
    nonce: BigInt(wire.nonce),
    newValidator: wire.newValidator,
    newValidatorInitData: wire.newValidatorInitData,
    expiry: Number(wire.expiry),
  };
}

/** Context worth having in the log whenever a call against an account fails (or succeeds). */
async function accountSnapshot(account: Address) {
  try {
    const [state, [intentHash], [recoveryOwner, epoch, nonce]] = await Promise.all([
      publicClient.readContract({
        address: RECOVERY_MODULE_ADDRESS, abi: relayerRecoveryModule.abi, functionName: "stateOf", args: [account],
      }),
      publicClient.readContract({
        address: RECOVERY_MODULE_ADDRESS, abi: relayerRecoveryModule.abi, functionName: "attemptOf", args: [account],
      }),
      publicClient.readContract({
        address: RECOVERY_MODULE_ADDRESS, abi: relayerRecoveryModule.abi, functionName: "configOf", args: [account],
      }),
    ]);
    return {
      state: VETO_STATE_NAMES[state] ?? String(state),
      attemptIntentHash: intentHash,
      recoveryOwner,
      epoch,
      nonce,
    };
  } catch {
    return { state: "unreadable" };
  }
}

// Public: addresses and the validator the browser needs to build an Intent. Nothing secret.
relayRouter.get("/config", (_req, res) => {
  res.json({
    recoveryModuleAddress: RECOVERY_MODULE_ADDRESS,
    recoveryValidator: RECOVERY_VALIDATOR_ADDRESS,
    pauseAuthority: demoVetoConfig.pauseAuthority,
    abortAuthority: demoVetoConfig.abortAuthority,
    resumeMembers: demoVetoConfig.resumeMembers,
    resumeThreshold: demoVetoConfig.resumeThreshold,
    timelockBlocks: demoVetoConfig.timelockBlocks.toString(),
    pauseCeilingBlocks: demoVetoConfig.pauseCeilingBlocks.toString(),
  });
});

relayRouter.post("/initiate", async (req, res) => {
  const { intent, signature } = req.body ?? {};
  if (!intent || !signature) {
    res.status(400).json({ error: "intent and signature are required." });
    return;
  }
  const account = intent.account as Address;
  logInfo("initiate", "request", {
    account,
    epoch: intent.epoch,
    nonce: intent.nonce,
    newValidator: intent.newValidator,
    before: (await accountSnapshot(account)).state,
  });
  try {
    // Authority is the signature, not the sender — the module checks it against the account's
    // registered recoveryOwner, so relaying grants us nothing.
    const txHash = await relayerRecoveryModule.write.initiateRecovery([toIntent(intent), signature]);
    logInfo("initiate", "submitted", { txHash });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const after = await accountSnapshot(account);
    logInfo("initiate", "mined", { status: receipt.status, block: receipt.blockNumber, state: after.state });
    res.json({ txHash, blockNumber: receipt.blockNumber.toString(), state: after.state });
  } catch (err) {
    logError("initiate", `account=${account}`, err);
    logInfo("initiate", "state at failure", await accountSnapshot(account));
    res.status(500).json({ error: (err as Error).message });
  }
});

relayRouter.post("/complete", async (req, res) => {
  const { intent } = req.body ?? {};
  if (!intent) {
    res.status(400).json({ error: "intent is required." });
    return;
  }
  const account = intent.account as Address;
  logInfo("complete", "request", { account, before: (await accountSnapshot(account)).state });
  try {
    const txHash = await relayerRecoveryModule.write.executeRecovery([toIntent(intent)]);
    logInfo("complete", "submitted", { txHash });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const after = await accountSnapshot(account);
    logInfo("complete", "mined", { status: receipt.status, block: receipt.blockNumber, state: after.state });
    res.json({ txHash, blockNumber: receipt.blockNumber.toString(), state: after.state });
  } catch (err) {
    logError("complete", `account=${account}`, err);
    logInfo("complete", "state at failure", await accountSnapshot(account));
    res.status(500).json({ error: (err as Error).message });
  }
});

/** pause and abort are msg.sender-gated, so each goes out from its own guardian wallet. */
function vetoHandler(
  action: "pause" | "abort",
  submit: (account: Address) => Promise<Hex>,
) {
  return async (req: import("express").Request, res: import("express").Response) => {
    const account = req.body?.account as Address;
    if (!account) {
      res.status(400).json({ error: "account is required." });
      return;
    }
    logInfo(action, "request", { account, before: (await accountSnapshot(account)).state });
    try {
      const txHash = await submit(account);
      logInfo(action, "submitted", { txHash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const after = await accountSnapshot(account);
      logInfo(action, "mined", { status: receipt.status, block: receipt.blockNumber, state: after.state });
      res.json({ txHash, blockNumber: receipt.blockNumber.toString(), state: after.state });
    } catch (err) {
      logError(action, `account=${account}`, err);
      logInfo(action, "state at failure", await accountSnapshot(account));
      res.status(500).json({ error: (err as Error).message });
    }
  };
}

relayRouter.post("/pause", vetoHandler("pause", (account) => guardianPauseRecoveryModule.write.pause([account])));
relayRouter.post("/abort", vetoHandler("abort", (account) => guardianAbortRecoveryModule.write.abort([account])));

// resume() is gated on a quorum *signature*, not the sender, so the relayer submits it carrying the
// resume guardian's signature over resumeDigest (a 1-of-1 quorum in this demo).
relayRouter.post("/resume", async (req, res) => {
  const account = req.body?.account as Address;
  if (!account) {
    res.status(400).json({ error: "account is required." });
    return;
  }
  logInfo("resume", "request", { account, before: (await accountSnapshot(account)).state });
  try {
    const [intentHash] = await publicClient.readContract({
      address: RECOVERY_MODULE_ADDRESS,
      abi: relayerRecoveryModule.abi,
      functionName: "attemptOf",
      args: [account],
    });
    const digest = await publicClient.readContract({
      address: RECOVERY_MODULE_ADDRESS,
      abi: relayerRecoveryModule.abi,
      functionName: "resumeDigest",
      args: [account, intentHash],
    });
    const signature = await guardianResumeAccount.sign({ hash: digest });
    logInfo("resume", "signed digest", { intentHash, signer: guardianResumeAccount.address });
    const txHash = await relayerRecoveryModule.write.resume([account, [guardianResumeAccount.address], [signature]]);
    logInfo("resume", "submitted", { txHash });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const after = await accountSnapshot(account);
    logInfo("resume", "mined", { status: receipt.status, block: receipt.blockNumber, state: after.state });
    res.json({ txHash, blockNumber: receipt.blockNumber.toString(), state: after.state });
  } catch (err) {
    logError("resume", `account=${account}`, err);
    logInfo("resume", "state at failure", await accountSnapshot(account));
    res.status(500).json({ error: (err as Error).message });
  }
});
