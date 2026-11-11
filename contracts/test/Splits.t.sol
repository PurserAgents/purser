// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";

/// @notice 9.2: revenue splits applied on arrival.
contract SplitsTest is Base {
    function setUp() public {
        _deployUnit();
        _createAccount(address(usd));
    }

    function _receive(uint256 amount, bytes32 nonce) internal {
        address payer = vm.addr(strangerPk);
        usd.mint(payer, amount);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usd.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(usd.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, safe, amount, 0, block.timestamp + 60, nonce))
            )
        );
        module.receiveWithAuthorization(safe, address(usd), payer, amount, 0, block.timestamp + 60, nonce, _sig(strangerPk, digest), bytes32(0), true);
    }

    /// Owner, developer, model provider and a co-worker agent each get their share; the rest stays; never more than arrived.
    function testFuzz_splits_shareExactly(uint96 amount, uint16 a, uint16 b, uint16 c) public {
        vm.assume(amount > 0);
        a = uint16(bound(a, 1, 4000));
        b = uint16(bound(b, 1, 3000));
        c = uint16(bound(c, 1, 3000));
        address[3] memory to = [makeAddr("developer"), makeAddr("provider"), makeAddr("coworker")];
        PurserModule.Split[] memory s = new PurserModule.Split[](3);
        s[0] = PurserModule.Split(to[0], a);
        s[1] = PurserModule.Split(to[1], b);
        s[2] = PurserModule.Split(to[2], c);
        vm.prank(safe);
        module.setSplits(s);
        _receive(amount, bytes32(uint256(amount)));
        uint256 paid = usd.balanceOf(to[0]) + usd.balanceOf(to[1]) + usd.balanceOf(to[2]);
        assertEq(usd.balanceOf(to[0]), uint256(amount) * a / 10_000);
        assertEq(usd.balanceOf(to[1]), uint256(amount) * b / 10_000);
        assertEq(usd.balanceOf(to[2]), uint256(amount) * c / 10_000);
        assertEq(usd.balanceOf(safe), uint256(amount) - paid);
        assertLe(paid, amount);
    }

    function test_splits_replaceAndClear() public {
        PurserModule.Split[] memory s = new PurserModule.Split[](1);
        s[0] = PurserModule.Split(makeAddr("dev"), 5_000);
        vm.prank(safe);
        module.setSplits(s);
        assertEq(module.getSplits(safe).length, 1);
        vm.prank(safe);
        module.setSplits(new PurserModule.Split[](0));
        assertEq(module.getSplits(safe).length, 0);
        _receive(100, bytes32("x"));
        assertEq(usd.balanceOf(safe), 100);
    }

    function test_splits_onlyTheSafe_noSelfOrZero() public {
        PurserModule.Split[] memory s = new PurserModule.Split[](1);
        s[0] = PurserModule.Split(makeAddr("dev"), 5_000);
        vm.prank(agent);
        vm.expectRevert(PurserModule.NotInitialized.selector);
        module.setSplits(s);
        s[0] = PurserModule.Split(safe, 5_000);
        vm.prank(safe);
        vm.expectRevert(PurserModule.BadConfig.selector);
        module.setSplits(s);
        s[0] = PurserModule.Split(address(0), 5_000);
        vm.prank(safe);
        vm.expectRevert(PurserModule.BadConfig.selector);
        module.setSplits(s);
    }

    function test_splits_tinyAmountRoundsDown() public {
        PurserModule.Split[] memory s = new PurserModule.Split[](1);
        s[0] = PurserModule.Split(makeAddr("dev"), 3_333);
        vm.prank(safe);
        module.setSplits(s);
        _receive(2, bytes32("tiny"));
        assertEq(usd.balanceOf(makeAddr("dev")), 0);
        assertEq(usd.balanceOf(safe), 2);
    }
}
