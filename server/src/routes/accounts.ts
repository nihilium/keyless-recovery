// "I'm signed in with this wallet — does it control a recovered smart account?"
//
// Answered from the chain, not from browser storage. A recovered owner should see their account
// from any browser or device, which is the whole point of having recovered it; remembering it in
// localStorage only works on the machine that happened to run the ceremony.
//
// The anchor is RecoveryExecuted: every account that completed a recovery emits one, and the
// validator that recovery installed records who owns it. Cross-referencing the two answers the
// question without needing any off-chain record of who recovered what.
import { Router } from "express";
import { getAddress, parseAbiItem, type Address } from "viem";
import { recoveryModuleAbi } from "@nihilium/recovery-onchain-evm";
import { publicClient, RECOVERY_MODULE_ADDRESS } from "../chain.js";
import { RECOVERY_VALIDATOR_ADDRESS } from "../kernelValidator.js";
import { config } from "../config.js";
import { logError, logInfo } from "../log.js";

export const accountsRouter = Router();

const ownableValidatorAbi = [
  {
    type: "function",
    name: "getOwners",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
] as const;

const kernelAbi = [
  { type: "function", name: "rootValidator", inputs: [], outputs: [{ type: "bytes21" }], stateMutability: "view" },
] as const;

/** Kernel stores its root validator as `0x01 ++ address`. */
function validationIdToAddress(validationId: string): Address {
  return getAddress(`0x${validationId.slice(4)}`);
}

accountsRouter.get("/by-owner", async (req, res) => {
  const raw = String(req.query.address ?? "");
  let owner: Address;
  try {
    owner = getAddress(raw);
  } catch {
    res.status(400).json({ error: "A valid `address` query parameter is required." });
    return;
  }

  try {
    const executed = await publicClient.getLogs({
      address: RECOVERY_MODULE_ADDRESS,
      event: parseAbiItem(
        "event RecoveryExecuted(address indexed account, bytes32 indexed intentHash, uint256 newEpoch)",
      ),
      fromBlock: BigInt(config.deploymentBlock),
      toBlock: "latest",
    });

    const candidates = [...new Set(executed.map((log) => getAddress(log.args.account!)))];

    const accounts = (
      await Promise.all(
        candidates.map(async (account) => {
          const owners = (await publicClient
            .readContract({
              address: RECOVERY_VALIDATOR_ADDRESS,
              abi: ownableValidatorAbi,
              functionName: "getOwners",
              args: [account],
            })
            .catch(() => [])) as readonly Address[];

          if (!owners.some((o) => getAddress(o) === owner)) return null;

          const [balance, moduleConfig, rootValidatorId] = await Promise.all([
            publicClient.getBalance({ address: account }),
            publicClient.readContract({
              address: RECOVERY_MODULE_ADDRESS, abi: recoveryModuleAbi, functionName: "configOf", args: [account],
            }),
            publicClient
              .readContract({ address: account, abi: kernelAbi, functionName: "rootValidator" })
              .catch(() => null),
          ]);

          const rootValidator = rootValidatorId ? validationIdToAddress(rootValidatorId) : null;
          return {
            account,
            owners,
            balance: balance.toString(),
            epoch: moduleConfig[1].toString(),
            recoveryValidator: RECOVERY_VALIDATOR_ADDRESS,
            rootValidator,
            // Recovery adds a validator without removing the old one, so until the recovered
            // validator *is* the root, the pre-recovery key still controls the account.
            oldKeyStillValid: rootValidator !== null && rootValidator !== getAddress(RECOVERY_VALIDATOR_ADDRESS),
          };
        }),
      )
    ).filter((a): a is NonNullable<typeof a> => a !== null);

    logInfo("accounts", "by-owner", { owner, recoveredAccounts: accounts.length });
    res.json({ owner, accounts });
  } catch (err) {
    logError("accounts", `by-owner owner=${owner}`, err);
    res.status(500).json({ error: (err as Error).message });
  }
});
