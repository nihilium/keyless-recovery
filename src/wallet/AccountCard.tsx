import { useState } from 'react';
import { formatEther, isAddress, parseEther, type Address } from 'viem';
import { useAppAuth } from '../auth/login';
import { useAppSmartAccount } from '../smartAccount/SmartAccountContext';
import { useKernelSmartWallet } from '../smartAccount/useKernelSmartWallet';
import { useBalance } from './useBalance';
import { Identicon } from './Identicon';
import { AddressChip } from './AddressChip';
import { DelegationBadge } from '../components/DelegationBadge';

type Busy = null | 'sending';

export function AccountCard({ hasRecoveredAccount = false }: { hasRecoveredAccount?: boolean }) {
  const auth = useAppAuth();
  const { address, smartAccount, eoa, delegationStatus, unavailableReason } = useAppSmartAccount();
  const { client } = useKernelSmartWallet();
  const balance = useBalance(address);

  const [sendOpen, setSendOpen] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // This is the account's *current* signer — the root validator Privy provisioned at onboarding.
  // Root validation bypasses Kernel's per-selector allowlist entirely, so sending here is just a
  // normal UserOp through Privy's own smart-wallet client — no custom nonce routing needed (compare
  // RecoveredAccountCard, which has to work around that allowlist for a validator installed later).
  const canUseSmartWallet = delegationStatus === 'smart-wallet' && Boolean(client) && Boolean(smartAccount);
  const balanceWei = balance === null ? null : parseEther(balance);
  const GAS_RESERVE = parseEther('0.001');
  const sendableMax = balanceWei !== null && balanceWei > GAS_RESERVE ? balanceWei - GAS_RESERVE : 0n;

  let requested: bigint | null = null;
  try {
    requested = amount.trim() === '' ? null : parseEther(amount.trim());
  } catch {
    requested = null;
  }
  const overMax = requested !== null && requested > sendableMax;
  const amountValid = requested !== null && requested > 0n && !overMax;
  const canSend = canUseSmartWallet && isAddress(to) && amountValid && busy === null;

  async function handleSend() {
    if (!client || !smartAccount || !requested) return;
    setBusy('sending');
    setError(null);
    setTxHash(null);
    try {
      const hash = await client.sendTransaction({ to: to as Address, value: requested });
      setTxHash(hash);
      setTo('');
      setAmount('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Keep the card in place while a new account is being provisioned (e.g. right after the loss lab
  // switches identity) — dropping it entirely makes the page jump and hides what's happening.
  if (!address) {
    return (
      <section className="card account-card">
        <div className="account-card__top">
          <span className="skeleton skeleton--avatar" />
          <div className="account-card__identity">
            <span className="skeleton skeleton--line" />
            <span className="skeleton skeleton--chip" />
          </div>
        </div>
        <p className="hint">Setting up account…</p>
      </section>
    );
  }

  return (
    <section className="card account-card">
      <div className="account-card__top">
        <Identicon address={address} size={52} />
        <div className="account-card__identity">
          <div className="account-card__labels">
            <span className="account-card__name">Account</span>
            {delegationStatus && <DelegationBadge status={delegationStatus} />}
          </div>
          <AddressChip address={address} />
        </div>
      </div>

      <div className="account-card__balance">
        {balance === null ? (
          <span className="skeleton skeleton--balance" aria-label="Loading balance" />
        ) : (
          <span className="account-card__balance-value">{Number(balance).toFixed(4)}</span>
        )}
        <span className="account-card__balance-unit">ETH</span>
      </div>

      <div className="account-card__actions">
        <button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(address)}>
          Receive
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canUseSmartWallet}
          title={canUseSmartWallet ? undefined : 'No Privy smart-wallet client for this account'}
          onClick={() => {
            setSendOpen((v) => !v);
            setError(null);
            setTxHash(null);
          }}
        >
          {sendOpen ? 'Cancel' : 'Send'}
        </button>
      </div>

      {sendOpen && canUseSmartWallet && (
        <div className="field">
          <span className="field__label">Send ETH from this account</span>
          <div className="field-row">
            <input
              type="text"
              placeholder="0x… recipient"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              spellCheck={false}
            />
            <input
              type="text"
              className="field--narrow"
              placeholder="0.001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={() => setAmount(formatEther(sendableMax))}
              title="Balance minus a gas reserve"
            >
              Max
            </button>
            <button type="button" className="btn btn--primary" disabled={!canSend} onClick={handleSend}>
              {busy === 'sending' ? 'Sending…' : 'Send'}
            </button>
          </div>
          <span className="hint">
            Gas is paid by the account itself as an ERC-4337 UserOperation, so at most{' '}
            {Number(formatEther(sendableMax)).toFixed(5)} ETH is sendable, keeping 0.001 ETH back for it.
          </span>
          {overMax && (
            <p className="notice notice--warn">
              That's more than this account can send while still covering its own gas. Max is{' '}
              {Number(formatEther(sendableMax)).toFixed(5)} ETH.
            </p>
          )}
          {txHash && (
            <div className="stepper-step">
              <p className="hint">Submitted:</p>
              <code className="tx-hash">{txHash}</code>
              <a className="hint" href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">
                View on Etherscan ↗
              </a>
            </div>
          )}
          {error && <p className="notice notice--error">{error}</p>}
        </div>
      )}

      <dl className="account-card__meta">
        <div>
          <dt>Signed in with</dt>
          <dd>{auth.user?.loginLabel ?? '—'}</dd>
        </div>
        <div>
          <dt>Signer (EOA)</dt>
          <dd>{eoa ? <AddressChip address={eoa} /> : '—'}</dd>
        </div>
        {smartAccount && (
          <div>
            <dt>Smart account</dt>
            <dd>
              <AddressChip address={smartAccount} />
            </dd>
          </div>
        )}
      </dl>

      {/* Suppressed when this wallet controls a recovered account: it plainly *does* have a smart
          account, just not one Privy provisioned, and saying otherwise is simply wrong. */}
      {unavailableReason && !hasRecoveredAccount && (
        <p className="notice notice--warn">
          <strong>No Privy smart account.</strong> {unavailableReason} Showing the signer EOA
          instead — you can't register new on-chain recovery until this is fixed.
        </p>
      )}

      {unavailableReason && hasRecoveredAccount && (
        <p className="hint">
          Privy didn't provision a smart account for this wallet (it only does that for embedded
          wallets), but this wallet controls a recovered account — see below.
        </p>
      )}
    </section>
  );
}
