// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base, ISafeFull} from "./utils/Base.sol";
import {PurserModule} from "../src/PurserModule.sol";
import {PurserFactory} from "../src/PurserFactory.sol";
import {MockIdentityRegistry} from "./utils/Mocks.sol";

interface ISafeOwnerMgmt {
    function enableModule(address) external;
}

contract FactoryTest is Base {
    function setUp() public {
        _deployUnit();
    }

    function test_createAccount_safeOwnedByOwner_moduleEnabled_rulesWritten() public {
        address s = _createAccount(address(usd));
        ISafeFull sf = ISafeFull(s);
        assertTrue(sf.isOwner(owner));
        assertEq(sf.getOwners().length, 1);
        assertEq(sf.getThreshold(), 1);
        assertTrue(sf.isModuleEnabled(address(module)));
        PurserModule.Account memory a = module.getAccount(s);
        assertTrue(a.initialized);
        assertEq(a.config.agent, agent);
        assertFalse(sf.isOwner(agent), "agent is never a Safe owner");
        assertTrue(module.getTokenRule(s, address(usd)).enabled);
        assertTrue(module.extensionEnabled(s, address(recurring)));
        assertEq(module.getTokens(s).length, 1);
    }

    function test_createAccount_registersErc8004IdentityOwnedBySafe() public {
        address s = _createAccount(address(usd));
        uint256 id = module.getAccount(s).agentId;
        assertEq(id, 1);
        assertEq(MockIdentityRegistry(registry).ownerOf(id), s);
        assertEq(MockIdentityRegistry(registry).tokenURI(id), "https://purser.fun/agents/test.json");
    }

    function test_createAccount_noUri_noIdentity() public {
        PurserFactory.Setup memory st = _setup(address(usd), "");
        vm.prank(owner);
        address s = factory.createAccount(_owners(), 1, st, 7);
        assertEq(module.getAccount(s).agentId, 0);
        assertEq(MockIdentityRegistry(registry).count(), 0);
    }

    function test_predictAddress_matches() public {
        PurserFactory.Setup memory st = _setup(address(usd), "x");
        address predicted = factory.predictAddress(_owners(), 1, st, owner, 42);
        vm.prank(owner);
        address s = factory.createAccount(_owners(), 1, st, 42);
        assertEq(s, predicted);
    }

    function test_saltIsBoundToCreator_noFrontRunCollision() public {
        PurserFactory.Setup memory st = _setup(address(usd), "x");
        vm.prank(stranger);
        address a = factory.createAccount(_owners(), 1, st, 42);
        vm.prank(owner);
        address b = factory.createAccount(_owners(), 1, st, 42);
        assertTrue(a != b);
    }

    function test_setupAccount_directCall_reverts() public {
        PurserFactory.Setup memory st = _setup(address(usd), "");
        vm.expectRevert(PurserFactory.OnlyDelegateCall.selector);
        factory.setupAccount(st);
    }

    function test_attachExistingSafe_oneSafeTransaction() public {
        // A plain Safe the owner already has.
        bytes memory init = abi.encodeCall(
            ISafeFull.setup, (_owners(), 1, address(0), "", FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        address s = IProxyFactoryLike(PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, init, 99);
        assertFalse(ISafeFull(s).isModuleEnabled(address(module)));
        safe = s;
        // One Safe transaction: delegatecall into setupAccount.
        _safeExec(s, address(factory), 0, abi.encodeCall(PurserFactory.setupAccount, (_setup(address(usd), "u"))), 1);
        assertTrue(ISafeFull(s).isModuleEnabled(address(module)));
        assertTrue(module.getAccount(s).initialized);
        assertEq(module.getAccount(s).agentId, 1);
        assertEq(MockIdentityRegistry(registry).ownerOf(1), s);
    }

    function test_initializeTwice_reverts() public {
        address s = _createAccount(address(usd));
        PurserFactory.Setup memory st = _setup(address(usd), "");
        vm.prank(s);
        vm.expectRevert(PurserModule.AlreadyInitialized.selector);
        module.initialize(st.config, st.rules, st.allow, st.extensions);
    }

    function test_initialize_withoutModuleEnabled_reverts() public {
        bytes memory init = abi.encodeCall(
            ISafeFull.setup, (_owners(), 1, address(0), "", FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        address s = IProxyFactoryLike(PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, init, 5);
        PurserFactory.Setup memory st = _setup(address(usd), "");
        vm.prank(s);
        vm.expectRevert(PurserModule.ModuleNotEnabled.selector);
        module.initialize(st.config, st.rules, st.allow, st.extensions);
    }

    function test_badConfig_agentZero_reverts() public {
        PurserFactory.Setup memory st = _setup(address(usd), "");
        st.config.agent = address(0);
        vm.prank(owner);
        vm.expectRevert(); // bubbles through the Safe setup as a failed delegatecall
        factory.createAccount(_owners(), 1, st, 3);
    }

    // ------------------------------------------------------------------ fee (3.3)

    function test_fee_takenToImmutableRecipient_payeeGetsFullAmount() public {
        _createAccount(address(usd));
        usd.mint(safe, 1_000e6);
        address payee = makeAddr("payee");
        assertTrue(_doPay(address(usd), payee, 100e6));
        assertEq(usd.balanceOf(payee), 100e6);
        assertEq(usd.balanceOf(feeRecipient), 100e6 * FEE_BPS / 10_000);
        assertEq(usd.balanceOf(safe), 1_000e6 - 100e6 - 0.1e6);
    }

    function test_fee_eth() public {
        _createAccount(address(usd));
        vm.deal(safe, 2 ether);
        address payee = makeAddr("payee");
        assertTrue(_doPay(ETH, payee, 0.1 ether));
        assertEq(payee.balance, 0.1 ether);
        assertEq(feeRecipient.balance, 0.1 ether * FEE_BPS / 10_000);
    }

    function test_fee_constructorCap() public {
        vm.expectRevert(PurserModule.BadConfig.selector);
        new PurserModule(feeRecipient, 101);
        vm.expectRevert(PurserModule.BadConfig.selector);
        new PurserModule(address(0), 5);
        PurserModule m = new PurserModule(feeRecipient, 100);
        assertEq(m.FEE_BPS(), 100);
        PurserModule zero = new PurserModule(address(0), 0);
        assertEq(zero.feeFor(1e18), 0);
    }

    function testFuzz_fee_neverAboveCap(uint128 amount) public view {
        uint256 fee = module.feeFor(amount);
        assertLe(fee, uint256(amount) * module.MAX_FEE_BPS() / 10_000);
        assertEq(fee, uint256(amount) * FEE_BPS / 10_000);
    }

    /// Splitting one payment into parts never costs more fee than paying it at once (rounding is down).
    function testFuzz_fee_splitNeverPaysMore(uint64 a, uint64 b) public view {
        uint256 whole = module.feeFor(uint256(a) + b);
        assertLe(module.feeFor(a) + module.feeFor(b), whole);
    }
}

interface IProxyFactoryLike {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}
