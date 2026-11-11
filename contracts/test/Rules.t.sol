// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base, ISafeFull} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";
import {MockRouter, MockVault} from "./utils/Mocks.sol";

contract RulesTest is Base {
    address payee;
    address payee2;

    function setUp() public {
        _deployUnit();
        _createAccount(address(usd));
        usd.mint(safe, 100_000e6);
        vm.deal(safe, 100 ether);
        payee = makeAddr("payee");
        payee2 = makeAddr("payee2");
        vm.warp(1_767_571_200 + 12 hours); // Monday 2026-01-05 12:00 UTC
    }

    function _setRule(PurserModule.TokenRule memory r) internal {
        vm.prank(safe);
        module.setTokenRule(address(usd), r);
    }

    function _setConfig(PurserModule.Config memory c) internal {
        vm.prank(safe);
        module.setConfig(c);
    }

    // ------------------------------------------------------------------ 4.1 budgets and limits

    function test_maxSingle() public {
        PurserModule.TokenRule memory r = _rule();
        r.maxSingle = 100e6;
        _setRule(r);
        assertTrue(_doPay(address(usd), payee, 100e6));
        PurserModule.Pay memory p = _pay(address(usd), payee, 100e6 + 1);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.OverMaxSingle.selector);
        module.pay(p, sig);
    }

    function test_dailyBudget_includesFee_resetsNextDay() public {
        PurserModule.TokenRule memory r = _rule();
        r.daily = 300e6;
        r.perCounterpartyDaily = NO_CAP;
        _setRule(r);
        assertTrue(_doPay(address(usd), payee, 200e6)); // + 0.2 fee
        PurserModule.Pay memory p = _pay(address(usd), payee, 99.8e6); // 200.2 + 99.8 + 0.0998 > 300
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.OverDaily.selector);
        module.pay(p, sig);
        assertTrue(_doPay(address(usd), payee, 99.7e6)); // 200.2 + 99.7 + 0.0997 = 299.9997
        assertEq(module.spentOnDay(safe, address(usd), block.timestamp / 1 days), 299.9997e6);
        vm.warp(block.timestamp + 1 days);
        assertTrue(_doPay(address(usd), payee, 200e6));
    }

    function test_weeklyBudget_mondayBoundary() public {
        PurserModule.TokenRule memory r = _rule();
        r.daily = 1_000e6;
        r.weekly = 1_500e6;
        r.perCounterpartyDaily = NO_CAP;
        r.approvalAbove = NO_CAP;
        _setRule(r);
        assertTrue(_doPay(address(usd), payee, 900e6)); // Monday
        vm.warp(block.timestamp + 5 days); // Saturday, same week
        PurserModule.Pay memory p = _pay(address(usd), payee, 900e6);
        p.deadline = block.timestamp + 10 days;
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.OverWeekly.selector);
        module.pay(p, sig);
        vm.warp(block.timestamp + 2 days); // next Monday
        assertTrue(module.pay(p, sig));
    }

    function test_perCounterpartyLimit_andOverride() public {
        PurserModule.TokenRule memory r = _rule();
        r.perCounterpartyDaily = 150e6;
        _setRule(r);
        assertTrue(_doPay(address(usd), payee, 100e6));
        PurserModule.Pay memory p = _pay(address(usd), payee, 60e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.OverCounterparty.selector);
        module.pay(p, sig);
        // another counterparty has its own allowance
        assertTrue(_doPay(address(usd), payee2, 150e6));
        // per-address override (team budgets)
        vm.prank(safe);
        module.setCounterpartyLimit(address(usd), payee, 400e6);
        assertTrue(module.pay(p, sig));
    }

    function test_timeWindow_hours() public {
        PurserModule.Config memory c = _config();
        c.hoursMask = uint24((1 << 9) | (1 << 10) | (1 << 11)); // 09:00-11:59 UTC
        _setConfig(c);
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.OutsideTimeWindow.selector); // 12:00
        module.pay(p, sig);
        vm.warp(block.timestamp - 2 hours); // 10:00
        assertTrue(module.pay(p, sig));
    }

    function test_timeWindow_weekdays() public {
        PurserModule.Config memory c = _config();
        c.daysMask = uint8(0x1F); // Monday to Friday
        _setConfig(c);
        assertTrue(_doPay(address(usd), payee, 1e6)); // Monday
        vm.warp(block.timestamp + 5 days); // Saturday
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.OutsideTimeWindow.selector);
        module.pay(p, sig);
    }

    function test_rateLimit_perMinute() public {
        PurserModule.Config memory c = _config();
        c.maxPerMinute = 3;
        _setConfig(c);
        vm.warp((block.timestamp / 60) * 60);
        for (uint256 i; i < 3; ++i) {
            assertTrue(_doPay(address(usd), payee, 1e6));
        }
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.RateLimited.selector);
        module.pay(p, sig);
        vm.warp(block.timestamp + 60);
        assertTrue(module.pay(p, sig));
    }

    function test_payeeAllowlist() public {
        PurserModule.Config memory c = _config();
        c.payeeAllowlist = true;
        _setConfig(c);
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.PayeeNotAllowed.selector);
        module.pay(p, sig);
        address[] memory list = new address[](1);
        list[0] = payee;
        vm.prank(safe);
        module.setAllowed(list, true);
        assertTrue(module.pay(p, sig));
    }

    function test_serviceAllowlist() public {
        PurserModule.Config memory c = _config();
        c.serviceAllowlist = true;
        _setConfig(c);
        bytes32 model = keccak256("model:frontier-1");
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        p.service = model;
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.ServiceNotAllowed.selector);
        module.pay(p, sig);
        bytes32[] memory s = new bytes32[](1);
        s[0] = model;
        vm.prank(safe);
        module.setServices(s, true);
        assertTrue(module.pay(p, sig));
    }

    function test_tokenNotEnabled() public {
        PurserModule.Pay memory p = _pay(address(0xBEEF), payee, 1);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.TokenNotEnabled.selector);
        module.pay(p, sig);
    }

    function test_remainingToday() public {
        PurserModule.TokenRule memory r = _rule();
        r.daily = 1_000e6;
        _setRule(r);
        assertTrue(_doPay(address(usd), payee, 100e6));
        assertEq(module.remainingToday(safe, address(usd)), 1_000e6 - 100.1e6);
    }

    function test_configOnlyBySafe() public {
        PurserModule.TokenRule memory r = _rule();
        vm.prank(owner); // an owner wallet alone is not the Safe
        vm.expectRevert(PurserModule.NotInitialized.selector);
        module.setTokenRule(address(usd), r);
        vm.prank(agent);
        vm.expectRevert(PurserModule.NotInitialized.selector);
        module.setConfig(_config());
    }

    function test_configThroughRealSafeTransaction() public {
        PurserModule.TokenRule memory r = _rule();
        r.maxSingle = 7e6;
        _safeExec(safe, address(module), 0, abi.encodeCall(PurserModule.setTokenRule, (address(usd), r)), 0);
        assertEq(module.getTokenRule(safe, address(usd)).maxSingle, 7e6);
    }

    // ------------------------------------------------------------------ 4.2 approvals

    function test_approval_queuesWithoutMovingFunds_thenOwnerApproves() public {
        PurserModule.Pay memory p = _pay(address(usd), payee, 600e6); // > 500 approvalAbove
        bytes32 d = _payDigest(p);
        bytes memory sig = _agentSig(d);
        uint256 before = usd.balanceOf(safe);
        assertFalse(module.pay(p, sig));
        assertEq(usd.balanceOf(safe), before);
        assertEq(uint8(module.intentState(safe, d)), uint8(PurserModule.IntentState.Pending));
        assertFalse(module.nonceUsed(safe, p.nonce));

        vm.prank(stranger);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.approveIntent(safe, d);
        vm.prank(agent);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.approveIntent(safe, d);

        vm.prank(owner);
        module.approveIntent(safe, d);
        assertTrue(module.pay(p, sig));
        assertEq(usd.balanceOf(payee), 600e6);
        vm.expectRevert(PurserModule.NonceUsed.selector);
        module.pay(p, sig);
    }

    function test_approval_rejected() public {
        PurserModule.Pay memory p = _pay(address(usd), payee, 600e6);
        bytes32 d = _payDigest(p);
        bytes memory sig = _agentSig(d);
        assertFalse(module.pay(p, sig));
        vm.prank(owner);
        module.rejectIntent(safe, d);
        vm.expectRevert(PurserModule.IntentWasRejected.selector);
        module.pay(p, sig);
        vm.prank(owner);
        vm.expectRevert(PurserModule.IntentWasRejected.selector);
        module.approveIntent(safe, d);
    }

    function test_approval_stillBoundByBudgets() public {
        PurserModule.TokenRule memory r = _rule();
        r.daily = 550e6;
        _setRule(r);
        PurserModule.Pay memory p = _pay(address(usd), payee, 600e6);
        bytes32 d = _payDigest(p);
        bytes memory sig = _agentSig(d);
        module.pay(p, sig);
        vm.prank(owner);
        module.approveIntent(safe, d);
        vm.expectRevert(PurserModule.OverDaily.selector);
        module.pay(p, sig);
    }

    // ------------------------------------------------------------------ 4.3 co-sign, firewall

    function test_cosign_aboveThreshold() public {
        PurserModule.Config memory c = _config();
        c.cosigner = cosigner;
        _setConfig(c);
        PurserModule.TokenRule memory r = _rule();
        r.cosignAbove = 50e6;
        _setRule(r);
        assertTrue(_doPay(address(usd), payee, 50e6)); // at threshold: agent alone
        PurserModule.Pay memory p = _pay(address(usd), payee, 51e6);
        bytes32 d = _payDigest(p);
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, _agentSig(d));
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, bytes.concat(_agentSig(d), _sig(strangerPk, d)));
        assertTrue(module.pay(p, bytes.concat(_agentSig(d), _sig(cosignerPk, d))));
    }

    function test_firewall_requiredOnEveryIntent() public {
        PurserModule.Config memory c = _config();
        c.firewall = firewall;
        _setConfig(c);
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        bytes32 d = _payDigest(p);
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, _agentSig(d));
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, bytes.concat(_agentSig(d), _sig(agentPk, d)));
        assertTrue(module.pay(p, bytes.concat(_agentSig(d), _sig(firewallPk, d))));
    }

    function test_cosignAndFirewall_order() public {
        PurserModule.Config memory c = _config();
        c.cosigner = cosigner;
        c.firewall = firewall;
        _setConfig(c);
        PurserModule.TokenRule memory r = _rule();
        r.cosignAbove = 0; // always
        _setRule(r);
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        bytes32 d = _payDigest(p);
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, bytes.concat(_agentSig(d), _sig(firewallPk, d), _sig(cosignerPk, d)));
        assertTrue(module.pay(p, bytes.concat(_agentSig(d), _sig(cosignerPk, d), _sig(firewallPk, d))));
    }

    // ------------------------------------------------------------------ 4.4 freeze

    function test_freeze_byOwner_instant_andUnfreeze() public {
        vm.prank(owner);
        module.freeze(safe);
        PurserModule.Pay memory p = _pay(address(usd), payee, 1e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.IsFrozen.selector);
        module.pay(p, sig);
        vm.prank(owner);
        module.unfreeze(safe);
        assertTrue(module.pay(p, sig));
    }

    function test_freeze_byWatchdog_butNeverUnfreeze() public {
        vm.prank(watchdog);
        module.freeze(safe);
        assertTrue(module.getAccount(safe).frozen);
        vm.prank(watchdog);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.unfreeze(safe);
    }

    function test_freeze_watchdogDisabled() public {
        PurserModule.Config memory c = _config();
        c.watchdog = address(0);
        _setConfig(c);
        vm.prank(watchdog);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.freeze(safe);
    }

    function test_freeze_strangersAndAgentCannot() public {
        vm.prank(stranger);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.freeze(safe);
        vm.prank(agent);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.unfreeze(safe);
    }

    function test_frozen_blocksCallsAndExtensions() public {
        vm.prank(owner);
        module.freeze(safe);
        vm.prank(address(recurring));
        vm.expectRevert(PurserModule.IsFrozen.selector);
        module.extPay(safe, address(usd), payee, 1e6, bytes32(0));
    }

    // ------------------------------------------------------------------ 4.5 recovery

    function _guardian() internal {
        vm.prank(safe);
        module.setGuardian(guardian, 2 days);
    }

    function test_recovery_fullFlow() public {
        _guardian();
        address[] memory n = new address[](2);
        n[0] = owner2;
        n[1] = stranger;
        vm.prank(guardian);
        module.startRecovery(safe, n, 2);
        vm.expectRevert(PurserModule.RecoveryNotReady.selector);
        module.finishRecovery(safe, n, 2);
        vm.warp(block.timestamp + 2 days);
        module.finishRecovery(safe, n, 2);
        ISafeFull s = ISafeFull(safe);
        assertFalse(s.isOwner(owner));
        assertTrue(s.isOwner(owner2));
        assertTrue(s.isOwner(stranger));
        assertEq(s.getOwners().length, 2);
        assertEq(s.getThreshold(), 2);
        // replay of a finished recovery
        vm.expectRevert(PurserModule.RecoveryNotReady.selector);
        module.finishRecovery(safe, n, 2);
    }

    function test_recovery_keepsExistingOwnerInNewSet() public {
        _guardian();
        address[] memory n = new address[](2);
        n[0] = owner;
        n[1] = owner2;
        vm.prank(guardian);
        module.startRecovery(safe, n, 1);
        vm.warp(block.timestamp + 2 days + 1);
        module.finishRecovery(safe, n, 1);
        assertTrue(ISafeFull(safe).isOwner(owner));
        assertTrue(ISafeFull(safe).isOwner(owner2));
    }

    function test_recovery_ownerCancels() public {
        _guardian();
        address[] memory n = new address[](1);
        n[0] = stranger;
        vm.prank(guardian);
        module.startRecovery(safe, n, 1);
        vm.prank(owner);
        module.cancelRecovery(safe);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(PurserModule.RecoveryNotReady.selector);
        module.finishRecovery(safe, n, 1);
        assertTrue(ISafeFull(safe).isOwner(owner));
    }

    function test_recovery_onlyGuardian_minDelay_wrongSet() public {
        vm.prank(safe);
        vm.expectRevert(PurserModule.BadConfig.selector);
        module.setGuardian(guardian, 1 hours);
        _guardian();
        address[] memory n = new address[](1);
        n[0] = stranger;
        vm.prank(stranger);
        vm.expectRevert(PurserModule.NotGuardian.selector);
        module.startRecovery(safe, n, 1);
        vm.prank(guardian);
        module.startRecovery(safe, n, 1);
        vm.warp(block.timestamp + 2 days);
        n[0] = guardian; // a different set than proposed
        vm.expectRevert(PurserModule.RecoveryNotReady.selector);
        module.finishRecovery(safe, n, 1);
        vm.prank(stranger);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.cancelRecovery(safe);
    }

    // ------------------------------------------------------------------ calls and treasury

    function test_call_spendToken_countsOutflow_resetsAllowance() public {
        MockRouter router = new MockRouter();
        address[] memory list = new address[](1);
        list[0] = address(router);
        vm.prank(safe);
        module.setAllowed(list, true);
        PurserModule.Call memory c = PurserModule.Call(
            safe,
            address(router),
            0,
            abi.encodeCall(MockRouter.pull, (address(usd), 100e6)),
            address(usd),
            100e6,
            nextNonce++,
            block.timestamp + 1 hours
        );
        assertTrue(module.call(c, _agentSig(_callDigest(c))));
        assertEq(usd.balanceOf(address(router)), 100e6);
        assertEq(usd.allowance(safe, address(router)), 0);
        assertEq(usd.balanceOf(feeRecipient), 0.1e6);
        assertEq(module.spentOnDay(safe, address(usd), block.timestamp / 1 days), 100.1e6);
    }

    function test_call_ethValue_countsAgainstEthBudget() public {
        MockRouter router = new MockRouter();
        address[] memory list = new address[](1);
        list[0] = address(router);
        vm.prank(safe);
        module.setAllowed(list, true);
        PurserModule.Call memory c = PurserModule.Call(
            safe, address(router), 0.3 ether, abi.encodeCall(MockRouter.takeEth, ()), address(0), 0, nextNonce++, block.timestamp + 1 hours
        );
        assertTrue(module.call(c, _agentSig(_callDigest(c))));
        assertEq(module.spentOnDay(safe, ETH, block.timestamp / 1 days), 0.3 ether + 0.0003 ether);
        c.value = 1.5 ether; // above maxSingle 1 ETH (and approval 0.5 ETH -> queued first)
        c.nonce = nextNonce++;
        bytes32 d = _callDigest(c);
        assertFalse(module.call(c, _agentSig(d)));
        vm.prank(owner);
        module.approveIntent(safe, d);
        vm.expectRevert(PurserModule.OverMaxSingle.selector);
        module.call(c, _agentSig(d));
    }

    function test_call_targetMustBeAllowlisted() public {
        MockRouter router = new MockRouter();
        PurserModule.Call memory c = PurserModule.Call(
            safe, address(router), 0, abi.encodeCall(MockRouter.noop, ()), address(0), 0, nextNonce++, block.timestamp + 1 hours
        );
        bytes memory sig = _agentSig(_callDigest(c));
        vm.expectRevert(PurserModule.TargetNotAllowed.selector);
        module.call(c, sig);
    }

    function test_treasury_depositWithdraw_keepLiquid() public {
        MockVault vault = new MockVault(address(usd));
        vm.prank(safe);
        module.setTreasuryVault(address(vault), true);
        PurserModule.TokenRule memory r = _rule();
        r.keepLiquid = 99_000e6;
        _setRule(r);
        PurserModule.Treasury memory t =
            PurserModule.Treasury(safe, address(vault), true, 1_000e6, 1_000e6, nextNonce++, block.timestamp + 1 hours);
        module.treasury(t, _agentSig(_treasuryDigest(t)));
        assertEq(vault.balanceOf(safe), 1_000e6);
        assertEq(usd.allowance(safe, address(vault)), 0);
        assertEq(module.spentOnDay(safe, address(usd), block.timestamp / 1 days), 0, "treasury is not spending");
        t.nonce = nextNonce++;
        t.assets = 1e6; // would go below keepLiquid
        bytes memory sig = _agentSig(_treasuryDigest(t));
        vm.expectRevert(PurserModule.KeepLiquid.selector);
        module.treasury(t, sig);
        // withdraw back by the agent
        t = PurserModule.Treasury(safe, address(vault), false, 400e6, 400e6, nextNonce++, block.timestamp + 1 hours);
        module.treasury(t, _agentSig(_treasuryDigest(t)));
        assertEq(vault.balanceOf(safe), 600e6);
        // owner withdraws directly even while frozen
        vm.prank(owner);
        module.freeze(safe);
        t = PurserModule.Treasury(safe, address(vault), false, 600e6, 600e6, 0, 0);
        vm.prank(owner);
        module.treasury(t, "");
        assertEq(vault.balanceOf(safe), 0);
    }

    function test_treasury_vaultMustBeAllowlisted() public {
        MockVault vault = new MockVault(address(usd));
        PurserModule.Treasury memory t =
            PurserModule.Treasury(safe, address(vault), true, 1e6, 1e6, nextNonce++, block.timestamp + 1 hours);
        bytes memory sig = _agentSig(_treasuryDigest(t));
        vm.expectRevert(PurserModule.VaultNotAllowed.selector);
        module.treasury(t, sig);
    }

    // ------------------------------------------------------------------ money in + splits (9.1)

    function _authSig(uint256 pk, address to, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usd.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usd.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), vm.addr(pk), to, value, 0, block.timestamp + 1 hours, nonce
                    )
                )
            )
        );
        return _sig(pk, digest);
    }

    function test_receiveWithAuthorization_appliesSplits() public {
        address dev = makeAddr("dev");
        address provider = makeAddr("provider");
        PurserModule.Split[] memory s = new PurserModule.Split[](2);
        s[0] = PurserModule.Split(dev, 1_000); // 10%
        s[1] = PurserModule.Split(provider, 2_500); // 25%
        vm.prank(safe);
        module.setSplits(s);
        address payer = vm.addr(strangerPk);
        usd.mint(payer, 100e6);
        uint256 before = usd.balanceOf(safe);
        bytes memory sig = _authSig(strangerPk, safe, 100e6, bytes32("n1"));
        module.receiveWithAuthorization(
            safe, address(usd), payer, 100e6, 0, block.timestamp + 1 hours, bytes32("n1"), sig, bytes32("order-1"), false);
        assertEq(usd.balanceOf(dev), 10e6);
        assertEq(usd.balanceOf(provider), 25e6);
        assertEq(usd.balanceOf(safe), before + 65e6);
        assertEq(module.spentOnDay(safe, address(usd), block.timestamp / 1 days), 0, "splits are not agent spending");
        // replay of the same authorization fails at the token
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.receiveWithAuthorization(
            safe, address(usd), payer, 100e6, 0, block.timestamp + 1 hours, bytes32("n1"), sig, bytes32("order-1"), false);
    }

    function test_receiveWithAuthorization_transferForm_x402Standard() public {
        address payer = vm.addr(strangerPk);
        usd.mint(payer, 5e6);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usd.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usd.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, safe, 5e6, 0, block.timestamp + 60, bytes32("t1")
                    )
                )
            )
        );
        uint256 before = usd.balanceOf(safe);
        module.receiveWithAuthorization(
            safe, address(usd), payer, 5e6, 0, block.timestamp + 60, bytes32("t1"), _sig(strangerPk, digest), bytes32(0), true
        );
        assertEq(usd.balanceOf(safe), before + 5e6);
    }

    function test_receiveETH_forwardsAndSplits() public {
        address dev = makeAddr("dev");
        PurserModule.Split[] memory s = new PurserModule.Split[](1);
        s[0] = PurserModule.Split(dev, 5_000);
        vm.prank(safe);
        module.setSplits(s);
        uint256 before = safe.balance;
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        module.receiveETH{value: 1 ether}(safe, bytes32("tip"));
        assertEq(dev.balance, 0.5 ether);
        assertEq(safe.balance, before + 0.5 ether);
        assertEq(address(module).balance, 0, "module never holds ETH");
    }

    function test_splits_validation() public {
        PurserModule.Split[] memory s = new PurserModule.Split[](2);
        s[0] = PurserModule.Split(payee, 6_000);
        s[1] = PurserModule.Split(payee2, 5_000);
        vm.prank(safe);
        vm.expectRevert(PurserModule.BadConfig.selector);
        module.setSplits(s);
        PurserModule.Split[] memory nine = new PurserModule.Split[](9);
        for (uint256 i; i < 9; ++i) {
            nine[i] = PurserModule.Split(address(uint160(1000 + i)), 1);
        }
        vm.prank(safe);
        vm.expectRevert(PurserModule.BadConfig.selector);
        module.setSplits(nine);
    }

    function test_receive_notReceivableToken() public {
        PurserModule.TokenRule memory r = _rule();
        r.receivable = false;
        _setRule(r);
        vm.expectRevert(PurserModule.NotReceivable.selector);
        module.receiveWithAuthorization(safe, address(usd), stranger, 1, 0, 1, bytes32(0), "", bytes32(0), false);
    }
}
