// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";
import {PurserRecurring} from "../src/PurserRecurring.sol";

/// @notice 7.3: streams (pay per second, heartbeats) and subscriptions, all through the module's rules.
contract RecurringTest is Base {
    uint256 payeePk = 0x9a7ee;
    address payee;

    function setUp() public {
        _deployUnit();
        _createAccount(address(usd));
        usd.mint(safe, 100_000e6);
        payee = vm.addr(payeePk);
        vm.warp(1_767_571_200 + 12 hours);
    }

    function _streamSig(uint128 rate, uint64 dur, uint32 grace, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 op = recurring.streamOpHash(payee, address(usd), rate, dur, grace);
        return _agentSig(_agentOpDigest(safe, address(recurring), op, address(usd), uint256(rate) * dur, nonce, deadline));
    }

    function _createStream(uint128 rate, uint64 dur, uint32 grace) internal returns (uint256 id) {
        uint256 n = nextNonce++;
        uint256 d = block.timestamp + 1 hours;
        id = recurring.createStream(safe, payee, address(usd), rate, dur, grace, n, d, _streamSig(rate, dur, grace, n, d));
    }

    function _beatSig(uint256 id, uint64 upTo) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", recurring.DOMAIN_SEPARATOR(), keccak256(abi.encode(recurring.HEARTBEAT_TYPEHASH(), id, upTo)))
        );
        return _sig(payeePk, digest);
    }

    // ------------------------------------------------------------------ streams

    function test_stream_paysPerSecond_whileHeartbeatsArrive() public {
        uint256 t0 = vm.getBlockTimestamp();
        uint256 id = _createStream(1_000, 1 days, 60); // 0.001 USDG per second
        vm.warp(t0 + 30);
        recurring.heartbeat(id, uint64(t0 + 30), _beatSig(id, uint64(t0 + 30)));
        vm.warp(t0 + 60);
        (uint256 due,) = recurring.accrued(id);
        assertEq(due, 60 * 1_000);
        recurring.settle(id);
        assertEq(usd.balanceOf(payee), 60_000);
        assertEq(module.spentOnDay(safe, address(usd), block.timestamp / 1 days), 60_000 + 60);
    }

    function test_stream_stopsAccruingWhenPayeeStopsDelivering() public {
        uint256 id = _createStream(1_000, 1 days, 60);
        vm.warp(block.timestamp + 1 hours); // no heartbeat since creation
        (uint256 due,) = recurring.accrued(id);
        assertEq(due, 60 * 1_000, "only the grace period after the last heartbeat is paid");
        recurring.settle(id);
        vm.warp(block.timestamp + 1 hours);
        (due,) = recurring.accrued(id);
        assertEq(due, 0);
    }

    function test_stream_cappedAtMaxDuration() public {
        uint256 id = _createStream(1, 100, 1_000);
        vm.prank(payee);
        recurring.heartbeat(id, uint64(block.timestamp + 500), ""); // future beats are clamped to now
        vm.warp(block.timestamp + 50);
        vm.prank(payee);
        recurring.heartbeat(id, uint64(block.timestamp), "");
        vm.warp(block.timestamp + 10_000);
        (uint256 due,) = recurring.accrued(id);
        assertEq(due, 100);
    }

    function test_stream_stopByPayee_byOwner_byAgent_notByStranger() public {
        uint256 a = _createStream(10, 1 days, 600);
        vm.warp(block.timestamp + 100);
        vm.prank(stranger);
        vm.expectRevert(); // no valid agent signature
        recurring.stopStream(a, 0, 0, "");
        vm.prank(payee);
        recurring.stopStream(a, 0, 0, "");
        assertEq(usd.balanceOf(payee), 1_000, "stopping settles what is due");
        vm.warp(block.timestamp + 100);
        (uint256 due,) = recurring.accrued(a);
        assertEq(due, 0);

        uint256 b = _createStream(10, 1 days, 600);
        vm.prank(owner);
        recurring.stopStream(b, 0, 0, "");

        uint256 c = _createStream(10, 1 days, 600);
        uint256 n = nextNonce++;
        uint256 d = block.timestamp + 1 hours;
        bytes32 op = keccak256(abi.encode(recurring.STOP_TYPEHASH(), uint256(1), c));
        bytes memory sig = _agentSig(_agentOpDigest(safe, address(recurring), op, address(usd), 0, n, d));
        vm.prank(stranger); // anyone can relay the agent's signed stop
        recurring.stopStream(c, n, d, sig);
        (,,,,, uint64 end,,,) = recurring.streams(c);
        assertEq(end, block.timestamp);
    }

    function test_stream_payeeIsPurserAccount_itsAgentSignsHeartbeats() public {
        // a second account sells; its agent key signs heartbeats for the stream paid to its Safe
        vm.prank(owner);
        address seller = factory.createAccount(_owners(), 1, _setup(address(usd), ""), 77);
        uint256 n = nextNonce++;
        uint256 d = block.timestamp + 1 hours;
        bytes32 op = recurring.streamOpHash(seller, address(usd), 10, 1 days, 60);
        bytes memory sig = _agentSig(_agentOpDigest(safe, address(recurring), op, address(usd), 10 * 1 days, n, d));
        uint256 id = recurring.createStream(safe, seller, address(usd), 10, 1 days, 60, n, d, sig);
        uint64 upTo = uint64(vm.getBlockTimestamp());
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", recurring.DOMAIN_SEPARATOR(), keccak256(abi.encode(recurring.HEARTBEAT_TYPEHASH(), id, upTo)))
        );
        recurring.heartbeat(id, upTo, _sig(agentPk, digest)); // same agent key is the seller's agent in this setup
        bytes memory bad = _sig(strangerPk, digest);
        vm.expectRevert(PurserRecurring.BadSignature.selector);
        recurring.heartbeat(id, upTo, bad);
    }

    function test_stream_heartbeatMustBeFromPayee() public {
        uint256 id = _createStream(10, 1 days, 60);
        bytes memory forged = _sig(strangerPk, keccak256("x"));
        vm.expectRevert(PurserRecurring.BadSignature.selector);
        recurring.heartbeat(id, uint64(block.timestamp), forged);
    }

    function test_stream_settlementBoundByBudget() public {
        PurserModule.TokenRule memory r = _rule();
        r.daily = 100e6;
        r.approvalAbove = NO_CAP;
        vm.prank(safe);
        module.setTokenRule(address(usd), r);
        uint256 id = _createStream(5_000, 1 days, 1 days); // 0.005 USDG/s -> 432 USDG a day
        vm.prank(payee);
        recurring.heartbeat(id, uint64(block.timestamp), "");
        vm.warp(block.timestamp + 6 hours);
        vm.prank(payee);
        recurring.heartbeat(id, uint64(block.timestamp), "");
        vm.expectRevert(PurserModule.OverDaily.selector);
        recurring.settle(id);
    }

    function test_stream_bigTotal_queuesForApproval() public {
        // total = rate * duration = 864 USDG > 500 approval threshold
        uint128 rate = 10_000;
        uint64 dur = 1 days;
        uint256 n = nextNonce++;
        uint256 d = block.timestamp + 1 hours;
        bytes memory sig = _streamSig(rate, dur, 60, n, d);
        uint256 id = recurring.createStream(safe, payee, address(usd), rate, dur, 60, n, d, sig);
        assertEq(id, 0);
        bytes32 op = recurring.streamOpHash(payee, address(usd), rate, dur, 60);
        bytes32 digest = _agentOpDigest(safe, address(recurring), op, address(usd), uint256(rate) * dur, n, d);
        vm.prank(owner);
        module.approveIntent(safe, digest);
        id = recurring.createStream(safe, payee, address(usd), rate, dur, 60, n, d, sig);
        assertEq(id, 1);
    }

    function test_stream_frozenAccount_cannotSettle() public {
        uint256 id = _createStream(10, 1 days, 600);
        vm.warp(block.timestamp + 100);
        vm.prank(owner);
        module.freeze(safe);
        vm.expectRevert(PurserModule.IsFrozen.selector);
        recurring.settle(id);
    }

    function test_stream_badParams() public {
        uint256 n = nextNonce++;
        vm.expectRevert(PurserRecurring.BadParams.selector);
        recurring.createStream(safe, safe, address(usd), 1, 1, 1, n, block.timestamp, "");
        vm.expectRevert(PurserRecurring.BadParams.selector);
        recurring.createStream(safe, payee, address(usd), 0, 1, 1, n, block.timestamp, "");
    }

    // ------------------------------------------------------------------ subscriptions

    function _sub(uint128 amount, uint64 period, uint32 maxCharges) internal returns (uint256 id) {
        uint256 n = nextNonce++;
        uint256 d = block.timestamp + 1 hours;
        bytes32 op = recurring.subscriptionOpHash(payee, address(usd), amount, period, maxCharges);
        bytes memory sig = _agentSig(_agentOpDigest(safe, address(recurring), op, address(usd), uint256(amount) * maxCharges, n, d));
        id = recurring.createSubscription(safe, payee, address(usd), amount, period, maxCharges, n, d, sig);
    }

    function test_subscription_chargesFirstPeriod_thenWhenDue() public {
        uint256 id = _sub(20e6, 30 days, 12);
        assertEq(usd.balanceOf(payee), 20e6);
        vm.expectRevert(PurserRecurring.NotDue.selector);
        recurring.charge(id);
        vm.warp(block.timestamp + 30 days);
        recurring.charge(id);
        assertEq(usd.balanceOf(payee), 40e6);
    }

    function test_subscription_endsAfterMaxCharges() public {
        uint256 id = _sub(1e6, 1 days, 2);
        vm.warp(block.timestamp + 1 days);
        recurring.charge(id);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(PurserRecurring.NotDue.selector);
        recurring.charge(id);
        assertEq(usd.balanceOf(payee), 2e6);
    }

    function test_subscription_cancelByPayeeOrOwner() public {
        uint256 id = _sub(1e6, 1 days, 10);
        vm.prank(payee);
        recurring.cancelSubscription(id, 0, 0, "");
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(PurserRecurring.NotDue.selector);
        recurring.charge(id);
        uint256 id2 = _sub(1e6, 1 days, 10);
        vm.prank(owner);
        recurring.cancelSubscription(id2, 0, 0, "");
    }

    function test_subscription_minPeriod_andRules() public {
        uint256 n = nextNonce++;
        vm.expectRevert(PurserRecurring.BadParams.selector);
        recurring.createSubscription(safe, payee, address(usd), 1, 59 minutes, 1, n, block.timestamp, "");
        // a monthly plan above the single-payment cap cannot even start
        n = nextNonce++;
        uint256 d = block.timestamp + 1 hours;
        bytes32 op = recurring.subscriptionOpHash(payee, address(usd), 2_000e6, 30 days, 1);
        bytes memory sig = _agentSig(_agentOpDigest(safe, address(recurring), op, address(usd), 2_000e6, n, d));
        uint256 id = recurring.createSubscription(safe, payee, address(usd), 2_000e6, 30 days, 1, n, d, sig);
        assertEq(id, 0, "queued for approval: above the approval threshold");
    }

    function test_extensionDisabled_blocksEverything() public {
        uint256 id = _createStream(10, 1 days, 600);
        vm.prank(safe);
        module.setExtension(address(recurring), false);
        vm.warp(block.timestamp + 100);
        vm.expectRevert(PurserModule.NotExtension.selector);
        recurring.settle(id);
    }

    // ------------------------------------------------------------------ v2: a fresh firewall check on every payout

    function _useFirewall() internal {
        PurserModule.Config memory c = _config();
        c.firewall = firewall;
        vm.prank(safe);
        module.setConfig(c);
    }

    function _bothSigs(bytes32 digest) internal view returns (bytes memory) {
        return bytes.concat(_agentSig(digest), _sig(firewallPk, digest));
    }

    function _subFw(uint128 amount, uint64 period, uint32 maxCharges) internal returns (uint256 id) {
        uint256 n = nextNonce++;
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes32 op = recurring.subscriptionOpHash(payee, address(usd), amount, period, maxCharges);
        bytes memory sig = _bothSigs(_agentOpDigest(safe, address(recurring), op, address(usd), uint256(amount) * maxCharges, n, d));
        id = recurring.createSubscription(safe, payee, address(usd), amount, period, maxCharges, n, d, sig);
    }

    function _streamFw(uint128 rate, uint64 dur, uint32 grace) internal returns (uint256 id) {
        uint256 n = nextNonce++;
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes32 op = recurring.streamOpHash(payee, address(usd), rate, dur, grace);
        id = recurring.createStream(safe, payee, address(usd), rate, dur, grace, n, d, _bothSigs(_agentOpDigest(safe, address(recurring), op, address(usd), uint256(rate) * dur, n, d)));
    }

    function _fwSig(uint256 kind, uint256 id, uint256 from, uint256 maxAmount, uint256 deadline, uint256 pk) internal view returns (bytes memory) {
        return _sig(pk, recurring.chargeDigest(kind, id, from, maxAmount, deadline));
    }

    function test_v2_subscriptionCharge_needsAFreshFirewallSignature() public {
        _useFirewall();
        uint256 id = _subFw(5e6, 1 days, 5);
        assertEq(usd.balanceOf(payee), 5e6, "the first period is paid at creation, which the firewall signed");
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(PurserRecurring.FirewallRequired.selector);
        recurring.charge(id);
        (,,,,, uint64 due,,) = recurring.subscriptions(id);
        uint256 d = vm.getBlockTimestamp() + 10 minutes;
        bytes memory wrongKey = _fwSig(2, id, due, 5e6, d, agentPk);
        bytes memory good = _fwSig(2, id, due, 5e6, d, firewallPk);
        vm.expectRevert(PurserRecurring.BadSignature.selector);
        recurring.chargeWithFirewall(id, d, wrongKey);
        vm.prank(payee); // the payee may send it, but only with the firewall's signature
        recurring.chargeWithFirewall(id, d, good);
        assertEq(usd.balanceOf(payee), 10e6);
        // the same signature can never pay the next period
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(PurserRecurring.BadSignature.selector);
        recurring.chargeWithFirewall(id, vm.getBlockTimestamp() + 10 minutes, good);
        vm.expectRevert(PurserRecurring.Expired.selector);
        recurring.chargeWithFirewall(id, d, good);
        assertEq(usd.balanceOf(payee), 10e6);
    }

    function test_v2_streamPayout_needsTheFirewall_andIsCappedByIt() public {
        _useFirewall();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 id = _streamFw(1_000, 1 days, 600);
        vm.warp(t0 + 100);
        recurring.heartbeat(id, uint64(t0 + 100), _beatSig(id, uint64(t0 + 100)));
        vm.expectRevert(PurserRecurring.FirewallRequired.selector);
        recurring.settle(id);
        uint256 d = vm.getBlockTimestamp() + 10 minutes;
        bytes memory sig = _fwSig(1, id, t0, 40_000, d, firewallPk);
        recurring.settleWithFirewall(id, 40_000, d, sig);
        assertEq(usd.balanceOf(payee), 40_000, "paid only up to the amount the firewall signed for");
        vm.expectRevert(PurserRecurring.BadSignature.selector);
        recurring.settleWithFirewall(id, 40_000, d, sig); // used: the stream moved on
        (uint256 rest,) = recurring.accrued(id);
        assertEq(rest, 60_000, "the rest stays due");
        recurring.settleWithFirewall(id, rest, d, _fwSig(1, id, t0 + 40, rest, d, firewallPk));
        assertEq(usd.balanceOf(payee), 100_000);
    }

    function test_v2_stoppingAStream_paysNothingWithoutTheFirewall() public {
        _useFirewall();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 id = _streamFw(1_000, 1 days, 600);
        vm.warp(t0 + 50);
        vm.prank(payee);
        recurring.stopStream(id, 0, 0, "");
        assertEq(usd.balanceOf(payee), 0, "a payee stopping its own stream cannot pay itself past the firewall");
        (uint256 due,) = recurring.accrued(id);
        assertEq(due, 50_000);
        uint256 d = vm.getBlockTimestamp() + 10 minutes;
        recurring.settleWithFirewall(id, due, d, _fwSig(1, id, t0, due, d, firewallPk));
        assertEq(usd.balanceOf(payee), 50_000);
    }

    function test_v2_withoutAFirewall_nothingChanges() public {
        uint256 id = _sub(1e6, 1 days, 3);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        recurring.chargeWithFirewall(id, 0, ""); // no firewall key on the account: no signature needed
        vm.warp(vm.getBlockTimestamp() + 1 days);
        recurring.charge(id);
        assertEq(usd.balanceOf(payee), 3e6);
    }
}
