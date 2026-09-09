// Loss is modeled as identity discontinuity, not as "the passkey broke". A
// new sign-in yields a new userId -> new EOA -> new smart account, same as
// any genuinely new device/account would. In dev mode this is instant (see
// auth/login.ts's local identity generator); against real Privy it would
// mean authenticating as a different account.
import type { AppAuth } from '../auth/login';

export async function simulateLoss(auth: AppAuth): Promise<void> {
  if (auth.simulateNewIdentity) {
    // Atomic swap — avoids an intermediate "logged out" render that would
    // unmount (and reset) everything downstream of it.
    auth.simulateNewIdentity();
    return;
  }
  await auth.logout();
  auth.login();
}
