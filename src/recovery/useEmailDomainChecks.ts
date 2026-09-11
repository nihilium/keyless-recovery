// "Can this address actually be recovered?", asked while the user is still typing it.
//
// zkEmail proves an email by checking its DKIM signature against a registry of domain keys. A
// domain the registry has never seen cannot be proven, so a seal made against it produces a share
// nobody can ever open — and that failure would otherwise surface at *recovery* time, minutes into
// a ceremony, when nothing can be done about it. This is the only moment the check can help.
//
// Ported from ../forgot-my-password-ui/src/nh/useEmailDomainCheck.ts, with one difference that
// matters: this app registers up to five guardians at once, so the check runs over a set.
import { useEffect, useRef, useState } from 'react';
import {
  checkEmailDomain,
  domainOf,
  domainVerdict,
  type DkimDomainCheck,
  type DkimDomainVerdict,
} from '@nihilium/recovery-resolver-dkim';

const EMAIL_SERVICE_URL =
  (import.meta.env.VITE_NIHILIUM_EMAIL_SERVICE_URL as string | undefined) ?? 'https://zkemail.nihilium.io';

/** Where a user sends any email to get their domain's DKIM key into the registry. */
export const REGISTER_EMAIL = 'recovery@nihilium.io';

export type DomainCheckState =
  /** Nothing to check yet — the field is empty or not yet a plausible address. */
  | 'idle'
  | 'checking'
  /** The four verdicts a registry answer maps to (see the SDK's domainVerdict). */
  | DkimDomainVerdict
  /** The registry could not be reached. Not evidence either way; deliberately non-blocking. */
  | 'error';

export interface DomainCheck {
  state: DomainCheckState;
  domain?: string;
}

/**
 * States that must not reach a paid seal. `checking` is included so a fast typist cannot beat the
 * request to the button; `error` is not, because a transient outage is not evidence of anything.
 */
const BLOCKING: ReadonlySet<DomainCheckState> = new Set<DomainCheckState>([
  'unsupported',
  'needs_registration',
  'unverified',
  'checking',
]);

/** A plausible address to spend a request on: something@something.tld. */
function looksLikeAddress(email: string): boolean {
  const at = email.lastIndexOf('@');
  return at > 0 && /^[^\s@]+\.[^\s@.]{2,}$/.test(email.slice(at + 1).trim());
}

function distinctDomains(emails: string[]): string[] {
  const out: string[] = [];
  for (const email of emails) {
    if (!looksLikeAddress(email)) continue;
    const domain = domainOf(email);
    if (!out.includes(domain)) out.push(domain);
  }
  return out;
}

export interface DomainChecks {
  /** One entry per input, positionally. */
  checks: DomainCheck[];
  /** True while any guardian's answer is unusable for sealing — drives the Protect button. */
  blocking: boolean;
  recheck: () => void;
}

/**
 * Check every guardian domain at once.
 *
 * Answers are cached per *domain*, which pays off far more here than in the single-address case:
 * a five-guardian set is frequently five addresses at two or three domains, and editing the local
 * part of any of them costs no request at all.
 */
export function useEmailDomainChecks(emails: string[]): DomainChecks {
  const [results, setResults] = useState<Record<string, DomainCheckState>>({});
  const cache = useRef(new Map<string, DkimDomainCheck>());
  const [nonce, setNonce] = useState(0);
  const emailsKey = emails.join('\n');

  useEffect(() => {
    const domains = distinctDomains(emailsKey.split('\n'));

    // Paint cached answers immediately and drop domains that are no longer in the set, so a
    // corrected typo cannot leave its old verdict on screen.
    setResults(() => {
      const next: Record<string, DomainCheckState> = {};
      for (const domain of domains) {
        const cached = cache.current.get(domain);
        next[domain] = cached ? domainVerdict(cached) : 'checking';
      }
      return next;
    });

    const pending = domains.filter((domain) => !cache.current.has(domain));
    if (pending.length === 0) return;

    // Debounced, so a typed-out address is one request rather than one per keystroke.
    let live = true;
    const timer = setTimeout(() => {
      for (const domain of pending) {
        void checkEmailDomain(EMAIL_SERVICE_URL, domain)
          .then((result) => {
            cache.current.set(domain, result);
            if (live) setResults((prev) => ({ ...prev, [domain]: domainVerdict(result) }));
          })
          .catch((err) => {
            console.warn('Domain check failed', err);
            // Not cached: a transient outage should not stick to the domain for the session.
            if (live) setResults((prev) => ({ ...prev, [domain]: 'error' }));
          });
      }
    }, 500);

    return () => {
      // The address moved on before the answer landed; drop it rather than paint a stale verdict.
      live = false;
      clearTimeout(timer);
    };
  }, [emailsKey, nonce]);

  const checks: DomainCheck[] = emails.map((email) => {
    if (!looksLikeAddress(email)) return { state: 'idle' };
    const domain = domainOf(email);
    return { state: results[domain] ?? 'checking', domain };
  });

  return {
    checks,
    blocking: checks.some((check) => BLOCKING.has(check.state)),
    recheck: () => {
      for (const domain of distinctDomains(emails)) cache.current.delete(domain);
      setNonce((n) => n + 1);
    },
  };
}
