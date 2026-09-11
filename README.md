# keyless-recovery

A Privy + EIP-7702/ERC-7579 wallet-recovery demo, built as a framework with one swap seam
(`src/recovery/RecoveryContext.tsx`). Two `RecoveryProvider` implementations exist:

- `FictiveRecoveryProvider` — local, `localStorage`-backed, no network calls, no real timelock, no
  real funds. `complete()` returns a fake tx hash with `simulated: true`. **Bound by default.**
- `NihiliumRecoveryProvider` — real, backed by [`recovery-sdk`](../recovery-sdk) on Ethereum Sepolia:
  a real Kernel (ZeroDev) smart account, a real deployed `RecoveryModule` (ERC-7579 executor +
  graduated veto), and a real zkEmail human-in-the-loop recovery ceremony.

## Where the work happens

**The recovery procedure runs entirely in the browser**, the same way
[`../forgot-my-password-ui`](../forgot-my-password-ui) does it. Sealing, the email round trip,
unsealing, and signing the EIP-712 recovery intent are all client-side; seals live in IndexedDB
(`src/recovery/browserSealStore.ts`) because recovery-sdk only ships a `node:fs` store.

`server/` is **only a transaction relayer**. It exists for the two things a browser genuinely can't
do, neither of which is ceremony logic:

- **Pay gas.** A just-recovered user has no funds. The module is designed for this —
  *"anyone may submit; the authority is the signature, not the sender."*
- **Hold the guardian keys.** `pause`/`abort` are `msg.sender`-gated on-chain, so those keys must
  not ship to a browser.

Everything else — including all on-chain *reads* (`stateOf`, `configOf`, `hashIntent`) — happens in
the browser against a public RPC.

The consequence, deliberately accepted: the Nihilium API key ships to the client
(`VITE_NIHILIUM_API_KEY`, via `NihiliumPaymentProviderClientAPIKEY_DO_NOT_USE`). That key is a spend
limit on sealing, not access to anyone's funds.

See [plan.md](plan.md) for the original fictive-build design and
`~/.claude/plans/i-want-to-use-snug-rainbow.md` for the full real-integration plan and research
notes (backend architecture, on-chain call shapes, the Kernel validator question, etc.).

## Running it (fictive mode — works out of the box)

```bash
npm install
npm run dev
```

By default there's no Privy app configured, so login falls back to a local dev identity
(a fresh random EOA generated in-browser — see `src/auth/login.ts`). This is enough to exercise
the whole flow: onboarding, opting into recovery, simulating loss, and running the recovery
stepper through to a fake tx hash.

To use real Privy login instead, copy `.env.example` to `.env.local` and set
`VITE_PRIVY_APP_ID` to your Privy dashboard app ID. (The app *secret* never belongs here — see
`server/.env.example`.)

## Going live (real Nihilium provider, Sepolia)

Requires the relayer (`server/`) running, for gas and the guardian keys — see "Where the work
happens" above.

```bash
cd server
npm install
cp .env.example .env   # fill in real values, see below
npm run dev            # listens on :8787
```

Before it's actually usable end to end:

1. **Privy Dashboard** — two separate things, both currently off:
   - **Smart wallets** (Wallets → Smart wallets): enable, provider = **Kernel**, add Sepolia with a
     bundler URL (e.g. Pimlico), ideally a paymaster. Until this is on there's no smart account to
     install the recovery module on; the UI says so instead of hanging, and refuses to start a
     (paid) seal it knows it can't finish.

     **The provider choice is load-bearing, not cosmetic.** The recovery module is an ERC-7579
     executor, so the account must actually implement `installModule`. Only **`kernel`** and
     **`nexus`** qualify among Privy's options. `light_account` (Alchemy), `coinbase_smart_wallet`,
     `biconomy` (v2) and `thirdweb` do not — the install UserOp reverts during simulation with the
     unhelpful `reason: 0x`, because it's calling a function the account doesn't have. `safe` only
     qualifies through the Safe7579 adapter, which isn't verifiable client-side. The app now checks
     `user.smartWallet.smartWalletType` up front and refuses with an explanation rather than letting
     you spend a seal and then fail on-chain.
   - **Social login** (Login methods): switch on whichever of Google / Apple / GitHub / Discord / X
     you want. That's the *only* place it needs doing — the app deliberately does not pass
     `loginMethods`, so Privy renders whatever the Dashboard has enabled. (Hardcoding the list
     overrides the Dashboard and shows buttons for disabled providers, which fail at click time with
     "Login with X not allowed" on a screen subtitled "Have you been invited?".)

   On social login and the recovery email: **Google and Apple always return one; GitHub, Discord and
   LinkedIn sometimes; X, Farcaster and Telegram never.** So the login email is only ever a *prefill*
   for the recovery field — the recovery condition stays independent of the login method.

   **Kernel wraps executor init data.** `installModule`'s `initData` is not forwarded to the module
   as-is on Kernel; it reads `hook (20 bytes, packed) ++ abi.encode(installData, hookData)`, and only
   `installData` reaches the module's `onInstall`. Passing the module's own init data directly makes
   Kernel read its first 20 bytes as a hook address and misparse the rest, reverting during
   simulation with an empty `reason: 0x`. `src/recovery/installRecoveryModule.ts` applies that
   wrapping for Kernel (and only for Kernel — Nexus/Safe7579 take init data as-is).

