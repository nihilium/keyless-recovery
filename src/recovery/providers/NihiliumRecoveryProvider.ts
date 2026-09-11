// The real provider. The whole recovery procedure — sealing, the human-in-the-loop email ceremony,
// unsealing, and signing the on-chain intent — runs **in this browser**, exactly like the
// forgot-my-password-ui reference app. Nothing about the ceremony touches a server.
//
// The one exception is broadcasting transactions (see relay.ts): those cost gas a just-recovered
// user doesn't have, and pause/abort are msg.sender-gated to guardian keys that must never ship to
// a browser. Reads, signing and every ZK step happen here.
import { RecoverySDK, generateRRS } from '@nihilium/recovery-core';
import { EvmKeyAdapter, toEvmAddress } from '@nihilium/recovery-key-evm';
import { ZKEmailConditionAdapter, type ZKEmailPhase } from '@nihilium/recovery-condition-zkemail';
import {
  quorumOf,
  QuorumIncompleteError,
  type QuorumConditionAdapter,
  type QuorumMember,
} from '@nihilium/recovery-condition-quorum';
import { NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE, setApiEndpoint } from '@nihilium/recovery-nihilium';
import { hexToBytes, bytesToHex, type Address, type Hex } from 'viem';
import type {
  RecoveryProvider,
  RecoveryRecord,
  RecoveryRegistration,
  RecoveryHandle,
  RecoveryStatus,
  RecoveryCondition,
  ConditionInput,
  ConditionProof,
  AuthorityRef,
  AccountRef,
} from '../RecoveryProvider';
import { BrowserSealStore, lookupSealByEmail } from '../browserSealStore';
import { lookupRecoveryIndexEntry, putRecoveryIndexEntry } from '../browserRecoveryIndex';
import { findDuplicateEmail, normalizeEmail } from '../conditions/EmailCondition';
import { CHAIN_ID, VetoStateOrdinal, VETO_STATE_LABELS, currentAttemptIntentHash, hashIntent, isTerminalVetoState, readAccountConfig, readProtection, remainingTimelockMs, stateOf, type RecoveryIntent } from '../onchain';
import { fetchRelayConfig, relayComplete, relayInitiate, relayVeto } from '../relay';
import { recoveryValidatorInitData } from '../recoveryValidator';

const API_URL = (import.meta.env.VITE_NIHILIUM_API_URL as string | undefined) ?? 'https://api.nihilium.io';
const EMAIL_SERVICE_URL =
  (import.meta.env.VITE_NIHILIUM_EMAIL_SERVICE_URL as string | undefined) ?? 'https://zkemail.nihilium.io';
const API_KEY = import.meta.env.VITE_NIHILIUM_API_KEY as string | undefined;
// The public registry lists a single processor, so k and n must both be 1 against the live
// deployment — the README's 2-of-3 example is illustrative and fails there.
const THRESHOLD = Number(import.meta.env.VITE_NIHILIUM_THRESHOLD ?? 1);
const PROCESSOR_COUNT = Number(import.meta.env.VITE_NIHILIUM_PROCESSOR_COUNT ?? 1);

setApiEndpoint(API_URL);

/** Browser-side state for one in-flight recovery, mirroring what the UI polls via status(). */
interface CeremonyJob {
  phase: ZKEmailPhase | 'submitting' | 'done' | 'error';
  message?: string;
  error?: string;
  /**
   * One entry per guardian being contacted, in the order the user picked them. The members run
   * concurrently, so once k > 1 no single `phase` describes the ceremony.
   */
  members: Array<{ email: string; phase: string; message?: string }>;
  account: Address;
  intent?: RecoveryIntent;
  /** Hash of the intent we submitted — used to tell our attempt apart from an earlier one. */
  intentHash?: Hex;
  initiateTxHash?: Hex;
  completeTxHash?: Hex;
}

function requireEmailCondition(condition: RecoveryCondition): { emails: string[]; threshold: number } {
  if (condition.type !== 'email') {
    throw new Error('The Nihilium recovery provider only supports email conditions.');
  }
  return { emails: condition.emails, threshold: condition.threshold };
}

function requireEmailInput(input: ConditionInput): string {
  if (input.type !== 'email') {
    throw new Error('The Nihilium recovery provider only supports email conditions.');
  }
  return input.email;
}

function requireEmailProof(proof: ConditionProof): string[] {
  if (proof.type !== 'email') {
    throw new Error('The Nihilium recovery provider only supports email conditions.');
  }
  return proof.emails;
}

