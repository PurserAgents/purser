// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";
import {ISafe} from "../src/Interfaces.sol";
import {MockToken, MockRouter, AllowanceThief, Reenterer, MockMulticall} from "./utils/Mocks.sol";

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

/// @notice 4.6: attacks against the rules. Every test here is an attempt to move money the rules forbid.
contract AttacksTest is Base {
    address attacker;

    function setUp() public {
        _deployUnit();
        _createAccount(address(usd));
        usd.mint(safe, 100_000e6);
        vm.deal(safe, 100 ether);
        attacker = makeAddr("attacker");
    }

    function _allow(address t) internal {
        address[] memory list = new address[](1);
        list[0] = t;
        vm.prank(safe);
        module.setAllowed(list, true);
    }

    function _call(address target, uint256 value, bytes memory data, address spendToken, uint256 limit)
        internal
        returns (PurserModule.Call memory c, bytes memory sig)
    {
        c = PurserModule.Call(safe, target, value, data, spendToken, limit, nextNonce++, block.timestamp + 1 hours);
        sig = _agentSig(_callDigest(c));
    }

    // ------------------------------------------------------------------ delegatecall

    function test_attack_delegatecallViaMultiSend_fails() public {
        _allow(MULTISEND);
        bytes memory inner = abi.encodePacked(
            uint8(0), address(usd), uint256(0), uint256(68), abi.encodeCall(MockToken.transfer, (attacker, 50_000e6))
        );
        (PurserModule.Call memory c, bytes memory sig) =
            _call(MULTISEND, 0, abi.encodeCall(IMultiSend.multiSend, (inner)), address(0), 0);
        // the module always uses operation 0 (CALL); MultiSend refuses to run without delegatecall
        vm.expectCall(
            safe,
            abi.encodeCall(ISafe.execTransactionFromModuleReturnData, (MULTISEND, 0, c.data, uint8(0)))
        );
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.call(c, sig);
        assertEq(usd.balanceOf(attacker), 0);
    }

    function test_attack_callSafeItself_orModule_refused() public {
        vm.prank(safe);
        vm.expectRevert(PurserModule.BadConfig.selector);
        address[] memory list = new address[](1);
        list[0] = safe;
        module.setAllowed(list, true);
        list[0] = address(module);
        vm.prank(safe);
        vm.expectRevert(PurserModule.BadConfig.selector);
        module.setAllowed(list, true);
        (PurserModule.Call memory c, bytes memory sig) = _call(
            safe, 0, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", attacker, 1), address(0), 0
        );
        vm.expectRevert(PurserModule.TargetNotAllowed.selector);
        module.call(c, sig);
    }

    function test_attack_agentCannotReconfigure() public {
        PurserModule.Config memory cfg = _config();
        cfg.agent = attacker;
        vm.prank(agent);
        vm.expectRevert(PurserModule.NotInitialized.selector);
        module.setConfig(cfg);
        vm.prank(agent);
        vm.expectRevert(PurserModule.NotOwner.selector);
        module.approveIntent(safe, bytes32("x"));
    }

    // ------------------------------------------------------------------ approve then transferFrom

    function test_attack_directApproveOnEnabledToken_refused() public {
        _allow(address(usd));
        (PurserModule.Call memory c, bytes memory sig) =
            _call(address(usd), 0, abi.encodeCall(MockToken.approve, (attacker, type(uint256).max)), address(0), 0);
        vm.expectRevert(PurserModule.TargetNotAllowed.selector);
        module.call(c, sig);
    }

    function test_attack_approveSelectorsBlockedOnAnyTarget() public {
        MockToken other = new MockToken("Other", "OTH", 18);
        other.mint(safe, 1e24);
        _allow(address(other)); // owner allowlisted a token contract by mistake
        bytes[] memory payloads = new bytes[](5);
        payloads[0] = abi.encodeCall(MockToken.approve, (attacker, type(uint256).max));
        payloads[1] = abi.encodeCall(MockToken.transfer, (attacker, 1e24));
        payloads[2] = abi.encodeCall(MockToken.transferFrom, (safe, attacker, 1e24));
        payloads[3] = abi.encodeWithSignature("increaseAllowance(address,uint256)", attacker, 1e24);
        payloads[4] = abi.encodeWithSignature("setApprovalForAll(address,bool)", attacker, true);
        for (uint256 i; i < payloads.length; ++i) {
            (PurserModule.Call memory c, bytes memory sig) = _call(address(other), 0, payloads[i], address(0), 0);
            vm.expectRevert(PurserModule.SelectorBlocked.selector);
            module.call(c, sig);
        }
        assertEq(other.balanceOf(attacker), 0);
    }

    function test_attack_allowanceNeverOutlivesTheCall() public {
        AllowanceThief thief = new AllowanceThief();
        _allow(address(thief));
        (PurserModule.Call memory c, bytes memory sig) =
            _call(address(thief), 0, abi.encodeCall(AllowanceThief.pullNow, (address(usd), 10e6)), address(usd), 100e6);
        assertTrue(module.call(c, sig));
        assertEq(usd.allowance(safe, address(thief)), 0);
        vm.expectRevert(bytes("allowance"));
        thief.steal(address(usd), safe, 90e6);
    }

    function test_attack_preExistingOwnerApproval_stillCountedAgainstBudget() public {
        MockRouter router = new MockRouter();
        _allow(address(router));
        // the owner approved this router long ago, outside Purser
        _safeExec(safe, address(usd), 0, abi.encodeCall(MockToken.approve, (address(router), type(uint256).max)), 0);
        // agent tries to drain through it with no spend token declared
        (PurserModule.Call memory c, bytes memory sig) =
            _call(address(router), 0, abi.encodeCall(MockRouter.pull, (address(usd), 50_000e6)), address(0), 0);
        vm.expectRevert(PurserModule.OverMaxSingle.selector);
        module.call(c, sig);
        assertEq(usd.balanceOf(address(router)), 0);
    }

    // ------------------------------------------------------------------ multicall

    function test_attack_multicallCannotPullFromSafe() public {
        MockMulticall mc = new MockMulticall();
        _allow(address(mc));
        MockMulticall.C[] memory calls = new MockMulticall.C[](1);
        calls[0] = MockMulticall.C(address(usd), abi.encodeCall(MockToken.transferFrom, (safe, attacker, 1_000e6)));
        (PurserModule.Call memory c, bytes memory sig) =
            _call(address(mc), 0, abi.encodeCall(MockMulticall.aggregate, (calls)), address(0), 0);
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.call(c, sig);
        assertEq(usd.balanceOf(attacker), 0);
    }

    function test_attack_multicallWithGrantedAllowance_boundedAndCounted() public {
        MockMulticall mc = new MockMulticall();
        _allow(address(mc));
        MockMulticall.C[] memory calls = new MockMulticall.C[](2);
        calls[0] = MockMulticall.C(address(usd), abi.encodeCall(MockToken.transferFrom, (safe, attacker, 100e6)));
        calls[1] = MockMulticall.C(address(usd), abi.encodeCall(MockToken.transferFrom, (safe, attacker, 100e6)));
        (PurserModule.Call memory c, bytes memory sig) =
            _call(address(mc), 0, abi.encodeCall(MockMulticall.aggregate, (calls)), address(usd), 150e6);
        vm.expectRevert(PurserModule.ExecFailed.selector); // second pull exceeds the exact allowance
        module.call(c, sig);
        calls[1].data = abi.encodeCall(MockToken.transferFrom, (safe, attacker, 50e6));
        (c, sig) = _call(address(mc), 0, abi.encodeCall(MockMulticall.aggregate, (calls)), address(usd), 150e6);
        assertTrue(module.call(c, sig));
        assertEq(module.spentOnDay(safe, address(usd), block.timestamp / 1 days), 150e6 + 0.15e6);
        assertEq(usd.allowance(safe, address(mc)), 0);
    }

    // ------------------------------------------------------------------ re-entrancy

    function test_attack_reentrancyFromEthPayee() public {
        Reenterer r = new Reenterer();
        PurserModule.Pay memory second = _pay(ETH, attacker, 0.4 ether);
        r.arm(address(module), abi.encodeCall(PurserModule.pay, (second, _agentSig(_payDigest(second)))));
        PurserModule.Pay memory p = _pay(ETH, address(r), 0.1 ether);
        bytes memory sig = _agentSig(_payDigest(p));
        uint256 before = safe.balance;
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.pay(p, sig);
        assertEq(safe.balance, before);
        assertEq(attacker.balance, 0);
    }

    function test_attack_reentrancyFromCallTarget() public {
        Reenterer r = new Reenterer();
        _allow(address(r));
        PurserModule.Pay memory inner = _pay(address(usd), attacker, 100e6);
        r.arm(address(module), abi.encodeCall(PurserModule.pay, (inner, _agentSig(_payDigest(inner)))));
        (PurserModule.Call memory c, bytes memory sig) =
            _call(address(r), 0, abi.encodeCall(Reenterer.poke, ()), address(0), 0);
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.call(c, sig);
        assertEq(usd.balanceOf(attacker), 0);
    }

    function test_attack_reentrancyFromSplitRecipient() public {
        Reenterer r = new Reenterer();
        PurserModule.Pay memory inner = _pay(ETH, attacker, 0.1 ether);
        r.arm(address(module), abi.encodeCall(PurserModule.pay, (inner, _agentSig(_payDigest(inner)))));
        PurserModule.Split[] memory s = new PurserModule.Split[](1);
        s[0] = PurserModule.Split(address(r), 1_000);
        vm.prank(safe);
        module.setSplits(s);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.receiveETH{value: 1 ether}(safe, bytes32(0));
        assertEq(attacker.balance, 0);
    }

    // ------------------------------------------------------------------ replay and signatures

    function test_attack_nonceReplay() public {
        PurserModule.Pay memory p = _pay(address(usd), attacker, 10e6);
        bytes memory sig = _agentSig(_payDigest(p));
        assertTrue(module.pay(p, sig));
        vm.expectRevert(PurserModule.NonceUsed.selector);
        module.pay(p, sig);
        // same nonce, different intent
        p.amount = 11e6;
        bytes memory sig2 = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.NonceUsed.selector);
        module.pay(p, sig2);
    }

    function test_attack_crossAccountReplay() public {
        address first = safe;
        PurserModule.Pay memory p = _pay(address(usd), attacker, 10e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.prank(owner);
        address second = factory.createAccount(_owners(), 1, _setup(address(usd), ""), 2);
        usd.mint(second, 1_000e6);
        p.safe = second; // same agent key on both accounts
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, sig);
        p.safe = first;
        assertTrue(module.pay(p, sig));
    }

    function test_attack_crossChainReplay() public {
        PurserModule.Pay memory p = _pay(address(usd), attacker, 10e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.chainId(1);
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, sig);
    }

    function test_attack_malleableSignature_refused() public {
        PurserModule.Pay memory p = _pay(address(usd), attacker, 10e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, _payDigest(p));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, flipped);
        bytes memory badV = abi.encodePacked(r, s, uint8(v + 2));
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, badV);
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, abi.encodePacked(r, s));
    }

    function test_attack_strangerSignature_andExpired() public {
        PurserModule.Pay memory p = _pay(address(usd), attacker, 10e6);
        bytes memory bad = _sig(strangerPk, _payDigest(p));
        vm.expectRevert(PurserModule.BadSignature.selector);
        module.pay(p, bad);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.warp(p.deadline + 1);
        vm.expectRevert(PurserModule.Expired.selector);
        module.pay(p, sig);
    }

    function test_attack_extensionCalls() public {
        vm.prank(attacker);
        vm.expectRevert(PurserModule.NotExtension.selector);
        module.extPay(safe, address(usd), attacker, 1e6, bytes32(0));
        vm.prank(attacker);
        vm.expectRevert(PurserModule.NotExtension.selector);
        module.authorizeAgentOp(safe, bytes32(0), address(usd), 0, 1, block.timestamp, "");
        // an owner can switch the extension off
        vm.prank(safe);
        module.setExtension(address(recurring), false);
        vm.prank(address(recurring));
        vm.expectRevert(PurserModule.NotExtension.selector);
        module.extPay(safe, address(usd), attacker, 1e6, bytes32(0));
    }

    function test_attack_extensionStillBoundByRules() public {
        vm.prank(address(recurring));
        vm.expectRevert(PurserModule.OverMaxSingle.selector);
        module.extPay(safe, address(usd), attacker, 50_000e6, bytes32(0));
    }

    function test_attack_receiveToNotAToken() public {
        // the module only runs receiveWithAuthorization on tokens the owner marked receivable
        vm.expectRevert(PurserModule.NotReceivable.selector);
        module.receiveWithAuthorization(safe, attacker, attacker, 1, 0, 1, bytes32(0), "", bytes32(0), false);
    }

    // ------------------------------------------------------------------ fee rounding

    function testFuzz_feeRounding_safeLosesExactlyAmountPlusFee(uint32 amount) public {
        vm.assume(amount > 0 && amount <= 1_000e6);
        uint256 before = usd.balanceOf(safe);
        PurserModule.TokenRule memory r = _rule();
        r.approvalAbove = NO_CAP;
        vm.prank(safe);
        module.setTokenRule(address(usd), r);
        assertTrue(_doPay(address(usd), attacker, amount));
        uint256 fee = uint256(amount) * FEE_BPS / 10_000;
        assertEq(before - usd.balanceOf(safe), uint256(amount) + fee);
        assertEq(usd.balanceOf(feeRecipient), fee);
    }

    function testFuzz_budgetNeverExceeded(uint32[8] memory amounts) public {
        PurserModule.TokenRule memory r = _rule();
        r.daily = 3_000e6;
        r.approvalAbove = NO_CAP;
        r.perCounterpartyDaily = NO_CAP;
        vm.prank(safe);
        module.setTokenRule(address(usd), r);
        uint256 day = block.timestamp / 1 days;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 a = uint256(amounts[i]) % 1_000e6 + 1;
            PurserModule.Pay memory p = _pay(address(usd), attacker, a);
            bytes memory sig = _agentSig(_payDigest(p));
            try module.pay(p, sig) {} catch {}
            assertLe(module.spentOnDay(safe, address(usd), day), 3_000e6);
        }
        assertLe(usd.balanceOf(attacker), 3_000e6);
    }
}
