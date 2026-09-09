// The validator that recovery installs as the account's new signer.
//
// NOT ZeroDev's ECDSAValidator: a Privy/Kernel account already has that installed as its root
// validator (it's in the account's own factoryData), and ERC-7579 validators reject a second
// onInstall for the same account — verified on Sepolia, it reverts `AlreadyInitialized` (0x93360fbf).
// The recovery module's only power is `installModule(TYPE_VALIDATOR, …)`, so it needs a validator
// the account is *not* already using.
//
// Rhinestone's OwnableValidator is deployed at the same address on every chain it supports
// (confirmed live on Sepolia) and installs cleanly on a Kernel account.
import { encodeAbiParameters, encodePacked, zeroAddress, type Address, type Hex } from "viem";

export const RECOVERY_VALIDATOR_ADDRESS: Address = "0x2483DA3A338895199E5e538530213157e931Bf06";

// Kernel v3.1's own `execute(bytes32,bytes)` — the selector every UserOp sent through a standard
// smart-account client carries. See the long comment below for why this has to be granted at
// install time.
const KERNEL_EXECUTE_SELECTOR: Hex = "0xe9ae5c53";

/**
 * What the recovery module hands to `installModule(TYPE_VALIDATOR, …)` on the account.
 *
 * Three layers, and all three are required:
 *  1. OwnableValidator.onInstall wants `abi.encode(uint256 threshold, address[] owners)`.
 *  2. Kernel does not forward that untouched — it reads
 *     `hook (20 bytes, packed) ++ abi.encode(installData, hookData, selectorData)` and passes only
 *     `installData` to the module. Skipping this layer makes Kernel read the first 20 bytes as a
 *     hook address and misparse the rest, reverting with empty data.
 *  3. `selectorData`: a *non-root* validator can only validate UserOps for selectors Kernel has
 *     explicitly allowed (`allowedSelectors[vId][selector]`). `installModule` sets that bit itself
 *     iff `selectorData` is exactly 4 bytes — the only other way to set it is an "enable mode"
 *     UserOp co-signed by the account's *current root validator*, which is exactly the key recovery
 *     assumes is gone. Without this, the recovered owner installs cleanly (`getOwners()` returns
 *     correctly) but can never actually sign a UserOp with it — every attempt reverts
 *     `InvalidValidator()`, since Kernel never has a reason to consult a validator it hasn't
 *     authorized for that call. Verified against Kernel v3.1's source
 *     (github.com/zerodevapp/kernel, tag v3.1, Kernel.sol#installModule).
 *
 * This makes the signed Intent Kernel-specific, which is fine while Kernel is the only supported
 * account type — a Nexus/Safe7579 build would use layer 1 alone.
 */
export function recoveryValidatorInitData(newOwner: Address): Hex {
  const ownableInit = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address[]" }],
    [1n, [newOwner]],
  );
  return encodePacked(
    ["address", "bytes"],
    [
      zeroAddress,
      encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }],
        [ownableInit, "0x", KERNEL_EXECUTE_SELECTOR],
      ),
    ],
  );
}
