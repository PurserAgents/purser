// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";
import {PurserEscrow} from "../src/PurserEscrow.sol";
import {MockToken} from "./utils/Mocks.sol";

contract EthReenterPayee {
    PurserEscrow public escrow;
    uint256 public id;
    bool public tried;

    function set(PurserEscrow e, uint256 i) external {
        escrow = e;
        id = i;
    }

    function deliver(bytes32 h) external {
        escrow.deliver(id, h);
    }

    receive() external payable {
        if (!tried) {
            tried = true;
            escrow.claim(id); // second payout attempt
        }
    }
}

/// @notice 10.2: escrow for agent-to-agent invoices, with disputes and timeouts.
contract EscrowTest is Base {
    address payer;
    address payee;
    address arbiter;

    function setUp() public {
        _deployUnit();
        payer = makeAddr("payerEOA");
        payee = makeAddr("payee");
        arbiter = makeAddr("arbiter");
        usd.mint(payer, 1_000e6);
        vm.prank(payer);
        usd.approve(address(escrow), type(uint256).max);
        vm.warp(1_767_571_200);
    }

    function _fund(address arb, uint128 amount) internal returns (uint256) {
        vm.prank(payer);
        return escrow.fund(payee, arb, address(usd), amount, uint64(block.timestamp + 3 days), 1 days, bytes32("inv-1"));
    }

    function test_release_paysPayee() public {
        uint256 id = _fund(arbiter, 100e6);
        assertEq(usd.balanceOf(address(escrow)), 100e6);
        vm.prank(payee);
        escrow.deliver(id, keccak256("report.pdf"));
        vm.prank(payer);
        escrow.release(id);
        assertEq(usd.balanceOf(payee), 100e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
        vm.prank(payer);
        vm.expectRevert(PurserEscrow.WrongStatus.selector);
        escrow.release(id);
    }

    function test_claimAfterReviewWindow_noDispute() public {
        uint256 id = _fund(arbiter, 100e6);
        vm.prank(payee);
        escrow.deliver(id, keccak256("x"));
        vm.expectRevert(PurserEscrow.TooEarly.selector);
        escrow.claim(id);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(stranger);
        escrow.claim(id);
        assertEq(usd.balanceOf(payee), 100e6);
    }

    function test_refundAfterDeadline_whenNothingDelivered() public {
        uint256 id = _fund(arbiter, 100e6);
        vm.expectRevert(PurserEscrow.TooEarly.selector);
        escrow.refund(id);
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(payee);
        vm.expectRevert(PurserEscrow.TooEarly.selector); // late delivery is refused
        escrow.deliver(id, bytes32(0));
        escrow.refund(id);
        assertEq(usd.balanceOf(payer), 1_000e6);
    }

    function test_dispute_arbiterSplits() public {
        uint256 id = _fund(arbiter, 100e6);
        vm.prank(payee);
        escrow.deliver(id, keccak256("half done"));
        vm.prank(payer);
        escrow.dispute(id);
        vm.expectRevert(PurserEscrow.WrongStatus.selector);
        escrow.claim(id);
        vm.prank(payer);
        vm.expectRevert(PurserEscrow.NotAllowed.selector);
        escrow.resolve(id, 10_000);
        vm.prank(arbiter);
        escrow.resolve(id, 7_000);
        assertEq(usd.balanceOf(payee), 70e6);
        assertEq(usd.balanceOf(payer), 930e6);
    }

    function test_dispute_withoutArbiter_refundsPayer() public {
        uint256 id = _fund(address(0), 100e6);
        vm.prank(payee);
        escrow.deliver(id, bytes32("x"));
        vm.prank(payer);
        escrow.dispute(id);
        assertEq(usd.balanceOf(payer), 1_000e6);
        assertEq(uint8(escrow.getJob(id).status), uint8(PurserEscrow.Status.Refunded));
    }

    function test_dispute_outsideWindow_refused() public {
        uint256 id = _fund(arbiter, 100e6);
        vm.prank(payer);
        vm.expectRevert(PurserEscrow.WrongStatus.selector); // nothing delivered yet
        escrow.dispute(id);
        vm.prank(payee);
        escrow.deliver(id, bytes32("x"));
        vm.warp(block.timestamp + 2 days);
        vm.prank(payer);
        vm.expectRevert(PurserEscrow.WrongStatus.selector);
        escrow.dispute(id);
    }

    function test_stuckDispute_refundsAfterArbiterTimeout() public {
        uint256 id = _fund(arbiter, 100e6);
        vm.prank(payee);
        escrow.deliver(id, bytes32("x"));
        vm.prank(payer);
        escrow.dispute(id);
        vm.warp(block.timestamp + 1 days + 29 days);
        vm.expectRevert(PurserEscrow.TooEarly.selector);
        escrow.refund(id);
        vm.warp(block.timestamp + 2 days);
        escrow.refund(id);
        assertEq(usd.balanceOf(payer), 1_000e6);
    }

    function test_onlyPartiesAct() public {
        uint256 id = _fund(arbiter, 100e6);
        vm.prank(stranger);
        vm.expectRevert(PurserEscrow.NotAllowed.selector);
        escrow.deliver(id, bytes32(0));
        vm.prank(payee);
        vm.expectRevert(PurserEscrow.NotAllowed.selector);
        escrow.release(id);
        vm.prank(stranger);
        vm.expectRevert(PurserEscrow.NotAllowed.selector);
        escrow.dispute(id);
    }

    function test_badParams() public {
        vm.startPrank(payer);
        vm.expectRevert(PurserEscrow.BadParams.selector);
        escrow.fund(payer, arbiter, address(usd), 1, uint64(block.timestamp + 1), 1, 0);
        vm.expectRevert(PurserEscrow.BadParams.selector);
        escrow.fund(payee, payee, address(usd), 1, uint64(block.timestamp + 1), 1, 0);
        vm.expectRevert(PurserEscrow.BadParams.selector);
        escrow.fund(payee, arbiter, address(usd), 0, uint64(block.timestamp + 1), 1, 0);
        vm.expectRevert(PurserEscrow.BadParams.selector);
        escrow.fund(payee, arbiter, address(usd), 1, uint64(block.timestamp), 1, 0);
        vm.deal(payer, 1 ether);
        vm.expectRevert(PurserEscrow.BadParams.selector);
        escrow.fund{value: 1}(payee, arbiter, address(0), 2, uint64(block.timestamp + 1), 1, 0);
        vm.expectRevert(PurserEscrow.TransferFailed.selector);
        escrow.fund(payee, arbiter, address(0xdead), 1, uint64(block.timestamp + 1), 1, 0);
        vm.stopPrank();
    }

    function test_eth_job_and_reentrancy() public {
        EthReenterPayee evil = new EthReenterPayee();
        vm.deal(payer, 1 ether);
        vm.prank(payer);
        uint256 id = escrow.fund{value: 0.5 ether}(address(evil), arbiter, address(0), 0.5 ether, uint64(block.timestamp + 1 days), 1 hours, 0);
        evil.set(escrow, id);
        evil.deliver(bytes32("x"));
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(PurserEscrow.TransferFailed.selector); // the nested claim is refused, so the payout reverts
        escrow.claim(id);
        assertEq(address(escrow).balance, 0.5 ether);
    }

    function testFuzz_resolve_conservesFunds(uint16 bps, uint128 amount) public {
        bps = uint16(bound(bps, 0, 10_000));
        amount = uint128(bound(amount, 1, 1_000e6));
        uint256 id = _fund(arbiter, amount);
        vm.prank(payee);
        escrow.deliver(id, bytes32("x"));
        vm.prank(payer);
        escrow.dispute(id);
        vm.prank(arbiter);
        escrow.resolve(id, bps);
        assertEq(usd.balanceOf(payee) + usd.balanceOf(payer), 1_000e6);
        assertEq(usd.balanceOf(address(escrow)), 0);
    }

    /// The payer is a Purser account: the agent funds the job through the module with an exact allowance.
    function test_purserAccount_fundsThroughModule_countedAgainstBudget() public {
        _createAccount(address(usd));
        usd.mint(safe, 1_000e6);
        address[] memory list = new address[](1);
        list[0] = address(escrow);
        vm.prank(safe);
        module.setAllowed(list, true);
        bytes memory data = abi.encodeCall(PurserEscrow.fund, (payee, arbiter, address(usd), 200e6, uint64(block.timestamp + 1 days), 1 hours, bytes32("inv-2")));
        PurserModule.Call memory c = PurserModule.Call(safe, address(escrow), 0, data, address(usd), 200e6, nextNonce++, block.timestamp + 1 hours);
        assertTrue(module.call(c, _agentSig(_callDigest(c))));
        assertEq(usd.balanceOf(address(escrow)), 200e6);
        assertEq(usd.allowance(safe, address(escrow)), 0);
        assertEq(module.spentOnDay(safe, address(usd), block.timestamp / 1 days), 200.2e6);
        uint256 id = escrow.jobCount();
        assertEq(escrow.getJob(id).payer, safe);
        // the agent releases through the module too
        PurserModule.Call memory r = PurserModule.Call(safe, address(escrow), 0, abi.encodeCall(PurserEscrow.release, (id)), address(0), 0, nextNonce++, block.timestamp + 1 hours);
        assertTrue(module.call(r, _agentSig(_callDigest(r))));
        assertEq(usd.balanceOf(payee), 200e6);
    }
}
