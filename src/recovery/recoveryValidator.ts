// Mirrors server/src/kernelValidator.ts — the browser builds the Intent, so it needs the same
// encoding. See that file for why it's OwnableValidator rather than the ECDSA validator, and why
// the init data carries Kernel's hook envelope and a selector grant.
import { encodeAbiParameters, encodePacked, zeroAddress, type Address, type Hex } from 'viem';

// Kernel v3.1's own `execute(bytes32,bytes)` — the selector every UserOp sent through a standard
// smart-account client carries. Installing a *non-root* validator without also granting it this
// selector leaves it permanently unusable: Kernel's validateUserOp gates every non-root validator
// on `allowedSelectors[vId][selector]`, and the only other way to set that bit is an "enable mode"
// UserOp co-signed by the account's current root validator — exactly the key recovery assumes is
// gone. Verified against Kernel v3.1's source: `installModule` calls `_setSelector` iff a 4-byte
// `selectorData` trailer is present in `initData`.
const KERNEL_EXECUTE_SELECTOR: Hex = '0xe9ae5c53';

export function recoveryValidatorInitData(newOwner: Address): Hex {
  const ownableInit = encodeAbiParameters([{ type: 'uint256' }, { type: 'address[]' }], [1n, [newOwner]]);
  return encodePacked(
    ['address', 'bytes'],
    [
      zeroAddress,
      encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }],
        [ownableInit, '0x', KERNEL_EXECUTE_SELECTOR],
      ),
    ],
  );
}
