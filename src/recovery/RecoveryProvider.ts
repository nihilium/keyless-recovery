// THE SEAM.
//
// Nothing in flows/, dev/, or components may import a concrete RecoveryProvider
// implementation. They import this interface and read the bound instance from
// RecoveryContext. Swapping backends (fictive -> Nihilium) means changing one
// line in RecoveryContext.tsx and nothing else.
import type { Address } from 'viem';

export type UserId = string;

export interface AccountRef {
  userId: UserId;
  eoa: Address;
  smartAccount: Address;
}

// --- Recovery conditions -----------------------------------------------
//
// The recovery *condition* is independent of the login method. Today only
// EmailCondition is implemented; WorldIdCondition is a stub that shows the
// interface already supports more than one condition type.

export interface EmailCondition {
  type: 'email';
  email: string;
}

export interface WorldIdCondition {
  type: 'worldid';
  /** World ID nullifier hash for this action scope. Stubbed — not verified. */
  nullifierHash: string;
}

export type RecoveryCondition = EmailCondition | WorldIdCondition;

// What a caller supplies to *look up* whether a recovery record exists.
export type ConditionInput =
  | { type: 'email'; email: string }
  | { type: 'worldid'; nullifierHash: string };

// What a caller supplies to *prove* a condition is satisfied, to arm recovery.
//
// `claimantAddress` is the account that should receive signing authority once recovery completes —
// generic across providers (any of them could care who's claiming), optional because the fictive
// provider doesn't need it. The Nihilium provider requires it: it becomes the new validator's owner.
export type ConditionProof =
  | { type: 'email'; email: string; claimantAddress?: Address }
  | { type: 'worldid'; proof: string; claimantAddress?: Address };

// --- Records / handles ---------------------------------------------------

export interface RecoveryRecord {
  id: string;
  account: AccountRef;
  condition: RecoveryCondition;
  createdAt: number;
}

export interface RecoveryRegistration {
  record: RecoveryRecord;
  /**
   * Provider-specific extras a caller may need to finish registration outside this interface —
   * e.g. the Nihilium provider returns `{ recoveryOwner }`, the address the caller must install the
   * on-chain recovery module with. The fictive provider needs no follow-up and returns none. Kept
   * generic (not a named field) so the interface doesn't grow a provider-specific shape.
   */
  providerMetadata?: Record<string, unknown>;
}

export interface RecoveryHandle {
  id: string;
  recordId: string;
}

/**
 * `ceremony` is optional, additive detail some providers surface while still `pending` — e.g. the
 * Nihilium provider's human-in-the-loop email wait ("awaiting_email_reply" etc., see condition-zkemail's
 * `ZKEmailPhase`). The fictive provider never sets it; UI must render correctly without it.
 */
export interface RecoveryCeremonyDetail {
  phase: string;
  message?: string;
}

export type RecoveryStatus =
  | { state: 'pending'; ceremony?: RecoveryCeremonyDetail }
  | { state: 'timelocked'; untilTs: number; paused?: boolean }
  | { state: 'vetoed' }
  | { state: 'complete'; txHash: string };

export interface AuthorityRef {
  id: string;
  label?: string;
}

// --- The interface itself --------------------------------------------------

export interface RecoveryProvider {
  /**
   * SEAL — bind a condition to an account.
   *   fictive:  store {conditionRef -> account} in a local index
   *   nihilium: create a seal gated by condition; register rk as recovery
   *             authority on the account
   */
  register(input: { account: AccountRef; condition: RecoveryCondition }): Promise<RecoveryRegistration>;

  /**
   * LOOKUP — does a recovery exist for this input? Drives the email lookup
   * panel.
   */
  lookup(conditionInput: ConditionInput): Promise<RecoveryRecord | null>;

  /**
   * ARM — begin a recovery.
   *   fictive:  start a stub timelock
   *   nihilium: satisfy condition -> unseal rk -> arm 7702 delegate
   */
  initiate(record: RecoveryRecord, proof: ConditionProof): Promise<RecoveryHandle>;

  /**
   * STATUS — pending | timelocked(untilTs) | vetoed | complete.
   *   fictive:  local state machine
   *   nihilium: on-chain delegate state + datastream
   */
  status(handle: RecoveryHandle): Promise<RecoveryStatus>;

  // GRADUATED VETO (optional in stub).
  //   fictive:  local flags   nihilium: on-chain delegate calls
  pause?(handle: RecoveryHandle, authority: AuthorityRef): Promise<void>;
  resume?(handle: RecoveryHandle, authority: AuthorityRef): Promise<void>;
  abort?(handle: RecoveryHandle, authority: AuthorityRef): Promise<void>;

  /**
   * COMPLETE.
   *   fictive:  fake tx hash + simulated:true
   *   nihilium: rk rotates control / moves funds
   */
  complete(handle: RecoveryHandle): Promise<{ txHash: string; simulated: boolean }>;
}