/**
 * A paid, multi-step sealing run that can be resumed without re-buying the members it already got.
 *
 * Held in memory only, and deliberately: `rrs` is the root secret every recovery key derives from,
 * so persisting it to localStorage would be strictly worse than re-paying after a page reload.
 */
interface SealCheckpoint {
  rrs: Uint8Array;
  setId: string;
  members: QuorumMember[];
}

/**
 * `setId` binds a set of member seals to one Shamir split, and resuming needs the interrupted run's
 * own value. The adapter only exposes it on `Condition.descriptor`, which is typed `unknown` and
 * documented adapter-private — so the reach-through is quarantined here rather than spread around.
 */
function quorumSetId(condition: { descriptor: unknown }): string {
  const setId = (condition.descriptor as { setId?: unknown } | undefined)?.setId;
  if (typeof setId !== 'string' || !setId) {
    throw new Error('The quorum condition carries no set id — cannot checkpoint this sealing run.');
  }
  return setId;
}

export class NihiliumRecoveryProvider implements RecoveryProvider {
  /**
   * Stateless, so one instance serves every member of a quorum — `quorumOf` hands the same adapter
   * to all n slots, and each `buildCondition` call carries its own email.
   */
  private readonly zkEmail: ZKEmailConditionAdapter;
  private readonly sealStore = new BrowserSealStore();
  private readonly jobs = new Map<string, CeremonyJob>();
  private readonly sealCheckpoints = new Map<string, SealCheckpoint>();

  constructor() {
    if (!API_KEY) {
      throw new Error('VITE_NIHILIUM_API_KEY is not set — sealing is a paid Nihilium operation.');
    }
    this.zkEmail = new ZKEmailConditionAdapter({
      emailServiceUrl: EMAIL_SERVICE_URL,
      network: CHAIN_ID,
      threshold: THRESHOLD,
      processorCount: PROCESSOR_COUNT,
      // Named for the browser hazard it is: this ships the API key to the client. That is the
      // deliberate tradeoff of a browser-only ceremony (the reference app does the same) — the key
      // is a spend limit on sealing, not a key to anyone's funds.
      payment: new NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE(API_URL, API_KEY),
    });
  }

  /**
   * The member count varies per user, so the quorum adapter — and therefore the SDK wrapping it —
   * is built per operation rather than once in the constructor.
   *
   * Every gate goes through the quorum, including the single-email one. A 1-of-1 is the degenerate
   * quorum, not a special case, which is what keeps sealing and recovery on one code path.
   */
  private quorumFor(memberCount: number, options?: Parameters<typeof quorumOf>[2]): QuorumConditionAdapter {
    return quorumOf(this.zkEmail, memberCount, options);
  }

  private sdkFor(condition: QuorumConditionAdapter): RecoverySDK {
    return new RecoverySDK({ key: new EvmKeyAdapter(), condition, sealStore: this.sealStore });
  }

  private chainFor(smartAccount: Address, vaultId: string, epoch: number) {
    return {
      namespace: `eip155:${CHAIN_ID}`,
      tier: 'smart-account' as const,
      accountId: smartAccount,
      vaultId,
      epoch,
    };
  }

