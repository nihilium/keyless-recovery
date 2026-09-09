// Stub condition demonstrating that "recovery condition" is not tied to
// email. No real World ID verification happens here — nullifierHash is
// caller-supplied and trusted as-is, matching the rest of this fictive build.
import type { Address } from 'viem';
import type { WorldIdCondition, ConditionInput, ConditionProof } from '../RecoveryProvider';

export function makeWorldIdCondition(nullifierHash: string): WorldIdCondition {
  return { type: 'worldid', nullifierHash };
}

export function worldIdLookupInput(nullifierHash: string): ConditionInput {
  return { type: 'worldid', nullifierHash };
}

export function worldIdProof(nullifierHash: string, claimantAddress?: Address): ConditionProof {
  return {
    type: 'worldid',
    proof: `stub-proof:${nullifierHash}`,
    ...(claimantAddress ? { claimantAddress } : {}),
  };
}