2. **Fund the relayer + 3 guardian wallets** with Sepolia ETH (`server/.env`). `npm run dev:server`
   prints all four addresses on boot.

3. Set `VITE_RECOVERY_PROVIDER=nihilium` in the frontend `.env` (default `fictive`). This one switch
   picks the provider *and* its capability flags — World ID disappears, a real smart account becomes
   required, and the guardian/veto panel turns on.

Verified: with the API key from `../forgot-my-password-ui`, the browser really does run the
ceremony — `api.nihilium.io/api/get-processors`, `request-processor-token`, and
`processor1.nihilium.io/request_seal` all fire from the page, and `seal()` completes. The only step
that then needs the Dashboard toggle is installing the module on-chain.

The recovery ceremony itself is genuinely slow (minutes) and human-in-the-loop — it sends a real
email and waits for a reply. There's no simulated fast-path; see plan.md for why.

## Recovery, and the one-seal-per-account rule

Recovery is reachable from the sign-in screen ("I lost my credentials") **without signing in** —
that's the point: you may have no session at all. It asks for two things: any *one* of the emails
the account registered, and **the address that should own the account afterwards**. Recovery
installs a new signing key on the recovered account owned by that address, so it is named
explicitly rather than inferred from whatever session happens to be open.

If the account is protected by more than one guardian, the lookup is followed by a third question:
**which k of them to use**. See "Guardian sets" below.

## Guardian sets — 1, 3 or 5 emails

Setup offers three gates, and they differ in what they survive rather than in how they work:

| Choice | Gate | Setup cost | Recovery cost |
|---|---|---|---|
| 1 email | 1-of-1 | 1 paid seal | 1 email round trip; no redundancy |
| 3 emails | 2-of-3 | 3 paid seals | 2 concurrent round trips; survives 1 lost inbox |
| 5 emails | 3-of-5 | 5 paid seals | 3 concurrent round trips; survives 2 lost inboxes |

All three run through `@nihilium/recovery-condition-quorum`, which Shamir-splits the root secret and
seals one share behind each email. **A quorum flattens to one seal and one recovery key**, which is
why none of this touches the on-chain module: it still stores exactly one `recoveryOwner`, the
`vaultId` is still the Privy user id, and IndexedDB still holds one blob per account.

The single-email case is a genuine 1-of-1 quorum, not a bypass — one code path for all three. The
SDK originally refused `k = 1` outright, since at threshold 1 every Shamir share *is* the secret;
that was relaxed to permit **1-of-1 only**, with 1-of-n for n > 1 still refused on both write and
read. See `../recovery-sdk/packages/shamir/src/shamir.ts`.

Two consequences worth knowing:

- **Sealing is paid, per guardian, and sends no email.** The human-in-the-loop round trip happens
  only at recovery. A run interrupted at guardian 4 of 5 resumes without re-buying the first three,
  but only within the same tab — the root secret is held in memory and never written to
  `localStorage`, so a page reload re-pays rather than persisting a secret.
- **Guardians must be distinct addresses.** The quorum enforces distinct member *indices*, not
  distinct identities, so three copies of one address would pass every check downstream and produce
  a "2-of-3" with a single point of failure. The app rejects duplicates itself.

There are now **three** different thresholds in play, and they are not the same thing:

1. `VITE_NIHILIUM_THRESHOLD` — Nihilium's *processor* k-of-n, who runs the sealing ceremony. The
   public registry lists one processor, so this stays `1`.
2. The **guardian** quorum above — which humans can recover.
3. `resumeThreshold` in the graduated veto — which guardians can resume a paused recovery. Still
   1-of-1 in this demo.

