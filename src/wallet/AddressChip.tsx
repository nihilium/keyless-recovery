import { useState } from 'react';
import { truncateAddress } from './Identicon';

export function AddressChip({ address, full = false }: { address: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard unavailable (insecure context) — the address is still selectable on screen
    }
  }

  return (
    <button type="button" className="address-chip" onClick={copy} title="Copy address">
      <code>{full ? address : truncateAddress(address)}</code>
      <span className="address-chip__icon">{copied ? '✓' : '⧉'}</span>
    </button>
  );
}
