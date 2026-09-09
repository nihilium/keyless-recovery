// Dev-only lab: simulate losing access to the current identity and walk through recovering it.
// Generalized from a passkey-reset lab — passkey reset was dropped (see plan.md key decisions);
// "New user" is the loss vehicle instead.
import { useState } from 'react';
import { useAppAuth } from '../auth/login';
import { useAppSmartAccount } from '../smartAccount/SmartAccountContext';
import { simulateLoss } from './lossSimulator';
import { RecoveryOffer } from '../flows/RecoveryOffer';
import { Identicon, truncateAddress } from '../wallet/Identicon';

export function RecoveryLossLab({ seededEmail }: { seededEmail?: string }) {
  const auth = useAppAuth();
  const { address } = useAppSmartAccount();
  const [lossJustHappened, setLossJustHappened] = useState(false);

  async function handleNewUser() {
    await simulateLoss(auth);
    setLossJustHappened(true);
  }

  return (
    <section className="loss-lab">
      <h3>Developer · loss lab</h3>
      <p className="hint">
        Loss is identity discontinuity: a new sign-in means a new signing key and a new account. This
        button fakes exactly that.
      </p>

      {address && (
        <div className="loss-lab__identity">
          <Identicon address={address} size={22} />
          <code>{truncateAddress(address)}</code>
        </div>
      )}

      <button type="button" className="btn btn--danger" onClick={handleNewUser}>
        Simulate loss (new identity)
      </button>

      {lossJustHappened && (
        <div className="loss-lab__recovery">
          <p className="hint">New identity created — this is a different account now. Recover the old one:</p>
          <RecoveryOffer initialEmail={seededEmail} />
        </div>
      )}
    </section>
  );
}
