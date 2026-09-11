import { useEffect, useState } from 'react';
import { useAppAuth } from './auth/login';
import { useAppSmartAccount } from './smartAccount/SmartAccountContext';
import { SignupOnboardingModal } from './flows/SignupOnboardingModal';
import { RecoveryLossLab } from './dev/RecoveryLossLab';
import { RecoveryOffer } from './flows/RecoveryOffer';
import { AccountCard } from './wallet/AccountCard';
import { RecoveryCard } from './wallet/RecoveryCard';
import { RecoveredAccountCard } from './wallet/RecoveredAccountCard';
import { useRecoveredAccounts } from './recovery/useRecoveredAccounts';
import { useDismissedAccounts } from './recovery/dismissedAccounts';
import { Identicon, truncateAddress } from './wallet/Identicon';

function TopBar({ onLogout }: { onLogout: () => void }) {
  const auth = useAppAuth();
  const { address } = useAppSmartAccount();

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark" aria-hidden="true" />
        <span className="topbar__name">Keyless</span>
      </div>
      <div className="topbar__right">
        <span className="pill pill--network">
          <span className="pill__dot" />
          Sepolia
        </span>
        {address && (
          <span className="topbar__account">
            <Identicon address={address} size={24} />
            <code>{truncateAddress(address, 6, 4)}</code>
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            auth.logout();
            onLogout();
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

function Wallet({ onLogout }: { onLogout: () => void }) {
  const [seededEmail, setSeededEmail] = useState<string | null>(null);
  const { address, recoveredAway } = useAppSmartAccount();
  const auth = useAppAuth();
  // Backend-answered: any smart account this signed-in wallet controls via a completed recovery.
  const { accounts: recoveredAccounts, refresh: refreshRecovered } = useRecoveredAccounts(auth.user?.eoa ?? null);
  // Recovery is a permanent on-chain event, so "removing" a card can only ever mean "stop showing
  // me this" — a per-browser preference, not a deletion.
  const { isDismissed, dismiss, restoreAll, dismissedCount } = useDismissedAccounts(auth.user?.eoa ?? null);
  const visibleRecoveredAccounts = recoveredAccounts.filter((r) => !isDismissed(r.account));
  // Recovery setup installs a module on a Privy-provisioned smart account, and Privy only
  // provisions one for its own embedded wallets — an externally-connected wallet (MetaMask, etc.)
  // never gets one, no matter how the Dashboard is configured. Offering the form there would be a
  // dead end dressed up as a feature, not a blocked-but-fixable state.
  const canOfferRecoverySetup = recoveredAway !== true && !auth.user?.isExternalWallet;

  return (
    <div className="wallet">
      <TopBar onLogout={onLogout} />
      <main className="wallet__main">
        <AccountCard hasRecoveredAccount={recoveredAccounts.length > 0} />
        {visibleRecoveredAccounts.map((recovered) => (
          <RecoveredAccountCard
            key={recovered.account}
            recovered={recovered}
            onChanged={refreshRecovered}
            onDismiss={() => dismiss(recovered.account)}
          />
        ))}
        {dismissedCount > 0 && (
          <p className="hint">
            {dismissedCount} recovered account{dismissedCount === 1 ? '' : 's'} hidden.{' '}
            <button type="button" className="btn btn--ghost" onClick={restoreAll}>
              Show all
            </button>
          </p>
        )}
        {/* Keyed on the account: switching identity (the loss lab) must reset this to "not
            protected" rather than carry the previous account's status over to a new one.
            Hidden once recoveredAway is true: every action the card offers — protect, replace,
            even the "Protected" summary itself — goes through Privy's smart-wallet client, which
            signs against a root validator this account no longer has. There is nothing left in
            here that could succeed; AccountCard's own banner already explains why.
            Hidden for an externally-connected wallet for the same reason, one step earlier: there
            is no smart account at all to install the module on, and there never will be. */}
        {canOfferRecoverySetup && <RecoveryCard key={address ?? 'none'} onRegistered={setSeededEmail} />}
        {import.meta.env.DEV && <RecoveryLossLab seededEmail={seededEmail ?? undefined} />}
      </main>
    </div>
  );
}

function RecoveryModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay">
      <div className="modal modal--wide">
        <div className="card__header">
          <h2>Recover an account</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="hint modal__lede">
          No sign-in needed. Prove control of the email an account registered, then name the address
          that should own it afterwards.
        </p>
        <RecoveryOffer embedded />
      </div>
    </div>
  );
}

/**
 * Privy takes a few seconds to initialise (it loads an iframe and a bot challenge). A bare spinner
 * with no text during that window reads as "the app is broken" rather than "wait a moment", so this
 * says what it's doing and, if it drags on, why that might be.
 */
function Booting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="signin">
      <div className="signin__panel">
        <span className="topbar__mark signin__mark" aria-hidden="true" />
        <h1>Keyless</h1>
        <div className="booting__row">
          <div className="spinner" aria-hidden="true" />
          <p className="hint">Connecting to Privy…</p>
        </div>
        {slow && (
          <p className="notice notice--warn">
            This is taking longer than usual. Privy loads an iframe from <code>auth.privy.io</code> —
            a blocked third-party request, an ad blocker, or an offline network will stall it here.
          </p>
        )}
      </div>
    </main>
  );
}

function SignIn({ onRecover }: { onRecover: () => void }) {
  const auth = useAppAuth();
  return (
    <main className="signin">
      <div className="signin__panel">
        <span className="topbar__mark signin__mark" aria-hidden="true" />
        <h1>Keyless</h1>
        <p className="signin__lede">
          A wallet you can get back into. Sign in however you like — recovery doesn't depend on it.
        </p>
        <button type="button" className="btn btn--primary btn--lg" onClick={() => auth.login()}>
          Sign in
        </button>
        <button type="button" className="btn btn--ghost" onClick={onRecover}>
          I lost my credentials
        </button>
        <p className="hint signin__hint">
          Signing in creates a new account. Recovery is how you get the old one back.
        </p>
        <p className="hint signin__hint">Sepolia testnet · no real funds</p>
      </div>
    </main>
  );
}

function App() {
  const auth = useAppAuth();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);

  if (!auth.ready) return <Booting />;

  if (!auth.authenticated) {
    return (
      <>
        <SignIn onRecover={() => setShowRecovery(true)} />
        {showRecovery && <RecoveryModal onClose={() => setShowRecovery(false)} />}
      </>
    );
  }

  if (!onboardingDismissed) {
    return <SignupOnboardingModal onDismiss={() => setOnboardingDismissed(true)} />;
  }

  return (
    <Wallet
      onLogout={() => {
        setOnboardingDismissed(false);
        setShowRecovery(false);
      }}
    />
  );
}

export default App;
