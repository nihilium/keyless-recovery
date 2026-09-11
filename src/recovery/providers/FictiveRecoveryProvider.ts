// Fictive RecoveryProvider — a local, fully offline stand-in for Nihilium.
// Everything lives in localStorage. No network calls, no real timelock, no
// real funds. See RecoveryProvider.ts for the interface this must satisfy.
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

const RECORDS_KEY = 'keyless-recovery/fictive-records';
const HANDLES_KEY = 'keyless-recovery/fictive-handles';

// How long a recovery sits "timelocked" before it's ready to complete(), when register() wasn't
// given a timelockSeconds — matches the real provider's own default (server/.env's TIMELOCK_SECONDS).
const DEFAULT_TIMELOCK_SECONDS = 60;

interface HandleState {
  id: string;
  recordId: string;
  armedAt: number;
  untilTs: number;
  paused: boolean;
  remainingMs: number;
  vetoed: boolean;
  complete: boolean;
  txHash?: string;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

function loadRecords(): RecoveryRecord[] {
  return readJson<RecoveryRecord[]>(RECORDS_KEY, []);
}

function saveRecords(records: RecoveryRecord[]) {
  writeJson(RECORDS_KEY, records);
}

function loadHandles(): Record<string, HandleState> {
  return readJson<Record<string, HandleState>>(HANDLES_KEY, {});
}

function saveHandles(handles: Record<string, HandleState>) {
  writeJson(HANDLES_KEY, handles);
}

function conditionMatches(condition: RecoveryCondition, input: ConditionInput): boolean {
  if (condition.type !== input.type) return false;
  if (condition.type === 'email' && input.type === 'email') {
    // Any one guardian identifies the account — the lookup panel asks for one address, not the set.
    return condition.emails.some((email) => email.toLowerCase() === input.email.toLowerCase());
  }
  if (condition.type === 'worldid' && input.type === 'worldid') {
    return condition.nullifierHash === input.nullifierHash;
  }
  return false;
}

function conditionSatisfiedByProof(condition: RecoveryCondition, proof: ConditionProof): boolean {
  if (condition.type !== proof.type) return false;
  if (condition.type === 'email' && proof.type === 'email') {
    // Mirrors the real provider's gate: exactly k named, and every one of them registered. The
    // fictive provider does no Shamir, so this check *is* the threshold here.
    const registered = condition.emails.map((email) => email.toLowerCase());
    const named = proof.emails.map((email) => email.toLowerCase());
    return (
      named.length === condition.threshold &&
      new Set(named).size === named.length &&
      named.every((email) => registered.includes(email))
    );
  }
  if (condition.type === 'worldid' && proof.type === 'worldid') {
    // Stub: any non-empty proof string for the matching nullifier "verifies".
    return proof.proof.length > 0;
  }
  return false;
}

export class FictiveRecoveryProvider implements RecoveryProvider {
  async register(input: {
    account: AccountRef;
    condition: RecoveryCondition;
    timelockSeconds?: number;
  }): Promise<RecoveryRegistration> {
    // Guard here too, not just in the UI: a record with a zero/negative timelock would arm a handle
    // that's either instantly complete or never satisfiable, and this is the one place that can
    // still catch it if a future caller forgets to validate.
    const timelockSeconds =
      input.timelockSeconds !== undefined && input.timelockSeconds > 0
        ? input.timelockSeconds
        : DEFAULT_TIMELOCK_SECONDS;
    const record: RecoveryRecord = {
      id: crypto.randomUUID(),
      account: input.account,
      condition: input.condition,
      createdAt: Date.now(),
      timelockSeconds,
    };
    const records = loadRecords();
    records.push(record);
    saveRecords(records);
    return { record };
  }

  async lookup(conditionInput: ConditionInput): Promise<RecoveryRecord | null> {
    const records = loadRecords();
    // Most recently registered match wins.
    const match = [...records].reverse().find((r) => conditionMatches(r.condition, conditionInput));
    return match ?? null;
  }

  async initiate(record: RecoveryRecord, proof: ConditionProof): Promise<RecoveryHandle> {
    if (!conditionSatisfiedByProof(record.condition, proof)) {
      throw new Error('Recovery condition proof did not match the registered condition.');
    }
    const now = Date.now();
    // Old localStorage records from before this field existed have no timelockSeconds — same
    // default register() would have used for them.
    const timelockMs = (record.timelockSeconds ?? DEFAULT_TIMELOCK_SECONDS) * 1000;
    const state: HandleState = {
      id: crypto.randomUUID(),
      recordId: record.id,
      armedAt: now,
      untilTs: now + timelockMs,
      paused: false,
      remainingMs: timelockMs,
      vetoed: false,
      complete: false,
    };
    const handles = loadHandles();
    handles[state.id] = state;
    saveHandles(handles);
    return { id: state.id, recordId: record.id };
  }

  async status(handle: RecoveryHandle): Promise<RecoveryStatus> {
    const state = loadHandles()[handle.id];
    if (!state) throw new Error('Unknown recovery handle.');
    if (state.vetoed) return { state: 'vetoed' };
    if (state.complete) return { state: 'complete', txHash: state.txHash! };
    if (state.paused) {
      // A paused timelock isn't counting down, so flag it rather than showing a moving clock.
      return { state: 'timelocked', untilTs: Date.now() + state.remainingMs, paused: true };
    }
    if (Date.now() >= state.untilTs) {
      return { state: 'pending' }; // timelock elapsed, ready for complete()
    }
    return { state: 'timelocked', untilTs: state.untilTs };
  }

  async pause(handle: RecoveryHandle, _authority: AuthorityRef): Promise<void> {
    const handles = loadHandles();
    const state = handles[handle.id];
    if (!state || state.paused || state.vetoed || state.complete) return;
    state.remainingMs = Math.max(0, state.untilTs - Date.now());
    state.paused = true;
    saveHandles(handles);
  }

  async resume(handle: RecoveryHandle, _authority: AuthorityRef): Promise<void> {
    const handles = loadHandles();
    const state = handles[handle.id];
    if (!state || !state.paused) return;
    state.untilTs = Date.now() + state.remainingMs;
    state.paused = false;
    saveHandles(handles);
  }

  async abort(handle: RecoveryHandle, _authority: AuthorityRef): Promise<void> {
    const handles = loadHandles();
    const state = handles[handle.id];
    if (!state) return;
    state.vetoed = true;
    saveHandles(handles);
  }

  async complete(handle: RecoveryHandle): Promise<{ txHash: string; simulated: boolean }> {
    const handles = loadHandles();
    const state = handles[handle.id];
    if (!state) throw new Error('Unknown recovery handle.');
    if (state.vetoed) throw new Error('Recovery was vetoed.');
    if (!state.complete) {
      const stillWaiting = state.paused || Date.now() < state.untilTs;
      if (stillWaiting) throw new Error('Recovery is still timelocked.');
      state.complete = true;
      state.txHash = `0xfictive${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 66);
      saveHandles(handles);
    }
    return { txHash: state.txHash!, simulated: true };
  }
}
