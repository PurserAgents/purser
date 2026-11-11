// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";
import {PurserPasskey} from "../src/PurserPasskey.sol";
import {WebAuthn} from "../src/WebAuthn.sol";

/// @notice 4.2: owner approves a queued payment from a phone passkey (WebAuthn, P-256 checked on chain).
contract PasskeyTest is Base {
    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 passkeyPk = 0x9a55c3e7;
    PurserModule.Pay p;
    bytes paySig;
    bytes32 digest;

    function setUp() public {
        _deployUnit();
        _createAccount(address(usd));
        usd.mint(safe, 10_000e6);
        (uint256 x, uint256 y) = vm.publicKeyP256(passkeyPk);
        vm.prank(safe);
        passkey.setPasskey(x, y);
        vm.prank(safe);
        module.setApprover(address(passkey));
        p = _pay(address(usd), makeAddr("payee"), 700e6); // above approval threshold
        digest = _payDigest(p);
        paySig = _agentSig(digest);
        assertFalse(module.pay(p, paySig));
    }

    function _assertion(uint256 pk, bytes32 challenge, uint8 flags) internal pure returns (WebAuthn.Assertion memory a) {
        a.authenticatorData = abi.encodePacked(sha256("purser.fun"), flags, uint32(1));
        a.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            WebAuthn.base64Url(abi.encodePacked(challenge)),
            '","origin":"https://purser.fun","crossOrigin":false}'
        );
        a.typeIndex = 1;
        a.challengeIndex = 23;
        bytes32 message = sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, message);
        uint256 sv = uint256(s);
        if (sv > P256_N / 2) sv = P256_N - sv;
        a.r = uint256(r);
        a.s = sv;
    }

    function test_base64Url_vectors() public pure {
        assertEq(WebAuthn.base64Url("hello"), "aGVsbG8");
        assertEq(WebAuthn.base64Url(hex"fbff"), "-_8");
        assertEq(bytes(WebAuthn.base64Url(abi.encodePacked(bytes32(0)))).length, 43);
    }

    function test_passkeyApproval_thenPaymentRuns() public {
        passkey.approve(safe, digest, _assertion(passkeyPk, digest, 0x05));
        assertEq(uint8(module.intentState(safe, digest)), uint8(PurserModule.IntentState.Approved));
        assertTrue(module.pay(p, paySig));
        assertEq(usd.balanceOf(makeAddr("payee")), 700e6);
    }

    function test_passkeyReject() public {
        passkey.reject(safe, digest, _assertion(passkeyPk, passkey.rejectChallenge(digest), 0x05));
        vm.expectRevert(PurserModule.IntentWasRejected.selector);
        module.pay(p, paySig);
    }

    function test_approveAssertionCannotBeUsedToReject_andViceVersa() public {
        WebAuthn.Assertion memory a = _assertion(passkeyPk, digest, 0x05);
        vm.expectRevert(PurserPasskey.BadAssertion.selector);
        passkey.reject(safe, digest, a);
    }

    function test_wrongKey_refused() public {
        WebAuthn.Assertion memory a = _assertion(0x1234, digest, 0x05);
        vm.expectRevert(PurserPasskey.BadAssertion.selector);
        passkey.approve(safe, digest, a);
    }

    function test_otherDigest_refused() public {
        WebAuthn.Assertion memory a = _assertion(passkeyPk, bytes32(uint256(digest) ^ 1), 0x05);
        vm.expectRevert(PurserPasskey.BadAssertion.selector);
        passkey.approve(safe, digest, a);
    }

    function test_userPresenceRequired() public {
        WebAuthn.Assertion memory a = _assertion(passkeyPk, digest, 0x04);
        vm.expectRevert(PurserPasskey.BadAssertion.selector);
        passkey.approve(safe, digest, a);
    }

    function test_highS_refused() public {
        WebAuthn.Assertion memory a = _assertion(passkeyPk, digest, 0x05);
        a.s = P256_N - a.s;
        vm.expectRevert(PurserPasskey.BadAssertion.selector);
        passkey.approve(safe, digest, a);
    }

    function test_tamperedIndexes_refused() public {
        WebAuthn.Assertion memory a = _assertion(passkeyPk, digest, 0x05);
        a.challengeIndex = 0;
        vm.expectRevert(PurserPasskey.BadAssertion.selector);
        passkey.approve(safe, digest, a);
        a = _assertion(passkeyPk, digest, 0x05);
        a.typeIndex = 500;
        vm.expectRevert(PurserPasskey.BadAssertion.selector);
        passkey.approve(safe, digest, a);
    }

    function test_noPasskey_refused() public {
        vm.prank(safe);
        passkey.setPasskey(0, 0);
        WebAuthn.Assertion memory a = _assertion(passkeyPk, digest, 0x05);
        vm.expectRevert(PurserPasskey.NoPasskey.selector);
        passkey.approve(safe, digest, a);
    }

    function test_passkeyContractNotApprover_refused() public {
        vm.prank(safe);
        module.setApprover(address(0));
        WebAuthn.Assertion memory a = _assertion(passkeyPk, digest, 0x05);
        vm.expectRevert(PurserModule.NotOwner.selector);
        passkey.approve(safe, digest, a);
    }
}
