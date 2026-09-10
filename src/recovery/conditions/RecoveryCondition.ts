// Re-exports the condition union + per-condition helpers from one place, so
// UI code can do `import { describeCondition } from '.../conditions/RecoveryCondition'`
// without knowing which condition types exist.
export type {
  RecoveryCondition,
  EmailCondition,
  WorldIdCondition,
  ConditionInput,
  ConditionProof,
} from '../RecoveryProvider';

import type { RecoveryCondition } from '../RecoveryProvider';

export function describeCondition(condition: RecoveryCondition): string {
  switch (condition.type) {
    case 'email':
      return condition.emails.length === 1
        ? `email: ${condition.emails[0]}`
        : `${condition.threshold} of ${condition.emails.length} emails: ${condition.emails.join(', ')}`;
    case 'worldid':
      return `World ID (nullifier ${condition.nullifierHash.slice(0, 10)}…)`;
  }
}
