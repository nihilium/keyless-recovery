import { Fragment, useEffect, useState } from 'react';
import { useAppAuth } from '../auth/login';
import { useAppSmartAccount } from '../smartAccount/SmartAccountContext';
import { useKernelSmartWallet } from '../smartAccount/useKernelSmartWallet';
import { useRecoveryProvider, RECOVERY_PROVIDER_CAPABILITIES } from '../recovery/RecoveryContext';
import { installRecoveryModule, replaceRecoveryModule, fetchVetoConfig } from '../recovery/installRecoveryModule';
import {
  makeEmailCondition,
  findDuplicateEmail,
  normalizeEmail,
  GUARDIAN_PRESETS,
  type GuardianPreset,
} from '../recovery/conditions/EmailCondition';
import { findRecoveryIndexEntryByAccount } from '../recovery/browserRecoveryIndex';
import { useEmailDomainChecks, REGISTER_EMAIL, type DomainCheck } from '../recovery/useEmailDomainChecks';
import { makeWorldIdCondition } from '../recovery/conditions/WorldIdCondition';
import { truncateAddress } from './Identicon';
import { readProtection, VETO_STATE_LABELS, type OnChainProtection } from '../recovery/onchain';

type ConditionTab = 'email' | 'worldid';
type Status = 'idle' | 'sealing' | 'installing' | 'done';
type Mode = 'view' | 'replacing';

interface Guardians {
  pauseAuthority: string;
  abortAuthority: string;
  resumeMembers: string[];
  timelockSeconds: string;
}

