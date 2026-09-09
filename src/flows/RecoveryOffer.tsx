// Look up a recovery -> name the address that should take control -> run the ceremony -> watch the
// on-chain veto -> complete.
//
// The new owner is an explicit, required input rather than something inferred from the current
// session: recovery has to work when you have *no* session, and the operation is literally "move
// control of that account to this address". Leaving it implicit is what made "Start recovery" feel
// like it did something unexplained.
import { useEffect, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { useRecoveryProvider, RECOVERY_PROVIDER_CAPABILITIES } from '../recovery/RecoveryContext';
import { useRecoverFunds } from './recoverFunds';
import { emailLookupInput, emailProof } from '../recovery/conditions/EmailCondition';
import { worldIdLookupInput, worldIdProof } from '../recovery/conditions/WorldIdCondition';
import type { AuthorityRef } from '../recovery/RecoveryProvider';
import { truncateAddress } from '../wallet/Identicon';
import { relayVeto } from '../recovery/relay';

type ConditionTab = 'email' | 'worldid';

const DEMO_AUTHORITY: AuthorityRef = { id: 'guardian-1', label: 'Demo guardian' };

function useCountdown(untilTs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (untilTs == null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [untilTs]);
  return untilTs != null ? Math.max(0, untilTs - now) : 0;
}

export function RecoveryOffer({
  initialEmail,
  initialNewOwner,
  embedded = false,
}: {
  initialEmail?: string;
  /** Prefill only — the user always confirms which address ends up owning the account. */
  initialNewOwner?: string;
  embedded?: boolean;
}) {
  const provider = useRecoveryProvider();
  const flow = useRecoverFunds(provider);
  const [tab, setTab] = useState<ConditionTab>('email');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [nullifierHash, setNullifierHash] = useState('');
  const [newOwner, setNewOwner] = useState(initialNewOwner ?? '');
  const [clearing, setClearing] = useState(false);

  const untilTs = flow.state.status?.state === 'timelocked' ? flow.state.status.untilTs : null;
  const remainingMs = useCountdown(untilTs);
  const ceremony = flow.state.status?.state === 'pending' ? flow.state.status.ceremony : undefined;
  const paused = flow.state.status?.state === 'timelocked' && flow.state.status.paused === true;
  const newOwnerValid = isAddress(newOwner);

  // The provider tags this one case so the UI can offer the fix rather than just printing it.
  const inFlight = flow.state.error?.startsWith('IN_FLIGHT:')
    ? { account: flow.state.error.split(':')[1] as Address, message: flow.state.error.split(':').slice(2).join(':') }
    : null;

  async function clearInFlight() {
    if (!inFlight) return;
    setClearing(true);
    try {
      await relayVeto('abort', inFlight.account);
      flow.reset();
    } catch (err) {
      console.error(err);
    } finally {
      setClearing(false);
    }
  }

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (tab === 'email') await flow.lookup(emailLookupInput(email));
    else await flow.lookup(worldIdLookupInput(nullifierHash));
  }

  async function handleStart() {
    if (!newOwnerValid) return;
    const claimant = newOwner as Address;
    if (tab === 'email') await flow.start(emailProof(email, claimant));
    else await flow.start(worldIdProof(nullifierHash, claimant));
  }

  return (
    <div className={embedded ? 'recovery-offer recovery-offer--embedded' : 'recovery-offer'}>
      {!embedded && <h3>Recover an account</h3>}

      {(flow.state.phase === 'idle' || flow.state.phase === 'looking-up' || flow.state.phase === 'not-found') && (
        <>
          {RECOVERY_PROVIDER_CAPABILITIES.worldId && (
            <div className="tabs">
              <button
                type="button"
                className={tab === 'email' ? 'tab tab--active' : 'tab'}
                onClick={() => setTab('email')}
              >
                Email
              </button>
              <button
                type="button"
                className={tab === 'worldid' ? 'tab tab--active' : 'tab'}
                onClick={() => setTab('worldid')}
              >
                World ID
              </button>
            </div>
          )}
          <form onSubmit={handleLookup} className="lookup-form">
            {tab === 'email' ? (
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            ) : (
              <input
                type="text"
                required
                placeholder="World ID nullifier hash"
                value={nullifierHash}
                onChange={(e) => setNullifierHash(e.target.value)}
              />
            )}
            <button type="submit" className="btn btn--primary" disabled={flow.state.phase === 'looking-up'}>
              {flow.state.phase === 'looking-up' ? 'Looking up…' : 'Look up recovery'}
            </button>
          </form>
          {flow.state.phase === 'not-found' && (
            <p className="hint">
              A new sign-in creates a new account. We can only move funds if this email was registered before.
            </p>
          )}
        </>
      )}

      {flow.state.phase === 'found' && flow.state.record && (
        <div className="stepper-step">
          <p>
            Found a recovery for <strong>{describeConditionValue(flow.state.record.condition)}</strong>, protecting{' '}
            <code>{truncateAddress(flow.state.record.account.smartAccount)}</code>.
          </p>

          <label className="field">
            <span className="field__label">Give control to this address</span>
            <input
              type="text"
              placeholder="0x… address that should own the account afterwards"
              value={newOwner}
              onChange={(e) => setNewOwner(e.target.value)}
              spellCheck={false}
            />
            <span className="hint">
              Recovery installs a new signing key on the recovered account, owned by this address.
              Make sure you control it — this is where the account ends up.
            </span>
          </label>

          <button type="button" className="btn btn--primary" onClick={handleStart} disabled={!newOwnerValid}>
            {newOwnerValid ? 'Start recovery' : 'Enter a valid address'}
          </button>
        </div>
      )}

      {flow.state.phase === 'initiating' && <p>Arming recovery…</p>}

      {flow.state.phase === 'ceremony' && (
        <div className="stepper-step">
          {ceremony?.phase === 'awaiting_email_reply' ? (
            <p className="ceremony-banner">
              Check your email — reply to the recovery message to continue. This can take a few minutes.
            </p>
          ) : (
            <p>{ceremonyPhaseLabel(ceremony?.phase)}</p>
          )}
          {ceremony?.message && <p className="hint">{ceremony.message}</p>}
        </div>
      )}

      {flow.state.phase === 'armed' && (
        <div className="stepper-step">
          {paused ? (
            <>
              <p className="ceremony-banner">
                Paused by a guardian. The timelock has stopped accruing — it picks up where it left
                off when a guardian resumes, or automatically once the pause ceiling lapses.
              </p>
              <p className="hint">
                A pause buys time to investigate; it can't cancel a recovery on its own. Only the
                abort authority can do that.
              </p>
            </>
          ) : (
            <>
              <p>Recovery timelocked. Ready in {(remainingMs / 1000).toFixed(0)}s.</p>
              <p className="hint">
                This is the window in which a guardian can pause or abort the recovery.
              </p>
            </>
          )}
          <div className="veto-controls">
            <button type="button" className="btn" onClick={() => flow.pause(DEMO_AUTHORITY)}>
              Pause
            </button>
            <button type="button" className="btn" onClick={() => flow.resume(DEMO_AUTHORITY)}>
              Resume
            </button>
            <button type="button" className="btn btn--danger" onClick={() => flow.abort(DEMO_AUTHORITY)}>
              Abort
            </button>
          </div>
        </div>
      )}

      {flow.state.phase === 'ready-to-complete' && (
        <div className="stepper-step">
          <p>Timelock elapsed. Recovery is ready to complete.</p>
          <button type="button" className="btn btn--primary" onClick={() => flow.complete()}>
            Complete recovery
          </button>
        </div>
      )}

      {flow.state.phase === 'vetoed' && (
        <div className="stepper-step">
          <p>Recovery was aborted by a guardian.</p>
          <button type="button" className="btn" onClick={flow.reset}>
            Start over
          </button>
        </div>
      )}

      {flow.state.phase === 'complete' && (
        <div className="stepper-step">
          <p>
            Recovery complete — <code>{truncateAddress(newOwner)}</code> now controls the account.
          </p>
          <code className="tx-hash">{flow.state.txHash}</code>
          <p className="hint">
            {RECOVERY_PROVIDER_CAPABILITIES.onChainVeto
              ? 'Real Sepolia transaction — check it on sepolia.etherscan.io.'
              : 'Recovery is simulated. Funds are not moved on-chain with the fictive provider.'}
          </p>
          <button type="button" className="btn" onClick={flow.reset}>
            Start over
          </button>
        </div>
      )}

      {flow.state.phase === 'error' && (
        <div className="stepper-step">
          <p className="notice notice--error">{inFlight ? inFlight.message : flow.state.error}</p>
          {inFlight ? (
            <>
              <p className="hint">
                Aborting only cancels the stuck attempt. The recovery key and guardians stay
                installed, so you can start a fresh recovery straight afterwards — no re-sealing.
              </p>
              <div className="veto-controls">
                <button type="button" className="btn btn--danger" onClick={clearInFlight} disabled={clearing}>
                  {clearing ? 'Aborting…' : 'Abort stuck attempt'}
                </button>
                <button type="button" className="btn" onClick={flow.reset}>
                  Start over
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="btn" onClick={flow.reset}>
              Start over
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function describeConditionValue(condition: { type: 'email'; email: string } | { type: 'worldid'; nullifierHash: string }): string {
  return condition.type === 'email' ? condition.email : `World ID (${condition.nullifierHash.slice(0, 10)}…)`;
}

const CEREMONY_PHASE_LABELS: Record<string, string> = {
  preparing: 'Preparing recovery…',
  proving: 'Verifying your reply and producing a proof…',
  unsealing: 'Unsealing the recovery key…',
  submitting: 'Submitting recovery on-chain…',
};

function ceremonyPhaseLabel(phase: string | undefined): string {
  return (phase && CEREMONY_PHASE_LABELS[phase]) ?? 'Working…';
}
