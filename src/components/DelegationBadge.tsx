import type { DelegationStatus } from '../smartAccount/SmartAccountAdapter';

const LABELS: Record<DelegationStatus, string> = {
  eoa: 'EOA',
  '7702-delegated': '7702 delegated',
  'smart-wallet': 'Smart wallet',
  stub: '7702 (stub)',
};

export function DelegationBadge({ status }: { status: DelegationStatus }) {
  return <span className={`badge badge--${status}`}>{LABELS[status]}</span>;
}

export function AddressBadge({ address, status }: { address: string; status: DelegationStatus }) {
  return (
    <div className="address-badge">
      <code className="address-badge__address">{address}</code>
      <DelegationBadge status={status} />
    </div>
  );
}
