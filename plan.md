# Recovery Framework — Implementation Plan

A Privy + EIP-7702 wallet-recovery demo built as a **framework with one swap seam**, so the
Nihilium backend drops in later with zero UI changes. Everything ships against a fictive
recovery provider first; adding Nihilium is a one-line binding change.

## Goal

Build a dev-gated lab + onboarding flow that demonstrates account recovery for an embedded
Privy wallet, structured so that:

- All UI/flows depend on a single `RecoveryProvider` interface, never a concrete impl.
- The fictive provider backs it today; `NihiliumRecoveryProvider` backs it later.
- Login method (passkey/email/social) is decoupled from the recovery **condition** (email today,
  World ID / zkEmail / zkPassport later).
- Loss is modeled as identity discontinuity (`simulateLoss()`), with passkey reset as one
  optional loss vehicle — not the core mechanic.
- No real on-chain transfers; recovery completion returns a simulated tx hash.

## Non-goals

- No live 7702 bundler dependency. Stub delegation status if the SDK isn't configured.
- No real fund movement. `complete()` returns `{ txHash, simulated: true }`.
- No Nihilium protocol work in this build — only the empty provider slot it will fill.
- Onboarding/lab are dev-gated unless onboarding is explicitly promoted to prod.

## Key decisions (resolve before Phase 0)

- [ ] **Passkeys:** keep as login + optional loss vehicle, or drop and use a "New user" button
      for `simulateLoss()`? Framework works either way; this only decides what the lab wires.
- [ ] **Interface fidelity:** shape `RecoveryProvider` to Nihilium's real client API (true
      drop-in, needs the real call shapes), or keep generic + reconcile with a thin adapter later?
- [ ] **Condition scope:** email-only, or ship `WorldIdCondition` alongside `EmailCondition`
      now (World is an ETHOnline sponsor; buys the "recovery ≠ login" story, costs demo surface)?

---

## The seam

Nothing in `flows/`, `dev/`, or components imports a concrete provider. They import the
interface and read the bound instance from context. Swapping backends = changing one line in
`RecoveryContext.tsx`.

```ts
// src/recovery/RecoveryProvider.ts — THE SEAM
interface RecoveryProvider {
  // SEAL — bind a condition to an account.
  //   fictive:  store {conditionRef -> account} in local index
  //   nihilium: create seal gated by condition; register rk as recovery authority on account
  register(input: { account: AccountRef; condition: RecoveryCondition }): Promise<RecoveryRegistration>;

  // LOOKUP — does a recovery exist for this input? (drives the email lookup panel)
  lookup(conditionInput: ConditionInput): Promise<RecoveryRecord | null>;

  // ARM — begin a recovery.
  //   fictive:  start stub timelock
  //   nihilium: satisfy condition -> unseal rk -> arm 7702 delegate
  initiate(record: RecoveryRecord, proof: ConditionProof): Promise<RecoveryHandle>;

  // STATUS — pending | timelocked(untilTs) | vetoed | complete
  //   fictive:  local state machine
  //   nihilium: on-chain delegate state + datastream
  status(handle: RecoveryHandle): Promise<RecoveryStatus>;

  // GRADUATED VETO (optional in stub)
  //   fictive:  local flags   nihilium: on-chain delegate calls
  pause?(handle: RecoveryHandle, authority: AuthorityRef): Promise<void>;
  resume?(handle: RecoveryHandle, authority: AuthorityRef): Promise<void>;
  abort?(handle: RecoveryHandle, authority: AuthorityRef): Promise<void>;

  // COMPLETE
  //   fictive:  fake tx hash + simulated:true
  //   nihilium: rk rotates control / moves funds
  complete(handle: RecoveryHandle): Promise<{ txHash: string; simulated: boolean }>;
}
```

```ts
// src/smartAccount/SmartAccountAdapter.ts — account seam (drives the badge)
interface SmartAccountAdapter {
  getAccount(): Promise<{ eoa: Address; smartAccount: Address }>;                 // canonical display = smartAccount
  getDelegationStatus(): Promise<'eoa' | '7702-delegated' | 'smart-wallet' | 'stub'>;
}
```

---

## File layout

```
src/
  recovery/
    RecoveryProvider.ts            # interface + shared types   ← DEFINE FIRST
    RecoveryContext.tsx            # binds exactly ONE provider  ← THE SWAP POINT
    providers/
      FictiveRecoveryProvider.ts   # implements RecoveryProvider (was fictiveRecoveryService)
      NihiliumRecoveryProvider.ts  # empty TODO stub — the slot filled later
    conditions/
      RecoveryCondition.ts         # union: email | worldid | zkemail | zkpassport
      EmailCondition.ts            # today's "app recovery index"
  smartAccount/
    SmartAccountAdapter.ts
    useAppSmartAccount.ts          # Privy EOA + smart account / 7702 status
    stub7702.ts                    # fallback delegation status if SDK 7702 absent
  flows/
    SignupOnboardingModal.tsx      # "Setting up account…" → ends on smart account addr + badge
    RecoveryOffer.tsx              # offer + stepper UI
    recoverFunds.ts                # calls provider.initiate/status/complete (was recoverFundsStub)
  auth/
    login.ts                       # Privy login (passkey/email/social) — swappable, not load-bearing
  dev/
    RecoveryLossLab.tsx            # was PasskeyLossLab — generalized
    lossSimulator.ts               # was passkeyLab — simulateLoss(); passkey is ONE impl
```

