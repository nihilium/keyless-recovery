import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see server/.env.example)`);
  return value;
}

// No Nihilium or Privy secrets here any more: the recovery ceremony runs in the browser, so this
// process only needs what it takes to broadcast transactions and hold the guardian keys.
export const config = {
  port: Number(process.env.PORT ?? 8787),
  networkId: Number(process.env.NETWORK_ID ?? 11155111),
  sepoliaRpcUrl: required("SEPOLIA_RPC_URL"),
  relayerPrivateKey: required("RELAYER_PRIVATE_KEY") as `0x${string}`,
  guardianPauseKey: required("GUARDIAN_PAUSE_KEY") as `0x${string}`,
  guardianAbortKey: required("GUARDIAN_ABORT_KEY") as `0x${string}`,
  guardianResumeKey: required("GUARDIAN_RESUME_KEY") as `0x${string}`,
  adminToken: required("ADMIN_TOKEN"),
  sealsDir: process.env.SEALS_DIR ?? "./seals",
  recoveryIndexFile: process.env.RECOVERY_INDEX_FILE ?? "./seals/recovery-index.json",
  /** RecoveryModule's Sepolia deployment block — the floor for event scans. */
  deploymentBlock: Number(process.env.DEPLOYMENT_BLOCK ?? 11652963),
  // Demo veto timing, in wall-clock seconds. Small on purpose for a live demo. These were 5 and 20
  // *blocks* against the v1 module; the defaults below preserve that wall-clock duration on Sepolia
  // (5 × ~12s, 20 × ~12s) rather than the bare numbers, which as seconds would have cut the demo
  // timelock from a minute to five seconds without any error.
  timelockSeconds: BigInt(process.env.TIMELOCK_SECONDS ?? 60),
  pauseCeilingSeconds: BigInt(process.env.PAUSE_CEILING_SECONDS ?? 240),
};