**Rotating the recovery key.** The module stores a single `recoveryOwner`, and `onInstall` reverts
with `AlreadyInstalled` if a config already exists — there is no setter. So replacing a recovery key
means **uninstall + install**, which `replaceRecoveryModule()` sends as *one UserOp with two calls*
so the account is never momentarily unprotected. `onUninstall` clears the key, the veto config and
any in-flight attempt, so the same operation also swaps in the current guardian set. The epoch
deliberately survives (it's replay protection), which keeps intents signed for the old key invalid.

Use the **Replace recovery** button for this. Sealing again *without* rotating the module is the one
thing that breaks recovery: it mints a key the installed module doesn't know, so the new (paid) seal
is orphaned and the ceremony ends in `BadSignature()` after the full email round trip. The app now
blocks that path, and `initiate()` compares the stored seal's `recoveryOwner` against the on-chain
one up front so a mismatch surfaces immediately rather than minutes later.

Seals are keyed by `vaultId`, so a rotation overwrites the previous seal for that account, and the
recorded `epoch` follows the account's on-chain epoch — a recovery bumps it, and the next seal is
derived against the new value.

## Which validator recovery installs

`executeRecovery`'s only power is `installModule(TYPE_VALIDATOR, …)` on the recovered account, so
the validator it installs has to be one the account is **not already using**. ZeroDev's
`ECDSAValidator` is exactly what a Privy/Kernel account already has as its root validator (it's in
the account's own `factoryData`), and ERC-7579 validators reject a second `onInstall` for the same
account — verified on Sepolia, it reverts `AlreadyInitialized` (`0x93360fbf`).

So recovery installs **Rhinestone's `OwnableValidator`** (`0x2483DA3A338895199E5e538530213157e931Bf06`,
live on Sepolia) with the recovered owner as its sole owner at threshold 1. Its init data carries
two layers, and both are needed:

1. `abi.encode(uint256 threshold, address[] owners)` — what `OwnableValidator.onInstall` reads.
2. Kernel's envelope, `hook (20 bytes, packed) ++ abi.encode(installData, hookData)` — the same
   wrapping the executor install needs. Without it Kernel reads the first 20 bytes as a hook address
   and reverts with empty data.

Because layer 2 is baked into the signed `Intent`, the intent is Kernel-specific. That's fine while
Kernel is the only supported account type; a Nexus/Safe7579 build would use layer 1 alone.

## Controlling an account after recovery

Recovery installs **OwnableValidator** on the account with the recovered owner. That validator can
validate UserOps, so the recovered owner drives the account directly — `src/recovery/recoveredAccount.ts`
builds a Kernel client pointed at the *existing* account address with `validatorAddress` set to
OwnableValidator. No redeploy, and no Privy smart wallet involved (Privy only provisions those for
embedded wallets, which is why an external-EOA login gets none). At threshold 1 OwnableValidator's
signature is a plain 65-byte ECDSA signature — the same shape Kernel's own ECDSA validator uses — so
`permissionless` signs it correctly with no custom code.

**Discovery is backend-answered, not browser-local.** `GET /api/accounts/by-owner?address=0x…`
cross-references `RecoveryExecuted` events with `OwnableValidator.getOwners()` to answer "does this
wallet control a recovered smart account?" — so signing in with that wallet surfaces the account from
*any* browser or device, which is the point of having recovered it. (An earlier version remembered it
in `localStorage`, which only worked on the machine that ran the ceremony.)

The wallet then shows a **Recovered account** card: balance, the recovered owner, an arbitrary ETH
send form, and a "Revoke old key" action.

**Kernel routes validation by nonce, and permissionless can't express this case.** Kernel picks the
validator from the nonce key — `mode(1) ++ validationType(1) ++ validator(20) ++ key(2)` — and
permissionless's `getNonceKeyWithEncoding` hardcodes `validationType = ROOT (0x00)`, assuming the
validator you give it is the account's root. Ours isn't: recovery *installed* OwnableValidator
alongside the existing root, so a ROOT-typed nonce makes Kernel verify against the old Privy
validator and reject with `AA24 signature error`. `recoveredAccount.ts` builds the nonce itself with
type `0x01` (VALIDATOR) and passes it explicitly to `sendUserOperation`.

Two gas details that bite otherwise. The client must supply `maxFeePerGas`/`maxPriorityFeePerGas` —
viem doesn't fill them in, and the bundler rejects the op with a confusing
`eth_estimateUserOperationGas does not exist` wrapping a validation error about the missing fields;
`recoveredAccount.ts` asks the bundler for its own prices via `pimlico_getUserOperationGasPrice` and
falls back to chain fees. And since the account pays its own gas (no paymaster), the whole balance is
never sendable — the card keeps 0.001 ETH back and offers a **Max** button, because sending the full
balance leaves nothing to pay the prefund and fails validation.

**Recovery does not revoke the old key.** It *adds* a validator; the module deliberately never
uninstalls the superseded one (removing a module from an ERC-7579 sentinel list needs a correct
predecessor pointer and bricks the list if it's wrong). On Kernel the superseded validator is the
account's **root** validator, and uninstalling a root validator reverts with
`RootValidatorCannotBeRemoved()` (verified on Sepolia). The supported move is Kernel's
`changeRootValidator`, promoting the recovered validator to root — which is what "Revoke old key"
does. Until then, both the pre-recovery key and the recovered key control the account.

## Admin dashboard

A separate, token-gated path (`/admin`, not linked from the main app) watches **on-chain
`RecoveryInitiated` events** and shows each account's live `stateOf`, with pause/resume/abort
buttons. Reading from the chain rather than server memory means it sees every recovery regardless of
which browser started it, and survives a restart. The relayer signs with its own guardian keys, so
the operator never needs a wallet. Gated by `ADMIN_TOKEN` (`server/.env`).

## What's dev-only

The "Recovery loss lab" (the `New user (simulate loss)` button and its embedded recovery-offer
panel) only renders in dev builds (`import.meta.env.DEV`) — it's gone from a production build
unless explicitly promoted.

## The seam

`src/recovery/RecoveryProvider.ts` defines the interface; `src/recovery/RecoveryContext.tsx` binds
exactly one implementation. Nothing under `flows/`, `dev/`, or `components/` imports a concrete
provider — only the interface.
