// Today's "app recovery index" condition. Not the same as a Privy login
// email — this is an email the user opted into recovery with, tracked by the
// fictive provider's own index. See RecoveryProvider.ts for the shared types.
import type { Address } from 'viem';
import type { EmailCondition, ConditionInput, ConditionProof } from '../RecoveryProvider';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The gates this app offers: n guardian emails, k of which must cooperate to recover. */
export const GUARDIAN_PRESETS = [
  { n: 1, k: 1 },
  { n: 3, k: 2 },
  { n: 5, k: 3 },
] as const;

export type GuardianPreset = (typeof GUARDIAN_PRESETS)[number];

/**
 * Two identical addresses in a 3-guardian set is a 2-of-3 with one point of failure, and nothing
 * downstream catches it: the quorum enforces distinct member *indices*, not distinct identities.
 */
export function findDuplicateEmail(emails: string[]): string | null {
  const seen = new Set<string>();
  for (const email of emails.map(normalizeEmail)) {
    if (seen.has(email)) return email;
    seen.add(email);
  }
  return null;
}

export function makeEmailCondition(emails: string[], threshold: number): EmailCondition {
  return { type: 'email', emails: emails.map(normalizeEmail), threshold };
}

export function emailLookupInput(email: string): ConditionInput {
  return { type: 'email', email: normalizeEmail(email) };
}

/** `emails` must name exactly the record's threshold — the quorum rejects any other count. */
export function emailProof(emails: string[], claimantAddress?: Address): ConditionProof {
  return {
    type: 'email',
    emails: emails.map(normalizeEmail),
    ...(claimantAddress ? { claimantAddress } : {}),
  };
}
