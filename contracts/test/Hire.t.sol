// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";
import {PurserEscrow} from "../src/PurserEscrow.sol";

/// @notice Phase 05, agents hire agents: the hire and escrow path between two Purser accounts, through the module.
///         The escrow is unchanged; these tests pin down what the marketplace relies on.
contract HireTest is Base {
    address buyer;
    address seller;
    bytes32 constant REF = keccak256("inv_hire");

    function setUp() public {
        _deployUnit();
        vm.warp(1_767_571_200);
        seller = _account(2);
        buyer = _createAccount(address(usd)); // the last one made is `safe`, used by the signing helpers
        usd.mint(buyer, 2_000e6);
        address[] memory list = new address[](1);
        list[0] = address(escrow);
        vm.prank(buyer);
        module.setAllowed(list, true);
        vm.prank(seller);
        module.setAllowed(list, true);
    }

    function _account(uint256 salt) internal returns (address s) {
        vm.prank(owner);
        s = factory.createAccount(_owners(), 1, _setup(address(usd), "https://purser.fun/agents/seller.json"), salt);
    }

    function _fundCall(address from, uint128 amount) internal returns (PurserModule.Call memory c) {
        bytes memory data = abi.encodeCall(PurserEscrow.fund, (seller, address(0), address(usd), amount, uint64(block.timestamp + 1 days), 1 hours, REF));
        c = PurserModule.Call(from, address(escrow), 0, data, address(usd), amount, nextNonce++, block.timestamp + 1 days);
    }

    function _escrowCall(address from, bytes memory data) internal returns (PurserModule.Call memory c) {
        c = PurserModule.Call(from, address(escrow), 0, data, address(0), 0, nextNonce++, block.timestamp + 1 hours);
    }

    function _run(PurserModule.Call memory c) internal returns (bool) {
        return module.call(c, _agentSig(_callDigest(c)));
    }

    function _hire(uint128 amount) internal returns (uint256 id) {
        assertTrue(_run(_fundCall(buyer, amount)));
        id = escrow.jobCount();
    }

    /// Above the owner's approval amount the hire is queued: no money moves until the owner approves the same intent.
    function test_hireAboveApproval_waitsForTheOwner() public {
        PurserModule.Call memory c = _fundCall(buyer, 600e6);
        bytes32 digest = _callDigest(c);
        bytes memory sig = _agentSig(digest);
        assertFalse(module.call(c, sig));
        assertEq(usd.balanceOf(address(escrow)), 0);
        assertEq(escrow.jobCount(), 0);
        vm.prank(stranger);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.approveIntent(buyer, digest);
        vm.prank(owner);
        module.approveIntent(buyer, digest);
        assertTrue(module.call(c, sig));
        assertEq(usd.balanceOf(address(escrow)), 600e6);
        assertEq(escrow.getJob(1).payer, buyer);
    }

    /// A hire the owner rejected can never fund the escrow, even with the agent's valid signature.
    function test_rejectedHire_neverFunds() public {
        PurserModule.Call memory c = _fundCall(buyer, 600e6);
        bytes32 digest = _callDigest(c);
        bytes memory sig = _agentSig(digest);
        assertFalse(module.call(c, sig));
        vm.prank(owner);
        module.rejectIntent(buyer, digest);
        vm.expectRevert(PurserModule.IntentWasRejected.selector);
        module.call(c, sig);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    /// Above the largest single payment the hire can never run: even after the owner approves it, the outflow is
    /// over the limit and the whole call reverts.
    function test_hireAboveLargestPayment_neverRuns() public {
        PurserModule.Call memory c = _fundCall(buyer, 1_001e6);
        bytes32 digest = _callDigest(c);
        bytes memory sig = _agentSig(digest);
        assertFalse(module.call(c, sig));
        vm.prank(owner);
        module.approveIntent(buyer, digest);
        vm.expectRevert(PurserModule.OverMaxSingle.selector);
        module.call(c, sig);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    /// Deliver, accept, and a second release through the module: the escrow refuses it and nothing moves twice.
    function test_doubleRelease_throughTheModule_refused() public {
        uint256 id = _hire(100e6);
        assertTrue(_run(_escrowCall(seller, abi.encodeCall(PurserEscrow.deliver, (id, keccak256("result"))))));
        assertTrue(_run(_escrowCall(buyer, abi.encodeCall(PurserEscrow.release, (id)))));
        assertEq(usd.balanceOf(seller), 100e6);
        PurserModule.Call memory again = _escrowCall(buyer, abi.encodeCall(PurserEscrow.release, (id)));
        bytes memory sig = _agentSig(_callDigest(again));
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.call(again, sig);
        assertEq(usd.balanceOf(seller), 100e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    /// The seller's own Safe cannot release the money it is owed, and cannot refund it to anyone early.
    function test_releaseByTheSeller_refused() public {
        uint256 id = _hire(100e6);
        PurserModule.Call memory r = _escrowCall(seller, abi.encodeCall(PurserEscrow.release, (id)));
        bytes memory sig = _agentSig(_callDigest(r));
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.call(r, sig);
        vm.expectRevert(PurserEscrow.TooEarly.selector);
        escrow.refund(id);
        assertEq(usd.balanceOf(address(escrow)), 100e6);
    }

    /// Nothing delivered: a refund only after the deadline, back to the buyer's Safe, and a late delivery is refused.
    function test_refundOnlyAfterTheDeadline() public {
        uint256 before = usd.balanceOf(buyer);
        uint256 id = _hire(100e6);
        vm.expectRevert(PurserEscrow.TooEarly.selector);
        escrow.refund(id);
        vm.warp(block.timestamp + 1 days + 1);
        PurserModule.Call memory late = _escrowCall(seller, abi.encodeCall(PurserEscrow.deliver, (id, keccak256("late"))));
        bytes memory sig = _agentSig(_callDigest(late));
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.call(late, sig);
        vm.prank(stranger);
        escrow.refund(id);
        assertEq(usd.balanceOf(buyer), before - 100e6 / 1_000); // only the module's fee on the hire stayed spent
    }

    /// The invoice reference is public: anyone can fund another job carrying it. Each job keeps its own payer, so the
    /// engine matches a job to an invoice by every term, never by the reference alone.
    function test_sameReference_isAnotherJob() public {
        uint256 id = _hire(100e6);
        usd.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usd.approve(address(escrow), 100e6);
        uint256 copy = escrow.fund(seller, address(0), address(usd), 100e6, uint64(block.timestamp + 1 days), 1 hours, REF);
        vm.stopPrank();
        assertTrue(copy != id);
        assertEq(escrow.getJob(copy).invoiceRef, escrow.getJob(id).invoiceRef);
        assertEq(escrow.getJob(copy).payer, stranger);
        assertEq(escrow.getJob(id).payer, buyer);
        vm.prank(stranger);
        vm.expectRevert(PurserEscrow.NotAllowed.selector);
        escrow.release(id);
    }
}
