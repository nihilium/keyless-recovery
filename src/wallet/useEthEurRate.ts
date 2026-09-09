// A live-ish ETH→EUR rate for display only — never used for anything on-chain (amounts sent are
// always entered and signed in ETH). Module-scoped cache + subscriber list so every card sharing
// this hook polls the same rate instead of one request per card.
import { useEffect, useState } from 'react';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=eur';
const POLL_MS = 60_000;

let cachedRate: number | null = null;
let inFlight: Promise<void> | null = null;
const subscribers = new Set<(rate: number | null) => void>();

async function refresh() {
  if (inFlight) return inFlight;
  inFlight = fetch(COINGECKO_URL)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('rate lookup failed'))))
    .then((body: { ethereum?: { eur?: number } }) => {
      if (typeof body.ethereum?.eur === 'number') {
        cachedRate = body.ethereum.eur;
        subscribers.forEach((fn) => fn(cachedRate));
      }
    })
    .catch(() => {
      // Leave the last-known rate in place (or null) — a fiat estimate is a nice-to-have, never
      // worth surfacing an error for.
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** EUR per 1 ETH, or null until the first fetch resolves (or if it never does). */
export function useEthEurRate(): number | null {
  const [rate, setRate] = useState(cachedRate);

  useEffect(() => {
    subscribers.add(setRate);
    void refresh();
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
    return () => {
      subscribers.delete(setRate);
      if (subscribers.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
  }, []);

  return rate;
}

export function formatEur(ethAmount: number, rate: number | null): string | null {
  if (rate === null || !Number.isFinite(ethAmount)) return null;
  return (ethAmount * rate).toLocaleString('en-IE', { style: 'currency', currency: 'EUR' });
}
