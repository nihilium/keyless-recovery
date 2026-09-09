// Visible "Setting up account…" step, ending on an account address + delegation badge.
// Deliberately separate from any recovery/email lookup — see plan.md's "Email lookup is a separate
// function/call" acceptance item.
import { useAppSmartAccount } from '../smartAccount/SmartAccountContext';
import { AddressChip } from '../wallet/AddressChip';
import { Identicon } from '../wallet/Identicon';
import { DelegationBadge } from '../components/DelegationBadge';

export function SignupOnboardingModal({ onDismiss }: { onDismiss: () => void }) {
  const { loading, address, delegationStatus, unavailableReason } = useAppSmartAccount();

  return (
    <div className="modal-overlay">
      <div className="modal">
        {loading || !address || !delegationStatus ? (
          <div className="modal__setting-up">
            <div className="spinner" aria-hidden="true" />
            <p>Setting up account…</p>
          </div>
        ) : (
          <div className="modal__ready">
            <Identicon address={address} size={56} />
            <h2>Account ready</h2>
            <div className="modal__address">
              <AddressChip address={address} />
              <DelegationBadge status={delegationStatus} />
            </div>
            {unavailableReason && (
              <p className="notice notice--warn">
                <strong>Smart account unavailable.</strong> {unavailableReason}
              </p>
            )}
            <button type="button" className="btn btn--primary btn--lg" onClick={onDismiss}>
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
