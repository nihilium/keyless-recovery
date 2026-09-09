// Drives the recovery stepper: lookup -> initiate -> poll status -> complete.
// Only talks to the bound RecoveryProvider (via the hook's `provider` param)
// — never a concrete implementation. See RecoveryProvider.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RecoveryProvider,
  RecoveryRecord,
  RecoveryHandle,
  RecoveryStatus,
  ConditionInput,
  ConditionProof,
  AuthorityRef,
} from '../recovery/RecoveryProvider';

export type RecoveryFlowPhase =
  | 'idle'
  | 'looking-up'
  | 'not-found'
  | 'found'
  | 'initiating'
  | 'ceremony'
  | 'armed'
  | 'ready-to-complete'
  | 'vetoed'
  | 'complete'
  | 'error';

/**
 * `pending` means two different things depending on the provider: the fictive provider only ever
 * means "timelock elapsed, ready to complete." The real (Nihilium) provider can also mean "still
 * running the off-chain condition ceremony, not on-chain yet" — distinguished by `ceremony` being
 * present. Centralized here so every place that reads a fresh `RecoveryStatus` agrees on which is
 * which.
 */
function phaseFromStatus(status: RecoveryStatus): RecoveryFlowPhase {
  switch (status.state) {
    case 'vetoed':
      return 'vetoed';
    case 'pending':
      return status.ceremony ? 'ceremony' : 'ready-to-complete';
    case 'timelocked':
      return 'armed';
    case 'complete':
      return 'complete';
  }
}

export interface RecoveryFlowState {
  phase: RecoveryFlowPhase;
  record: RecoveryRecord | null;
  handle: RecoveryHandle | null;
  status: RecoveryStatus | null;
  txHash: string | null;
  error: string | null;
}

const initialState: RecoveryFlowState = {
  phase: 'idle',
  record: null,
  handle: null,
  status: null,
  txHash: null,
  error: null,
};

const POLL_INTERVAL_MS = 1000;

export function useRecoverFunds(provider: RecoveryProvider) {
  const [state, setState] = useState<RecoveryFlowState>(initialState);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const lookup = useCallback(
    async (input: ConditionInput) => {
      setState((s) => ({ ...s, phase: 'looking-up', error: null }));
      try {
        const record = await provider.lookup(input);
        setState((s) => ({ ...s, phase: record ? 'found' : 'not-found', record }));
      } catch (err) {
        setState((s) => ({ ...s, phase: 'error', error: (err as Error).message }));
      }
    },
    [provider],
  );

  const pollStatus = useCallback(
    (handle: RecoveryHandle) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const status = await provider.status(handle);
          setState((s) => ({ ...s, status, phase: phaseFromStatus(status) }));
          if (status.state === 'vetoed' || status.state === 'complete') stopPolling();
        } catch (err) {
          stopPolling();
          setState((s) => ({ ...s, phase: 'error', error: (err as Error).message }));
        }
      }, POLL_INTERVAL_MS);
    },
    [provider, stopPolling],
  );

  const start = useCallback(
    async (proof: ConditionProof) => {
      if (!state.record) return;
      setState((s) => ({ ...s, phase: 'initiating', error: null }));
      try {
        const handle = await provider.initiate(state.record, proof);
        const status = await provider.status(handle);
        setState((s) => ({ ...s, phase: phaseFromStatus(status), handle, status }));
        pollStatus(handle);
      } catch (err) {
        setState((s) => ({ ...s, phase: 'error', error: (err as Error).message }));
      }
    },
    [provider, state.record, pollStatus],
  );

  const pause = useCallback(
    async (authority: AuthorityRef) => {
      if (!state.handle || !provider.pause) return;
      await provider.pause(state.handle, authority);
    },
    [provider, state.handle],
  );

  const resume = useCallback(
    async (authority: AuthorityRef) => {
      if (!state.handle || !provider.resume) return;
      await provider.resume(state.handle, authority);
    },
    [provider, state.handle],
  );

  const abort = useCallback(
    async (authority: AuthorityRef) => {
      if (!state.handle || !provider.abort) return;
      await provider.abort(state.handle, authority);
      stopPolling();
      const status = await provider.status(state.handle);
      setState((s) => ({ ...s, phase: 'vetoed', status }));
    },
    [provider, state.handle, stopPolling],
  );

  const complete = useCallback(async () => {
    if (!state.handle) return;
    try {
      const { txHash } = await provider.complete(state.handle);
      stopPolling();
      setState((s) => ({ ...s, phase: 'complete', txHash }));
    } catch (err) {
      setState((s) => ({ ...s, phase: 'error', error: (err as Error).message }));
    }
  }, [provider, state.handle, stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setState(initialState);
  }, [stopPolling]);

  return { state, lookup, start, pause, resume, abort, complete, reset };
}