  async register(input: { account: AccountRef; condition: RecoveryCondition }): Promise<RecoveryRegistration> {
    const { emails, threshold } = requireEmailCondition(input.condition);
    // The quorum enforces distinct member *indices*, not distinct identities — three copies of one
    // address would pass every check downstream and yield a "2-of-3" with a single point of failure.
    const duplicate = findDuplicateEmail(emails);
    if (duplicate) throw new Error(`${duplicate} is listed twice. Each guardian must be a different address.`);
    const vaultId = input.account.userId;
    // epoch is a KDF input, and a completed recovery bumps it on-chain. Seal against the account's
    // *current* epoch so the key we derive now is the one recovery re-derives later.
    const onChainEpoch = await readProtection(input.account.smartAccount)
      .then((p) => Number(p.epoch))
      .catch(() => 0);
    const chain = this.chainFor(input.account.smartAccount, vaultId, onChainEpoch);

    // Each member is a separately billed seal, so a run that dies at member 4 of 5 must not buy
    // members 1-3 again. Resuming reproduces byte-identical shares only if it starts from the same
    // root secret and the same set id, so both are carried on the checkpoint.
    const prior = this.sealCheckpoints.get(vaultId);
    const rrs = prior?.rrs ?? generateRRS();
    const sealedMembers: QuorumMember[] = prior ? [...prior.members] : [];

    const adapter = this.quorumFor(emails.length, {
      // Fires only for members newly sealed on this run; reused ones are already in the list.
      onMemberSealed: (member) => {
        sealedMembers.push(member);
        const checkpoint = this.sealCheckpoints.get(vaultId);
        if (checkpoint) checkpoint.members = [...sealedMembers];
      },
      ...(prior ? { resumeFrom: { setId: prior.setId, members: prior.members } } : {}),
    });

    const builtCondition = await adapter.buildCondition({
      threshold,
      members: emails.map((email) => ({ email })),
    });
    // A resumed run reuses the interrupted run's set id, so checkpoint that rather than the fresh
    // one this buildCondition just minted.
    const setId = prior?.setId ?? quorumSetId(builtCondition);
    this.sealCheckpoints.set(vaultId, { rrs, setId, members: sealedMembers });

    // putSeal() only receives a vaultId, but the vault also needs the email index and the account
    // it belongs to. recoveryOwner isn't known until the seal returns, so it's filled in by a
    // follow-up write below.
    const publishContext = {
      emails,
      threshold,
      userId: input.account.userId,
      smartAccount: input.account.smartAccount,
      epoch: onChainEpoch,
    };
    this.sealStore.publishContext = {
      ...publishContext,
      recoveryOwner: '0x0000000000000000000000000000000000000000',
    };

    // The paid ceremony: one Groth16 proof per member share, tens of seconds each, all in this tab.
    const { recoveryPubKey, sealBlob } = await this.sdkFor(adapter).seal({
      recoveryKey: { kind: 'rrs', rrs },
      condition: builtCondition,
      chain,
    });
    const recoveryOwner = toEvmAddress(recoveryPubKey) as Address;

    // Re-publish now that recoveryOwner is known, so the vault's index matches what goes on-chain.
    this.sealStore.publishContext = { ...publishContext, recoveryOwner };
    await this.sealStore.putSeal(vaultId, sealBlob);

    // Every member is bought and the seal is stored, so nothing is left to resume. Drop the root
    // secret rather than leaving it reachable for the life of the tab.
    rrs.fill(0);
    this.sealCheckpoints.delete(vaultId);

    putRecoveryIndexEntry({
      userId: input.account.userId,
      smartAccount: input.account.smartAccount,
      vaultId,
      epoch: onChainEpoch,
      recoveryOwner,
      registeredAt: Date.now(),
      emails,
      threshold,
    });

    const record: RecoveryRecord = {
      id: input.account.smartAccount,
      account: input.account,
      condition: input.condition,
      createdAt: Date.now(),
    };
    return { record, providerMetadata: { recoveryOwner } };
  }

  async lookup(conditionInput: ConditionInput): Promise<RecoveryRecord | null> {
    const email = requireEmailInput(conditionInput);
    // The vault first: a brand-new browser has nothing in localStorage, and that's exactly the
    // case recovery exists for.
    const remote = await lookupSealByEmail(email).catch(() => null);
    const entry = remote?.found
      ? {
          userId: remote.userId,
          smartAccount: remote.smartAccount as Address,
          vaultId: remote.vaultId,
          epoch: remote.epoch ?? 0,
          recoveryOwner: remote.recoveryOwner as Address,
          registeredAt: Date.now(),
          emails: remote.emails ?? [normalizeEmail(email)],
          threshold: remote.threshold ?? 1,
        }
      : lookupRecoveryIndexEntry(email);
    if (!entry) return null;
    return {
      id: entry.smartAccount,
      account: { userId: entry.userId, eoa: entry.smartAccount, smartAccount: entry.smartAccount },
      // The full guardian set, not just the email that was looked up — the UI needs it to ask which
      // k of them to contact.
      condition: { type: 'email', emails: entry.emails, threshold: entry.threshold },
      createdAt: entry.registeredAt,
    };
  }

