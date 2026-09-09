// Durable seal storage.
//
// The ceremony still runs entirely in the browser — this endpoint never seals, never unseals and
// never sees a key. It stores the resulting blob so recovery works from a *different* browser,
// which is the whole point: if the seal only lived in IndexedDB, losing the device would lose the
// seal, and "recover from a new device" would be impossible to demo (or to mean anything).
//
// The seal is a bearer artifact — whoever holds it can attempt a recovery, still subject to the
// identity gate and the on-chain veto. This is the spec's "storage/provider" placement.
import { Router } from "express";
import { LocalSealStore } from "@nihilium-recovery/storage-local";
import type { SealBlob } from "@nihilium-recovery/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

export const sealsRouter = Router();

const sealStore = new LocalSealStore({ directory: config.sealsDir });

interface IndexEntry {
  userId: string;
  vaultId: string;
  smartAccount: string;
  recoveryOwner: string;
  /** KDF input: a completed recovery bumps it on-chain, so the seal records which one it used. */
  epoch: number;
  registeredAt: number;
}

function loadIndex(): Record<string, IndexEntry> {
  if (!existsSync(config.recoveryIndexFile)) return {};
  return JSON.parse(readFileSync(config.recoveryIndexFile, "utf8"));
}

function saveIndex(index: Record<string, IndexEntry>) {
  mkdirSync(dirname(config.recoveryIndexFile), { recursive: true });
  writeFileSync(config.recoveryIndexFile, JSON.stringify(index, null, 2), "utf8");
}

const normalize = (email: string) => email.trim().toLowerCase();

/** Store the seal produced by the browser, plus the email -> account index recovery looks up by. */
sealsRouter.put("/:vaultId", async (req, res) => {
  const { vaultId } = req.params;
  const { blob, email, userId, smartAccount, recoveryOwner, epoch } = req.body ?? {};
  if (!vaultId || !blob || !email || !smartAccount || !recoveryOwner) {
    res.status(400).json({ error: "vaultId, blob, email, smartAccount and recoveryOwner are required." });
    return;
  }
  try {
    await sealStore.putSeal(vaultId, blob as SealBlob);
    const index = loadIndex();
    index[normalize(email)] = {
      userId: userId ?? vaultId,
      vaultId,
      smartAccount,
      recoveryOwner,
      epoch: Number(epoch ?? 0),
      registeredAt: Date.now(),
    };
    saveIndex(index);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** "Is there a recovery for this email?" — drives the lookup panel from any browser. */
sealsRouter.get("/lookup", (req, res) => {
  const email = String(req.query.email ?? "");
  if (!email) {
    res.status(400).json({ error: "email is required." });
    return;
  }
  const entry = loadIndex()[normalize(email)];
  res.json(entry ? { found: true, ...entry } : { found: false });
});

sealsRouter.get("/:vaultId", async (req, res) => {
  try {
    const blob = await sealStore.getSeal(req.params.vaultId!);
    res.json({ blob });
  } catch {
    res.status(404).json({ error: "No seal stored for that vault." });
  }
});