/** "60 seconds" / "4 minutes" / "2 hours" — the veto clock is wall-clock, so show it as a duration. */
function formatDuration(seconds: string): string {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return `${seconds} seconds`;
  for (const [unit, size] of [['hour', 3600], ['minute', 60]] as const) {
    if (total >= size && total % size === 0) {
      const n = total / size;
      return `${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return `${total} second${total === 1 ? '' : 's'}`;
}

export function RecoveryCard({ onRegistered }: { onRegistered: (email: string | null) => void }) {
  const provider = useRecoveryProvider();
  const auth = useAppAuth();
  const { smartAccount, eoa, address } = useAppSmartAccount();
  const { client: kernelClient, smartWalletType, supportsModules } = useKernelSmartWallet();

  const [tab, setTab] = useState<ConditionTab>('email');
  /** Which gate the user picked: n guardian emails, k of which must cooperate. */
  const [preset, setPreset] = useState<GuardianPreset>(GUARDIAN_PRESETS[1]);
  /** One entry per guardian, ORDERED — position becomes the Shamir member index at seal time. */
  const [emails, setEmails] = useState<string[]>(() => Array(GUARDIAN_PRESETS[1].n).fill(''));
  /** The registered gate, for the protected view. Browser-local; null if set up elsewhere. */
  const [gate, setGate] = useState<{ emails: string[]; threshold: number } | null>(null);
  const [nullifierHash, setNullifierHash] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [guardians, setGuardians] = useState<Guardians | null>(null);
  /** Set once the (paid) seal has completed — lets a failed on-chain install retry without re-sealing. */
  const [sealedOwner, setSealedOwner] = useState<`0x${string}` | null>(null);
  /** Durable truth, read from the module — component state doesn't survive a page reload. */
  const [onChain, setOnChain] = useState<OnChainProtection | null>(null);
  /** "replacing" swaps the protected card back into the form, for rotating the recovery key. */
  const [mode, setMode] = useState<Mode>('view');

  // Prefill the first guardian from the login identity, but only as a starting point — the user
  // always confirms it.
  useEffect(() => {
    const loginEmail = auth.user?.loginEmail;
    if (!loginEmail) return;
    setEmails((prev) => (prev[0] ? prev : [loginEmail, ...prev.slice(1)]));
  }, [auth.user?.loginEmail]);

  // The gate isn't on-chain — the module records one recovery key and nothing about what guards it
  // — so recover it from this browser's index when the card mounts against a protected account.
  useEffect(() => {
    if (!smartAccount) return;
    const entry = findRecoveryIndexEntryByAccount(smartAccount);
    if (entry) setGate({ emails: entry.emails, threshold: entry.threshold });
  }, [smartAccount]);

  function choosePreset(next: GuardianPreset) {
    setPreset(next);
    // Keep what was already typed; grow or shrink around it.
    setEmails((prev) => Array.from({ length: next.n }, (_, i) => prev[i] ?? ''));
  }

  const duplicateEmail = findDuplicateEmail(emails.filter(Boolean));
  const emailsComplete = emails.every((e) => e.trim().length > 0);

  // Asked before sealing because this is the only moment it can help: a share sealed against a
  // domain zkEmail cannot prove is a share nobody can ever open, and in a 2-of-3 that silently
  // costs the redundancy the user just paid for.
  const domains = useEmailDomainChecks(emails);

  // Protection lives on-chain, so re-read it whenever the account changes or we finish installing.
  useEffect(() => {
    if (!RECOVERY_PROVIDER_CAPABILITIES.onChainVeto || !smartAccount) return;
    let cancelled = false;
    const read = () =>
      readProtection(smartAccount)
        .then((p) => !cancelled && setOnChain(p))
        .catch(() => !cancelled && setOnChain(null));
    read();
    const timer = setInterval(read, 12_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [smartAccount, status]);

  useEffect(() => {
    if (!RECOVERY_PROVIDER_CAPABILITIES.onChainVeto) return;
    fetchVetoConfig()
      .then((c) =>
        setGuardians({
          pauseAuthority: c.pauseAuthority,
          abortAuthority: c.abortAuthority,
          resumeMembers: c.resumeMembers,
          timelockSeconds: c.timelockSeconds,
        }),
      )
      .catch(() => setGuardians(null));
  }, []);

  // Sealing is a *paid* Nihilium operation, so refuse to start one we already know can't be
  // finished — the on-chain install needs a live smart-wallet client, not just an address.
  const blockedReason =
    onChain?.installed && mode !== 'replacing'
      ? // Sealing again without also rotating the module mints a recovery key the installed module
        // doesn't know, orphaning the new (paid) seal and guaranteeing BadSignature() at recovery.
        // "Replace recovery" is the supported path: it re-seals *and* rotates the module together.
        'This account is already protected. Use "Replace recovery" to rotate to a new key.'
      : RECOVERY_PROVIDER_CAPABILITIES.requiresSmartAccount && !smartAccount
      ? 'On-chain recovery needs a smart account. Enable smart wallets for Sepolia in the Privy Dashboard first.'
      : RECOVERY_PROVIDER_CAPABILITIES.requiresSmartAccount && !kernelClient
        ? "No smart-wallet client available, so the recovery module can't be installed. Sign in with Privy (smart wallets enabled) rather than the local dev identity."
        : RECOVERY_PROVIDER_CAPABILITIES.requiresSmartAccount && !supportsModules
          ? `Your Privy smart wallet is "${smartWalletType}", which is not an ERC-7579 modular account — it has no installModule, so the recovery module can't be installed (the UserOp reverts with "reason: 0x"). Switch the smart wallet type to Kernel in the Privy Dashboard.`
          : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!auth.user || !address || !eoa || blockedReason) return;
    setStatus('sealing');
    setError(null);
    try {
      const condition =
        tab === 'email' ? makeEmailCondition(emails, preset.k) : makeWorldIdCondition(nullifierHash);
      const { providerMetadata } = await provider.register({
        account: { userId: auth.user.userId, eoa, smartAccount: smartAccount ?? address },
        condition,
      });

      const recoveryOwner = providerMetadata?.recoveryOwner as `0x${string}` | undefined;
      // The seal is done and paid for from here on. Remember it so a failed install can be retried
      // without re-running (and re-paying for) the ceremony.
      if (recoveryOwner) setSealedOwner(recoveryOwner);
      if (recoveryOwner) await install(recoveryOwner);
      else finish();
    } catch (err) {
      setStatus('idle');
      setError((err as Error).message);
    }
  }

  async function install(recoveryOwner: `0x${string}`) {
    if (!kernelClient || !smartAccount) throw new Error('Smart wallet client is not ready yet.');
    setStatus('installing');
    // Rotating: uninstall + install in one UserOp, since the module has no setter and refuses a
    // second onInstall while a config exists.
    if (onChain?.installed) {
      await replaceRecoveryModule(kernelClient, smartAccount, recoveryOwner, smartWalletType);
    } else {
      await installRecoveryModule(kernelClient, smartAccount, recoveryOwner, smartWalletType);
    }
    setMode('view');
    finish();
  }

  function finish() {
    setStatus('done');
    // Normalized, so the protected view shows the same addresses the seal and index recorded.
    const normalized = emails.map(normalizeEmail);
    const primary = tab === 'email' ? normalized[0]! : null;
    if (tab === 'email') setGate({ emails: normalized, threshold: preset.k });
    setRegisteredEmail(primary);
    // Only a prefill for the dev loss lab, so the first guardian is as good as any.
    onRegistered(primary);
  }

  async function retryInstall() {
    if (!sealedOwner) return;
    setError(null);
    try {
      await install(sealedOwner);
    } catch (err) {
      setStatus('idle');
      setError((err as Error).message);
    }
  }

  const isProtected = status === 'done' || onChain?.installed === true;

  if (isProtected && mode === 'view') {
    return (
      <section className="card recovery-card recovery-card--protected">
        <div className="card__header">
          <h2>Recovery</h2>
          <span className="pill pill--ok">Protected</span>
        </div>
        <p className="recovery-card__lede">
          {gate && gate.threshold > 1 ? (
            <>
              This account can be recovered by proving control of{' '}
              <strong>
                any {gate.threshold} of {gate.emails.length} guardian emails
              </strong>{' '}
              — even from a brand-new device with a brand-new signing key.
            </>
          ) : (
            <>
              This account can be recovered by proving control of{' '}
              <strong>{gate?.emails[0] ?? registeredEmail ?? 'the registered email'}</strong> — even
              from a brand-new device with a brand-new signing key.
            </>
          )}
        </p>
        {gate && <GuardianGate gate={gate} />}
        {onChain && (
          <dl className="recovery-card__facts">
            <div>
              <dt>Recovery key on-chain</dt>
              <dd>
                <code>{truncateAddress(onChain.recoveryOwner)}</code>
              </dd>
            </div>
            <div>
              <dt>Epoch</dt>
              <dd>{onChain.epoch.toString()}</dd>
            </div>
            <div>
              <dt>Recovery in progress</dt>
              <dd>
                {onChain.recoveryState === 0 ? (
                  'None — account is idle'
                ) : (
                  <span className={onChain.recoveryState === 5 ? 'pill pill--warn' : 'pill pill--ok'}>
                    {VETO_STATE_LABELS[onChain.recoveryState]}
                  </span>
                )}
              </dd>
            </div>
          </dl>
        )}
        {guardians && <GuardianList guardians={guardians} />}

        <div className="recovery-card__actions">
          <button type="button" className="btn" onClick={() => { setMode('replacing'); setStatus('idle'); setSealedOwner(null); }}>
            Replace recovery
          </button>
        </div>
        <p className="hint">
          Replacing seals a new recovery key and swaps it in — along with the current guardian set —
          in a single transaction. The old key stops working immediately.
        </p>
      </section>
    );
  }

  return (
    <section className="card recovery-card">
      <div className="card__header">
        <h2>Recovery</h2>
        <span className={mode === 'replacing' ? 'pill pill--ok' : 'pill pill--warn'}>
          {mode === 'replacing' ? 'Replacing' : 'Not protected'}
        </span>
      </div>

      <p className="recovery-card__lede">
        {mode === 'replacing'
          ? 'Seal a new recovery key and swap it in. The account stays protected throughout — the uninstall and install go out as one transaction — but the previous recovery key stops working.'
          : 'Set a recovery condition now. Lose this device and a new sign-in creates a brand-new account — recovery is the only way back to this one.'}
      </p>

      {RECOVERY_PROVIDER_CAPABILITIES.worldId && (
        <div className="tabs">
          <button type="button" className={tab === 'email' ? 'tab tab--active' : 'tab'} onClick={() => setTab('email')}>
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

      {tab === 'email' && (
        <div className="gate-picker">
          {GUARDIAN_PRESETS.map((option) => (
            <button
              key={option.n}
              type="button"
              className={preset.n === option.n ? 'gate-option gate-option--active' : 'gate-option'}
              onClick={() => choosePreset(option)}
              disabled={status !== 'idle'}
            >
              <span className="gate-option__title">
                {option.n} {option.n === 1 ? 'email' : 'emails'}
              </span>
              <span className="gate-option__gate">
                {option.k} of {option.n} to recover
              </span>
              <span className="gate-option__cost">
                {option.n === 1
                  ? 'No redundancy — lose that inbox and the account is gone.'
                  : `Survives losing ${option.n - option.k} of them.`}
              </span>
            </button>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} className={tab === 'email' ? 'gate-form' : 'field-row'}>
        {tab === 'email' ? (
          <>
            {emails.map((value, i) => (
              // The verdict sits outside the label on purpose: it carries a "check again" button,
              // and any control inside a <label> also activates the labelled input when clicked.
              <Fragment key={i}>
                <label className="field">
                  <span className="field__label">
                    {preset.n === 1 ? 'Recovery email' : `Guardian ${i + 1} of ${preset.n}`}
                  </span>
                  <input
                    type="email"
                    required
                    placeholder="you@example.com"
                    value={value}
                    onChange={(e) =>
                      setEmails((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))
                    }
                  />
                </label>
                <DomainVerdict check={domains.checks[i]!} onRecheck={domains.recheck} />
              </Fragment>
            ))}
            {duplicateEmail && (
              <p className="error">
                {duplicateEmail} is listed twice. Each guardian must be a different address —
                otherwise a {preset.k}-of-{preset.n} has fewer real guardians than it claims.
              </p>
            )}
            <button
              type="submit"
              className="btn btn--primary"
              disabled={
                status !== 'idle' ||
                !address ||
                blockedReason !== null ||
                !emailsComplete ||
                duplicateEmail !== null ||
                domains.blocking
              }
            >
              {status === 'sealing'
                ? preset.n === 1
                  ? 'Sealing…'
                  : `Sealing ${preset.n} guardians…`
                : status === 'installing'
                  ? mode === 'replacing'
                    ? 'Replacing…'
                    : 'Installing…'
                  : !emailsComplete
                    ? `Fill in all ${preset.n}`
                    : duplicateEmail
                      ? 'Guardians must differ'
                      : domains.blocking
                        ? domains.checks.some((c) => c.state === 'checking')
                          ? 'Checking domains…'
                          : 'Fix the flagged domain'
                        : mode === 'replacing'
                        ? 'Seal & replace'
                        : 'Protect account'}
            </button>
            <p className="hint">
              Sealing is paid, once per guardian — {preset.n}{' '}
              {preset.n === 1 ? 'seal' : 'seals'} for this choice. It sends no email: the
              human-in-the-loop round trip happens only at recovery, and only for the{' '}
              {preset.k} you name then.
            </p>
          </>
        ) : (
          <>
            <input
              type="text"
              required
              placeholder="World ID nullifier hash"
              value={nullifierHash}
              onChange={(e) => setNullifierHash(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={status !== 'idle' || !address || blockedReason !== null}
            >
              {status === 'sealing'
                ? 'Sealing…'
                : status === 'installing'
                  ? mode === 'replacing'
                    ? 'Replacing…'
                    : 'Installing…'
                  : mode === 'replacing'
                    ? 'Seal & replace'
                    : 'Protect account'}
            </button>
          </>
        )}
      </form>

      {mode === 'replacing' && status === 'idle' && (
        <button type="button" className="btn btn--ghost" onClick={() => setMode('view')}>
          Cancel
        </button>
      )}

      {sealedOwner && status === 'idle' && (
        <div className="notice notice--warn">
          <strong>Seal created — not yet installed on-chain.</strong> The paid Nihilium ceremony
          already succeeded, so retrying only re-sends the transaction; it won't seal (or charge)
          again.
          <div className="notice__actions">
            <button type="button" className="btn" onClick={retryInstall} disabled={!kernelClient}>
              Retry install
            </button>
          </div>
        </div>
      )}

      {tab === 'email' && (
        <p className="hint">
          {auth.user?.loginEmail
            ? `Prefilled from your ${auth.user.loginLabel} login — change it if recovery should go somewhere else. The recovery condition is deliberately independent of how you sign in.`
            : `Your ${auth.user?.loginLabel ?? 'login'} provider doesn't expose an email address, so enter one for recovery. It doesn't have to be the account you sign in with.`}
        </p>
      )}

      {blockedReason && <p className="notice notice--warn">{blockedReason}</p>}

      {error && <p className="notice notice--error">{error}</p>}
    </section>
  );
}

/**
 * What the DKIM registry says about one guardian's domain.
 *
 * Rendered per guardian rather than once for the form: in a five-guardian set the answers routinely
 * differ, and "one of these is not recoverable" is useless without saying which.
 */
function DomainVerdict({ check, onRecheck }: { check: DomainCheck; onRecheck: () => void }) {
  if (check.state === 'idle') return null;

  if (check.state === 'checking') {
    return <span className="hint">Checking whether {check.domain ?? 'this domain'} can be recovered…</span>;
  }

  if (check.state === 'eligible') {
    return (
      <span className="hint domain-verdict domain-verdict--ok">
        <strong>{check.domain}</strong> is registered — emails from it can be proven.
      </span>
    );
  }

  if (check.state === 'error') {
    // Not evidence either way, so it does not block. Say so rather than implying a verdict.
    return (
      <span className="hint">
        Could not reach the registry to check {check.domain}. Sealing is still allowed — this is a
        failed check, not a failed domain.
      </span>
    );
  }

  if (check.state === 'unsupported') {
    return (
      <span className="error">
        <strong>{check.domain}</strong> is not eligible for recovery — Nihilium cannot prove emails
        from this domain, so a share sealed against it could never be opened. Use a different address.
      </span>
    );
  }

  // needs_registration and unverified are both fixable by sending one email, so they share an action.
  return (
    <span className="error">
      {check.state === 'needs_registration' ? (
        <>
          <strong>{check.domain}</strong> is not registered yet.
        </>
      ) : (
        <>
          No DKIM record found for <strong>{check.domain}</strong>, so recovery through it would be a
          guess.
        </>
      )}{' '}
      Send any email from this address to <a href={`mailto:${REGISTER_EMAIL}`}>{REGISTER_EMAIL}</a> so
      its key can be recorded, then{' '}
      <button type="button" className="btn-inline" onClick={onRecheck}>
        check again
      </button>
      .
    </span>
  );
}

/** The account's own recovery gate — distinct from the veto guardians below it. */
function GuardianGate({ gate }: { gate: { emails: string[]; threshold: number } }) {
  return (
    <div className="guardians">
      <h3>Recovery guardians</h3>
      <p className="hint">
        {gate.threshold === gate.emails.length && gate.emails.length === 1
          ? 'A single email holds recovery for this account.'
          : `Any ${gate.threshold} of these ${gate.emails.length} can recover the account together. Fewer cannot, and no one of them can alone.`}
      </p>
      <ul className="guardians__list">
        {gate.emails.map((email, i) => (
          <li key={email}>
            <span className="guardians__role">Guardian {i + 1}</span>
            <code>{email}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GuardianList({ guardians }: { guardians: Guardians }) {
  return (
    <div className="guardians">
      <h3>Graduated veto</h3>
      <p className="hint">
        Three separated authorities. None of them can move funds or complete a recovery — they can
        only slow it down, speed it up, or stop it.
      </p>
      <ul className="guardians__list">
        <li>
          <span className="guardians__role">Pause</span>
          <code>{truncateAddress(guardians.pauseAuthority)}</code>
        </li>
        <li>
          <span className="guardians__role">Abort</span>
          <code>{truncateAddress(guardians.abortAuthority)}</code>
        </li>
        <li>
          <span className="guardians__role">Resume</span>
          <code>{guardians.resumeMembers.map((m) => truncateAddress(m)).join(', ')}</code>
        </li>
        <li>
          <span className="guardians__role">Timelock</span>
          <code>{formatDuration(guardians.timelockSeconds)}</code>
        </li>
      </ul>
    </div>
  );
}