  async initiate(record: RecoveryRecord, proof: ConditionProof): Promise<RecoveryHandle> {
    const chosen = requireEmailProof(proof).map(normalizeEmail);
    if (chosen.length === 0) throw new Error('Name at least one guardian email to recover with.');
    const claimant = proof.claimantAddress;
    if (!claimant) throw new Error('The Nihilium recovery provider needs a claimantAddress on the proof.');

    // Any of the guardians can be the one that finds the account — they all index the same vault.
    const remote = await lookupSealByEmail(chosen[0]!).catch(() => null);
    const entry = remote?.found
      ? {
          smartAccount: remote.smartAccount as Address,
          vaultId: remote.vaultId,
          epoch: remote.epoch ?? 0,
          emails: remote.emails ?? chosen,
          threshold: remote.threshold ?? chosen.length,
        }
      : lookupRecoveryIndexEntry(chosen[0]!);
    if (!entry) throw new Error('No recovery registered for this email.');

    // The quorum refuses any count but exactly k, and it does so *after* the seal is fetched. Say it
    // now, before a minutes-long ceremony that could only ever have ended in the same refusal.
    if (chosen.length !== entry.threshold) {
      throw new Error(
        `This account is protected by ${entry.threshold} of ${entry.emails.length} guardian emails, ` +
          `so recovery needs exactly ${entry.threshold} of them named — ${chosen.length} were.`,
      );
    }
    const unknown = chosen.find((email) => !entry.emails.includes(email));
    if (unknown) throw new Error(`${unknown} is not one of this account's guardian emails.`);

    // The ceremony takes minutes and ends in a signature the module checks against its stored
    // recoveryOwner. If the seal we'd unseal belongs to a *different* recoveryOwner — which happens
    // when an account was sealed more than once and only the first install landed — that signature
    // can only fail with BadSignature(). Catch it now rather than after the email round trip.
    const onChain = await readProtection(entry.smartAccount).catch(() => null);
    if (onChain) {
      if (!onChain.installed) {
        throw new Error(
          `The recovery module is not installed on ${entry.smartAccount}, so no recovery can be initiated for it.`,
        );
      }
      // The module allows one attempt at a time, and only EXECUTED/ABORTED are terminal. A leftover
      // attempt would reject initiateRecovery with AttemptInFlight — after the whole email ceremony
      // had already run. Say so now instead.
      if (onChain.recoveryState !== VetoStateOrdinal.NONE && !isTerminalVetoState(onChain.recoveryState)) {
        throw new Error(
          `IN_FLIGHT:${entry.smartAccount}:A recovery attempt is already in flight for this account ` +
            `(state: ${VETO_STATE_LABELS[onChain.recoveryState]}). The module allows one at a time — abort it ` +
            `before starting another. Your seal and recovery key are unaffected.`,
        );
      }

      // epoch is a KDF input. A completed recovery bumps it on-chain, which means a seal created at
      // the previous epoch derives a different key and can never satisfy the module again. Catch it
      // here rather than after the email ceremony.
      if (Number(onChain.epoch) !== Number(entry.epoch ?? 0)) {
        throw new Error(
          `This seal was created at epoch ${entry.epoch ?? 0}, but the account is now at epoch ` +
            `${onChain.epoch} — a completed recovery bumped it. The old seal can no longer recover this ` +
            `account; use "Replace recovery" on it to seal a fresh key at the current epoch.`,
        );
      }

      const sealOwner = remote?.found ? remote.recoveryOwner : lookupRecoveryIndexEntry(chosen[0]!)?.recoveryOwner;
      if (sealOwner && sealOwner.toLowerCase() !== onChain.recoveryOwner.toLowerCase()) {
        throw new Error(
          `The stored seal belongs to recovery key ${sealOwner}, but the account is bound on-chain to ` +
            `${onChain.recoveryOwner}. That happens when the account was sealed again after the module was ` +
            `installed — only the seal from the installed run can recover it.`,
        );
      }
    }

    const handleId = crypto.randomUUID();
    this.jobs.set(handleId, {
      phase: 'preparing',
      account: entry.smartAccount,
      members: chosen.map((email) => ({ email, phase: 'preparing' })),
    });
    // Deliberately not awaited: this runs for minutes (a human has to answer an email). The UI
    // follows it through status().
    void this.runCeremony(handleId, entry.smartAccount, entry.vaultId, entry.epoch, {
      chosen,
      // Position in the registered set IS the Shamir member index, offset by one.
      indices: chosen.map((email) => entry.emails.indexOf(email) + 1),
      memberCount: entry.emails.length,
    }, claimant);
    return { id: handleId, recordId: record.id };
  }