---

## Privy wiring notes

- Keep passkey as **login** (if kept per key decision). Login method is not load-bearing.
- Link email when the user **opts into recovery** (`useLinkAccount` / email link if already in app).
- If email link is **not** configured in the dashboard: store email only in the fictive index,
  labeled **"app recovery index, not Privy login."**
- Canonical display address = `smartAccount` from `useAppSmartAccount()`.
- Snapshot stores `{ userId, eoa, smartAccount, email, passkeys }` — this becomes the fictive
  provider's persisted index and later maps to a seal reference.
- Recovery **condition is independent of login** — email-index-while-passkey-login is the
  independence invariant, keep it on purpose.

---

## Phases

### Phase 0 — Define the seam
- [ ] `RecoveryProvider.ts`: interface + `RecoveryCondition`, `RecoveryRecord`, `RecoveryHandle`,
      `RecoveryStatus`, `AuthorityRef`, `ConditionProof` types.
- [ ] `SmartAccountAdapter.ts`: interface + delegation-status union.
- [ ] `RecoveryContext.tsx`: provider binding point (defaults to fictive).

### Phase 1 — Fictive provider
- [ ] `FictiveRecoveryProvider.ts` implements `RecoveryProvider` over a local index.
- [ ] `EmailCondition.ts` + `RecoveryCondition.ts`.
- [ ] Local persistence of the snapshot record.

### Phase 2 — Onboarding
- [ ] `SignupOnboardingModal.tsx`: visible **"Setting up account…"**, ends on a smart account
      address (real or 7702 stub) + **7702 / smart-wallet / stub badge**.
- [ ] `useAppSmartAccount.ts` + `stub7702.ts` for address + delegation status.
- [ ] Email lookup is a **separate function/call**, not inside Privy signup.

### Phase 3 — Loss lab
- [ ] `lossSimulator.ts`: `simulateLoss()` → new `userId` → new EOA → new smart account.
- [ ] Passkey reset wired as one loss vehicle (per key decision).
- [ ] After the new user/account appears, **auto-open the email lookup panel** (Scenario 2/3).

### Phase 4 — Recovery stepper
- [ ] `RecoveryOffer.tsx`: seeded email → recovery offer → stub stepper.
- [ ] `recoverFunds.ts`: calls `initiate` → `status` → `complete`; renders fake tx hash.
- [ ] (Optional) wire `pause`/`resume`/`abort` into the stepper to demo the graduated veto.

### Phase 5 — Display polish
- [ ] Smart account address + badge on main surface.
- [ ] Dev-gate lab + onboarding (unless onboarding promoted to prod).

### Later — Nihilium (out of scope here)
- [ ] Implement `NihiliumRecoveryProvider` against the same interface.
- [ ] Change one line in `RecoveryContext.tsx`. No UI edits.

---

## Acceptance criteria

- [ ] New signup shows onboarding with a visible "Setting up account…".
- [ ] Onboarding ends with a smart account address (real or 7702 stub) + delegation badge.
- [ ] Email lookup is a separate function/call, **not** inside Privy signup.
- [ ] Seeded email → recovery offer → stub stepper → fake tx hash.
- [ ] New `userId` + new smart account after loss simulation.
- [ ] Unlink last passkey still fails (Privy rule) — noted in the lab, not a core mechanic.
- [ ] No real on-chain transfers.
- [ ] Lab / onboarding gated to dev unless onboarding explicitly wanted in prod.
- [ ] Swapping to a stub `NihiliumRecoveryProvider` requires **no** changes outside
      `RecoveryContext.tsx`.

---

## Copy to hardcode

- "A new sign-in creates a new account. We can only move funds if this email was registered before."
  *(passkey variant: "A new passkey creates a new account…")*
- "Setting up account…"
- "Recovery is simulated. Funds are not moved on-chain in this build."
- "Unlinking in-app is not the same as deleting the passkey on the device."

---

## Build order

Seam (Phase 0) → fictive service + onboarding + lookup UI (Phases 1–2) → recovery stepper
(Phase 4, may precede display) → smart-account display (Phase 5). **Do not block on a live 7702
bundler** — stub delegation status if the SDK isn't configured.