// Today's "app recovery index" condition. Not the same as a Privy login
// email — this is an email the user opted into recovery with, tracked by the
// fictive provider's own index. See RecoveryProvider.ts for the shared types.
import type { Address } from 'viem';
import type { EmailCondition, ConditionInput, ConditionProof } from '../RecoveryProvider';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function makeEmailCondition(email: string): EmailCondition {
  return { type: 'email', email: normalizeEmail(email) };
}

export function emailLookupInput(email: string): ConditionInput {
  return { type: 'email', email: normalizeEmail(email) };
}

export function emailProof(email: string, claimantAddress?: Address): ConditionProof {
  return { type: 'email', email: normalizeEmail(email), ...(claimantAddress ? { claimantAddress } : {}) };
}