  private async runCeremony(
    handleId: string,
    account: Address,
    vaultId: string,
    epoch: number,
    gate: { chosen: string[]; indices: number[]; memberCount: number },
    claimant: Address,
  ) {
    const job = this.jobs.get(handleId)!;
    try {
      const chain = this.chainFor(account, vaultId, epoch);
      const adapter = this.quorumFor(gate.memberCount);

      // Each member gets its own callbacks rather than a shared stream. The quorum forwards
      // `params` untouched to that member's buildProof, so per-guardian progress comes back
      // already attributed — no parsing a "[member #i]" prefix off a merged log.
      const conditionProof = await adapter.buildProof({
        members: gate.indices.map((index, slot) => ({
          index,
          params: {
            email: gate.chosen[slot]!,
            onProgress: (message: string) => {
              job.members[slot]!.message = message;
            },
            onPhase: (phase: ZKEmailPhase) => {
              job.members[slot]!.phase = phase;
            },
          },
        })),
      });

      // Sends one recovery email per named guardian and long-polls until each human replies, then
      // proves, unseals and reconstructs. The members run concurrently inside the adapter.
      job.phase = 'awaiting_email_reply';
      const authority = await this.sdkFor(adapter).recover({ proof: conditionProof, chain });
      if (authority.kind !== 'capability') throw new Error('Expected a scoped signing capability.');

      job.phase = 'submitting';
      try {
        const relayConfig = await fetchRelayConfig();
        const { epoch: onChainEpoch, nonce } = await readAccountConfig(account);

        const intent: RecoveryIntent = {
          account,
          epoch: onChainEpoch,
          nonce,
          newValidator: relayConfig.recoveryValidator,
          newValidatorInitData: recoveryValidatorInitData(claimant),
          expiry: Math.floor(Date.now() / 1000) + 60 * 60,
        };

        const digest = await hashIntent(intent);
        const signature = await authority.capability.sign(hexToBytes(digest));
        const { txHash } = await relayInitiate(intent, bytesToHex(signature.bytes));

        job.intent = intent;
        job.intentHash = digest;
        job.initiateTxHash = txHash;
        job.phase = 'done';
      } finally {
        authority.capability.zeroize();
      }
    } catch (err) {
      job.phase = 'error';
      // The quorum's own error names which guardians returned and which did not, which is far more
      // actionable than "recovery failed" when three inboxes were involved.
      job.error =
        err instanceof QuorumIncompleteError
          ? `${err.message} Guardians: ${job.members
              .map((m) => `${m.email} (${m.phase})`)
              .join(', ')}`
          : (err as Error).message;
    }
  }

  async status(handle: RecoveryHandle): Promise<RecoveryStatus> {
    const job = this.jobs.get(handle.id);
    if (!job) throw new Error('Unknown recovery handle.');
    if (job.phase === 'error') throw new Error(job.error ?? 'Recovery failed.');

    // Still off-chain: the email ceremony hasn't produced a signed intent yet.
    if (!job.initiateTxHash) {
      return {
        state: 'pending',
        ceremony: {
          phase: job.phase,
          ...(job.message ? { message: job.message } : {}),
          members: job.members,
        },
      };
    }

    // Only trust the on-chain state once the module's attempt slot actually holds *our* intent.
    // Until the initiate transaction is mined it still describes the previous attempt — and
    // reporting that as this recovery's outcome is how a fresh recovery ended up showing "aborted"
    // (terminal, polling stopped) seconds after it started.
    const onChainAttempt = await currentAttemptIntentHash(job.account);
    if (job.intentHash && onChainAttempt.toLowerCase() !== job.intentHash.toLowerCase()) {
      return { state: 'pending', ceremony: { phase: 'submitting', message: 'Waiting for the recovery to appear on-chain…' } };
    }

    const onChain = await stateOf(job.account);
    if (job.completeTxHash && onChain === VetoStateOrdinal.EXECUTED) {
      return { state: 'complete', txHash: job.completeTxHash };
    }
    if (onChain === VetoStateOrdinal.ABORTED) return { state: 'vetoed' };
    if (onChain === VetoStateOrdinal.EXECUTABLE) return { state: 'pending' };
    // PAUSED: the timelock stops accruing, so a countdown would be a lie. Say it's paused instead.
    if (onChain === VetoStateOrdinal.PAUSED) {
      return { state: 'timelocked', untilTs: Date.now(), paused: true };
    }
    return { state: 'timelocked', untilTs: Date.now() + (await remainingTimelockMs(job.account)) };
  }

  private jobOrThrow(handle: RecoveryHandle): CeremonyJob {
    const job = this.jobs.get(handle.id);
    if (!job) throw new Error('Unknown recovery handle.');
    return job;
  }

  async pause(handle: RecoveryHandle, _authority: AuthorityRef): Promise<void> {
    await relayVeto('pause', this.jobOrThrow(handle).account);
  }

  async resume(handle: RecoveryHandle, _authority: AuthorityRef): Promise<void> {
    await relayVeto('resume', this.jobOrThrow(handle).account);
  }

  async abort(handle: RecoveryHandle, _authority: AuthorityRef): Promise<void> {
    await relayVeto('abort', this.jobOrThrow(handle).account);
  }

  async complete(handle: RecoveryHandle): Promise<{ txHash: string; simulated: boolean }> {
    const job = this.jobOrThrow(handle);
    if (!job.intent) throw new Error('Recovery has not been initiated on-chain yet.');
    const { txHash } = await relayComplete(job.intent);
    job.completeTxHash = txHash;
    return { txHash, simulated: false };
  }
}
