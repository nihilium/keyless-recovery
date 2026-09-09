// Shows up when the signed-in wallet is an owner on OwnableValidator for some account — i.e. it
// came out of a completed recovery. This is the payoff: proving the recovered key actually controls
// the account, not just that a transaction succeeded.
import { useState } from 'react';
import { formatEther, isAddress, parseEther, type Address, type EIP1193Provider } from 'viem';
import { useWallets } from '@privy-io/react-auth';
import { useAppAuth } from '../auth/login';
import { promoteRecoveredValidatorToRoot, sendFromRecoveredAccount } from '../recovery/recoveredAccount';
import type { RecoveredAccount } from '../recovery/useRecoveredAccounts';
import { truncateAddress } from './Identicon';
import { AddressChip } from './AddressChip';
import { useEthEurRate, formatEur } from './useEthEurRate';

type Busy = null | 'sending' | 'promoting';

export function RecoveredAccountCard({
  recovered,
  onChanged,
  onDismiss,
}: {
  recovered: RecoveredAccount;
  onChanged?: () => void;
  onDismiss?: () => void;
}) {
  const { wallets } = useWallets();
  const auth = useAppAuth();
  // Compare against the same address the backend was queried with, and sign with the wallet that
  // matches it — wallets[0] isn't guaranteed to be the signed-in one.
  const signerAddress = auth.user?.eoa;
  const signer = wallets.find((w) => w.address.toLowerCase() === signerAddress?.toLowerCase()) ?? wallets[0];

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { account, owners, oldKeyStillValid } = recovered;
  const balance = BigInt(recovered.balance);
  const eurRate = useEthEurRate();
  const balanceEur = formatEur(Number(formatEther(balance)), eurRate);
  const isOwner = Boolean(signerAddress && owners.some((o) => o.toLowerCase() === signerAddress.toLowerCase()));
  // The account pays its own gas (no paymaster), so the whole balance is never sendable. A UserOp
  // here costs roughly 300k gas; this reserve keeps enough back that the op can actually pay its
  // prefund instead of failing validation.
  const GAS_RESERVE = parseEther('0.001');
  const sendableMax = balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n;

  let requested: bigint | null = null;
  try {
    requested = amount.trim() === '' ? null : parseEther(amount.trim());
  } catch {
    requested = null;
  }
  const overMax = requested !== null && requested > sendableMax;
  const amountValid = requested !== null && requested > 0n && !overMax;
  const canSend = isOwner && isAddress(to) && amountValid && busy === null;

  async function withProvider(fn: (provider: EIP1193Provider) => Promise<string>) {
    setError(null);
    setTxHash(null);
    try {
      if (!signer) throw new Error('No connected wallet available to sign with.');
      const provider = (await signer.getEthereumProvider()) as EIP1193Provider;
      const hash = await fn(provider);
      setTxHash(hash);
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="card__header">
        <h2>Recovered account</h2>
        <span className="card__header-actions">
          <span className={isOwner ? 'pill pill--ok' : 'pill pill--warn'}>
            {isOwner ? 'You control this' : 'Not your key'}
          </span>
          {onDismiss && (
            <button type="button" className="btn btn--ghost btn--icon" title="Hide from this list" onClick={onDismiss}>
              ✕
            </button>
          )}
        </span>
      </div>

      <p className="recovery-card__lede">
        Recovery installed a new signing key on <code>{truncateAddress(account)}</code>. Transactions
        below are signed by your connected wallet and validated by that key — no Privy smart wallet
        involved.
      </p>

      <dl className="recovery-card__facts">
        <div>
          <dt>Account</dt>
          <dd>
            <AddressChip address={account} />
          </dd>
        </div>
        <div>
          <dt>Balance</dt>
          <dd>
            {`${Number(formatEther(balance)).toFixed(5)} ETH`}
            {balanceEur && <span className="hint"> · ≈ {balanceEur}</span>}
          </dd>
        </div>
        <div>
          <dt>Recovered owner</dt>
          <dd>
            <AddressChip address={owners[0]!} />
          </dd>
        </div>
        <div>
          <dt>Your wallet</dt>
          <dd>{signerAddress ? <AddressChip address={signerAddress} /> : '—'}</dd>
        </div>
      </dl>

      {!isOwner && (
        <p className="notice notice--warn">
          Your connected wallet isn't the recovered owner, so it can't sign for this account. Sign in
          with <code>{truncateAddress(owners[0]!)}</code> to control it.
        </p>
      )}

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
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSend}
            onClick={() => {
              setBusy('sending');
              void withProvider((provider) =>
                sendFromRecoveredAccount(account, provider, { to: to as Address, value: requested! }),
              );
            }}
          >
            {busy === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </div>
        <span className="hint">
          Gas comes from the recovered account itself, paid as an ERC-4337 UserOperation — so at most{' '}
          {Number(formatEther(sendableMax)).toFixed(5)} ETH is sendable, keeping 0.001 ETH back for it.
        </span>
        {overMax && (
          <p className="notice notice--warn">
            That's more than this account can send. Sending the full balance leaves nothing to pay the
            UserOperation's gas, so it would fail validation. Max is{' '}
            {Number(formatEther(sendableMax)).toFixed(5)} ETH.
          </p>
        )}
      </div>

      {oldKeyStillValid && (
        <div className="notice notice--warn">
          <strong>The pre-recovery key still works.</strong> Recovery <em>adds</em> a validator, it
          never removes the old one — and on Kernel the old one is the <em>root</em> validator, which
          can't be uninstalled (<code>RootValidatorCannotBeRemoved</code>). Promoting the recovered
          validator to root is what actually takes the old key out of the picture.
          <div className="notice__actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={!isOwner || busy !== null}
              onClick={() => {
                setBusy('promoting');
                void withProvider((provider) => promoteRecoveredValidatorToRoot(account, provider, owners[0]!));
              }}
            >
              {busy === 'promoting' ? 'Promoting…' : 'Revoke old key'}
            </button>
          </div>
        </div>
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
    </section>
  );
}
