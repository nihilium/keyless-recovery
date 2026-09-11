// Login method — passkey/email/social, whichever Privy dashboard config
// allows. Swappable, not load-bearing: nothing about recovery depends on how
// the user logs in (see RecoveryProvider.ts). If VITE_PRIVY_APP_ID isn't set,
// falls back to a local dev identity so the rest of the demo still runs
// without a real Privy app configured.
import { useCallback, useSyncExternalStore } from 'react';
import { usePrivy, type User as PrivyUser } from '@privy-io/react-auth';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import type { Address } from 'viem';

export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
export const isPrivyConfigured = Boolean(PRIVY_APP_ID);

export interface AppAuthUser {
  userId: string;
  eoa: Address;
  /**
   * Best-effort email from whatever the user logged in with. Google and Apple always carry one;
   * GitHub/Discord/LinkedIn sometimes do; Twitter, Farcaster and Telegram never do. So this is a
   * *hint to prefill the recovery field*, never the recovery condition itself — the user always
   * confirms it. That separation is the point: the recovery condition is independent of login.
   */
  loginEmail: string | null;
  /** How this session was authenticated, for display ("Google", "Email", "Wallet", …). */
  loginLabel: string;
  /**
   * True when this session's wallet was connected externally (MetaMask, Rainbow, WalletConnect, …)
   * rather than created by Privy as an embedded wallet. Privy only provisions a Kernel smart wallet
   * for its own embedded wallets — an externally connected one never gets one, no matter what the
   * Privy Dashboard is configured to do — so on-chain recovery (which installs a module on that
   * smart account) is structurally unavailable here, not just pending a config toggle.
   */
  isExternalWallet: boolean;
}

export interface AppAuth {
  ready: boolean;
  authenticated: boolean;
  user: AppAuthUser | null;
  login: () => void;
  logout: () => void | Promise<void>;
  mode: 'privy' | 'dev';
  /**
   * Swap directly to a brand-new identity, atomically — no intermediate
   * unauthenticated render (a logout()-then-login() pair would unmount every
   * authenticated component in between, wiping the loss lab's local state).
   * Only available in dev mode; under real Privy there's no headless
   * equivalent, so lossSimulator falls back to logout+login there.
   */
  simulateNewIdentity?: () => void;
  /**
   * Bearer token for the recovery backend (see NihiliumRecoveryProvider), verified server-side
   * against Privy. Only meaningful in privy mode — the dev fallback has no server session to prove.
   */
  getAccessToken: () => Promise<string | null>;
}

const DEV_AUTH_STORAGE_KEY = 'keyless-recovery/dev-auth-user';

function generateDevUser(): AppAuthUser {
  const privateKey = generatePrivateKey();
  return {
    userId: crypto.randomUUID(),
    eoa: privateKeyToAddress(privateKey),
    loginEmail: null,
    loginLabel: 'Dev identity',
    // The dev fallback stands in for an embedded wallet (it's what runs when there's no Privy app
    // configured at all), never for an externally-connected one — recovery stays offered here.
    isExternalWallet: false,
  };
}

function loadDevUser(): AppAuthUser | null {
  try {
    const raw = localStorage.getItem(DEV_AUTH_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AppAuthUser) : null;
  } catch {
    return null;
  }
}

function saveDevUser(user: AppAuthUser | null) {
  try {
    if (user) localStorage.setItem(DEV_AUTH_STORAGE_KEY, JSON.stringify(user));
    else localStorage.removeItem(DEV_AUTH_STORAGE_KEY);
  } catch {
    // ignore storage failures (private browsing, etc.)
  }
}

/**
 * Which login providers actually hand back an email address, and what to call them. Twitter,
 * Farcaster and Telegram are deliberately absent from the email side: they expose no email at all,
 * so a user who signs in that way must type a recovery address themselves.
 */
function resolveLogin(user: PrivyUser): { loginEmail: string | null; loginLabel: string } {
  if (user.email?.address) return { loginEmail: user.email.address, loginLabel: 'Email' };
  if (user.google?.email) return { loginEmail: user.google.email, loginLabel: 'Google' };
  if (user.apple?.email) return { loginEmail: user.apple.email, loginLabel: 'Apple' };
  if (user.github) return { loginEmail: user.github.email ?? null, loginLabel: 'GitHub' };
  if (user.discord) return { loginEmail: user.discord.email ?? null, loginLabel: 'Discord' };
  if (user.linkedin) return { loginEmail: user.linkedin.email ?? null, loginLabel: 'LinkedIn' };
  if (user.twitter) return { loginEmail: null, loginLabel: 'X / Twitter' };
  if (user.farcaster) return { loginEmail: null, loginLabel: 'Farcaster' };
  if (user.telegram) return { loginEmail: null, loginLabel: 'Telegram' };
  if (user.wallet) return { loginEmail: null, loginLabel: 'Wallet' };
  return { loginEmail: null, loginLabel: 'Privy' };
}

/** `walletClientType` values for wallets Privy itself created and custodies (embedded wallets). */
const EMBEDDED_WALLET_CLIENT_TYPES = new Set(['privy', 'privy-v2']);

/**
 * True when `user.wallet` was connected from outside (MetaMask, Rainbow, WalletConnect, …) rather
 * than created by Privy. This is the one field Privy's own SDK exposes for the distinction — see
 * `Wallet.walletClientType` in `@privy-io/react-auth`: `'privy'`/`'privy-v2'` for an embedded
 * wallet, anything else for an external one. No wallet at all (still finishing sign-in) reads as
 * "not external" rather than blocking on an unknown state.
 */
function isExternalWallet(user: PrivyUser): boolean {
  const clientType = user.wallet?.walletClientType;
  return clientType != null && !EMBEDDED_WALLET_CLIENT_TYPES.has(clientType);
}

function usePrivyAppAuth(): AppAuth {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  return {
    ready,
    authenticated,
    user: user
      ? {
          userId: user.id,
          eoa: (user.wallet?.address ?? '0x0') as Address,
          ...resolveLogin(user),
          isExternalWallet: isExternalWallet(user),
        }
      : null,
    login: () => login(),
    logout: () => logout(),
    mode: 'privy',
    getAccessToken,
  };
}

// Shared across every component instance — a plain useState here would give
// each caller (Dashboard, RecoveryLossLab, ...) its own disconnected copy of
// "who is logged in", so simulating loss in one place wouldn't be seen by
// another.
let devUser: AppAuthUser | null = loadDevUser();
const devAuthListeners = new Set<() => void>();

function setDevUser(next: AppAuthUser | null) {
  devUser = next;
  saveDevUser(next);
  devAuthListeners.forEach((listener) => listener());
}

function subscribeDevUser(listener: () => void) {
  devAuthListeners.add(listener);
  return () => devAuthListeners.delete(listener);
}

function useDevAppAuth(): AppAuth {
  const user = useSyncExternalStore(subscribeDevUser, () => devUser);
  const login = useCallback(() => setDevUser(generateDevUser()), []);
  const logout = useCallback(async () => setDevUser(null), []);
  const simulateNewIdentity = useCallback(() => setDevUser(generateDevUser()), []);
  const getAccessToken = useCallback(async () => null, []);
  return { ready: true, authenticated: user != null, user, login, logout, mode: 'dev', simulateNewIdentity, getAccessToken };
}

/** The one seam for "how is the user logged in". Not the recovery condition. */
export function useAppAuth(): AppAuth {
  // isPrivyConfigured is fixed for the lifetime of the app (env var), so this
  // conditional hook call is stable across renders.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return isPrivyConfigured ? usePrivyAppAuth() : useDevAppAuth();
}
