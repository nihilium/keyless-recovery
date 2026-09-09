import { useEffect, useState } from 'react';
import { useAppAuth } from '../auth/login';
import { useAppSmartAccount } from '../smartAccount/SmartAccountContext';
import { useKernelSmartWallet } from '../smartAccount/useKernelSmartWallet';
import { useRecoveryProvider, RECOVERY_PROVIDER_CAPABILITIES } from '../recovery/RecoveryContext';
import { installRecoveryModule, replaceRecoveryModule, fetchVetoConfig } from '../recovery/installRecoveryModule';
import { makeEmailCondition } from '../recovery/conditions/EmailCondition';
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
  timelockBlocks: string;
}

export function RecoveryCard({ onRegistered }: { onRegistered: (email: string | null) => void }) {
  const provider = useRecoveryProvider();
  const auth = useAppAuth();
  const { smartAccount, eoa, address } = useAppSmartAccount();
  const { client: kernelClient, smartWalletType, supportsModules } = useKernelSmartWallet();

  const [tab, setTab] = useState<ConditionTab>('email');
  const [email, setEmail] = useState('');
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

  // Prefill from the login identity, but only as a starting point — the user always confirms it.
  useEffect(() => {
    if (auth.user?.loginEmail && !email) setEmail(auth.user.loginEmail);
  }, [auth.user?.loginEmail, email]);

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
          timelockBlocks: c.timelockBlocks,
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
      const condition = tab === 'email' ? makeEmailCondition(email) : makeWorldIdCondition(nullifierHash);
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
    setRegisteredEmail(tab === 'email' ? email : null);
    onRegistered(tab === 'email' ? email : null);
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
          This account can be recovered by proving control of{' '}
          <strong>{registeredEmail ?? 'the registered email'}</strong> — even from a brand-new device
          with a brand-new signing key.
        </p>
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

      <form onSubmit={handleSubmit} className="field-row">
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
        <button type="submit" className="btn btn--primary" disabled={status !== 'idle' || !address || blockedReason !== null}>
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
          <code>{guardians.timelockBlocks} blocks</code>
        </li>
      </ul>
    </div>
  );
}
