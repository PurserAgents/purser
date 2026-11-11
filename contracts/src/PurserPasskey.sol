// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "./WebAuthn.sol";

interface IPurserApprovals {
    function approveIntent(address safe, bytes32 digest) external;
    function rejectIntent(address safe, bytes32 digest) external;
}

/// @title PurserPasskey
/// @notice Lets an owner approve (or reject) a queued payment from a phone with a passkey. The owner registers the
///         passkey's P-256 public key for the Safe (a Safe transaction) and sets this contract as the account's
///         approver in PurserModule. Anyone may then submit the WebAuthn assertion; the signature is checked on
///         chain with the P-256 precompile, over the intent digest (approve) or keccak256("reject", digest).
contract PurserPasskey {
    IPurserApprovals public immutable MODULE;

    struct Key {
        uint256 x;
        uint256 y;
    }

    mapping(address safe => Key) public passkeys;

    event PasskeySet(address indexed safe, uint256 x, uint256 y);

    error NoPasskey();
    error BadAssertion();

    constructor(IPurserApprovals module) {
        MODULE = module;
    }

    /// @notice Called by the Safe (owner-signed Safe transaction). x = y = 0 removes the passkey.
    function setPasskey(uint256 x, uint256 y) external {
        passkeys[msg.sender] = Key(x, y);
        emit PasskeySet(msg.sender, x, y);
    }

    function approve(address safe, bytes32 digest, WebAuthn.Assertion calldata assertion) external {
        _check(safe, digest, assertion);
        MODULE.approveIntent(safe, digest);
    }

    function reject(address safe, bytes32 digest, WebAuthn.Assertion calldata assertion) external {
        _check(safe, rejectChallenge(digest), assertion);
        MODULE.rejectIntent(safe, digest);
    }

    function rejectChallenge(bytes32 digest) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("reject", digest));
    }

    function _check(address safe, bytes32 challenge, WebAuthn.Assertion calldata assertion) internal view {
        Key memory k = passkeys[safe];
        if (k.x == 0 && k.y == 0) revert NoPasskey();
        if (!WebAuthn.verify(challenge, assertion, k.x, k.y)) revert BadAssertion();
    }
}
