// Operator panel — separate path (/admin), not linked from the main app. Shows two distinct things:
// the current state of each protected account, and the full on-chain event history. Both come from
// the module itself, so it sees every recovery regardless of which browser started it.
import { useEffect, useState, useCallback } from 'react';
import { truncateAddress } from '../wallet/Identicon';

const BACKEND_URL = (import.meta.env.VITE_RECOVERY_BACKEND_URL as string | undefined) ?? 'http://localhost:8787';
const TOKEN_STORAGE_KEY = 'keyless-recovery/admin-token';

interface AdminAccount {
  account: string;
  state: string;
  recoveryOwner: string;
  epoch: string;
  protected: boolean;
}

interface AdminEvent {
  type: 'registered' | 'initiated' | 'paused' | 'resumed' | 'aborted' | 'executed';
  account: string;
  intentHash?: string;
  recoveryOwner?: string;
  blockNumber: string;
  txHash: string;
}

const EVENT_LABELS: Record<AdminEvent['type'], string> = {
  registered: 'Recovery registered',
  initiated: 'Recovery initiated',
  paused: 'Paused by guardian',
  resumed: 'Resumed',
  aborted: 'Aborted by guardian',
  executed: 'Recovery executed',
};

function eventPillClass(type: AdminEvent['type']): string {
  if (type === 'aborted') return 'pill pill--warn';
  if (type === 'paused') return 'pill pill--warn';
  if (type === 'executed' || type === 'registered') return 'pill pill--ok';
  return 'pill';
}

function loadStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function AdminDashboard() {
  const [token, setToken] = useState(loadStoredToken);
  const [tokenInput, setTokenInput] = useState('');
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/admin/recoveries`, { headers: { 'x-admin-token': token } });
      if (!res.ok) throw new Error(res.status === 401 ? 'Invalid admin token.' : 'Failed to load recoveries.');
      const body = (await res.json()) as { accounts: AdminAccount[]; events: AdminEvent[] };
      setAccounts(body.accounts);
      setEvents(body.events);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
  }, [token, refresh]);

  async function runAction(account: string, action: 'pause' | 'resume' | 'abort') {
    setActionBusy(`${account}:${action}`);
    try {
      const res = await fetch(`${BACKEND_URL}/api/relay/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${action} failed.`);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionBusy(null);
    }
  }

  if (!token) {
    return (
      <main className="signin">
        <div className="signin__panel">
          <h1>Recovery admin</h1>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              try {
                sessionStorage.setItem(TOKEN_STORAGE_KEY, tokenInput);
              } catch {
                // ignore storage failures
              }
              setToken(tokenInput);
            }}
            className="lookup-form"
          >
            <input
              type="password"
              placeholder="Admin token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <button type="submit" className="btn btn--primary">
              Enter
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell admin-shell">
      <h1>Recovery admin</h1>
      {error && <p className="notice notice--error">{error}</p>}

      <section className="card">
        <div className="card__header">
          <h2>Protected accounts</h2>
          <span className="hint">live state</span>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>State</th>
                <th>Recovery key</th>
                <th>Epoch</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.account}>
                  <td title={a.account}>
                    <code>{truncateAddress(a.account, 10, 8)}</code>
                  </td>
                  <td>
                    <span className={a.state === 'aborted' || a.state === 'paused' ? 'pill pill--warn' : 'pill pill--ok'}>
                      {a.state}
                    </span>
                  </td>
                  <td>
                    <code title={a.recoveryOwner}>
                      {a.protected ? truncateAddress(a.recoveryOwner, 10, 8) : '— not installed —'}
                    </code>
                  </td>
                  <td>{a.epoch}</td>
                  <td className="admin-table__actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={actionBusy !== null || a.state !== 'initiated'}
                      onClick={() => runAction(a.account, 'pause')}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={actionBusy !== null || a.state !== 'paused'}
                      onClick={() => runAction(a.account, 'resume')}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={actionBusy !== null || a.state === 'aborted' || a.state === 'executed' || a.state === 'none'}
                      onClick={() => runAction(a.account, 'abort')}
                    >
                      Abort
                    </button>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={5} className="hint">
                    No accounts have registered recovery yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card__header">
          <h2>Event history</h2>
          <span className="hint">newest first</span>
        </div>
        <ul className="admin-events">
          {events.map((e) => (
            <li key={`${e.txHash}-${e.type}-${e.blockNumber}`}>
              <span className={eventPillClass(e.type)}>{EVENT_LABELS[e.type]}</span>
              <code className="admin-events__account" title={e.account}>
                {truncateAddress(e.account, 10, 8)}
              </code>
              <span className="hint">block {e.blockNumber}</span>
              <a
                className="admin-events__link"
                href={`https://sepolia.etherscan.io/tx/${e.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                tx ↗
              </a>
            </li>
          ))}
          {events.length === 0 && <li className="hint">No recovery events on-chain yet.</li>}
        </ul>
      </section>
    </main>
  );
}
