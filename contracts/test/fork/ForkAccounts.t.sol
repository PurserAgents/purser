// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IERC20Like} from "../utils/ForkBase.sol";
import {ISafeFull} from "../utils/Base.sol";
import {PurserModule} from "../../src/PurserModule.sol";
import {PurserFactory} from "../../src/PurserFactory.sol";
import {IIdentityRegistry} from "../../src/Interfaces.sol";
import {MockToken} from "../utils/Mocks.sol";

interface ISafeVersion {
    function VERSION() external view returns (string memory);
}

interface IProxyFactoryFork {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

interface IMultiSendFork {
    function multiSend(bytes memory transactions) external payable;
}

/// @notice 3.5 + 4.6 on a fork of chain 4663: the real Safe 1.4.1, ERC-8004 registry and USDG.
contract ForkAccountsTest is ForkBase {
    function setUp() public {
        _fork();
    }

    function test_fork_liveContractsAreWhatWeExpect() public view {
        assertEq(ISafeVersion(SAFE_SINGLETON).VERSION(), "1.4.1");
        assertEq(IERC20Like(USDG).symbol(), "USDG");
        assertEq(IERC20Like(USDG).decimals(), 6);
        assertEq(
            IERC20Like(USDG).DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("Global Dollar"),
                    keccak256("1"),
                    uint256(4663),
                    USDG
                )
            )
        );
    }

    function test_fork_createAccount_realSafe_realErc8004() public {
        address s = _createAccount(USDG);
        assertTrue(ISafeFull(s).isModuleEnabled(address(module)));
        assertTrue(ISafeFull(s).isOwner(owner));
        uint256 id = module.getAccount(s).agentId;
        assertGt(id, 0);
        assertEq(IIdentityRegistry(IDENTITY_REGISTRY).ownerOf(id), s, "the Safe owns the agent identity");
        assertEq(IIdentityRegistry(IDENTITY_REGISTRY).tokenURI(id), "https://purser.fun/agents/test.json");
    }

    function test_fork_attachExistingSafe() public {
        bytes memory init = abi.encodeCall(
            ISafeFull.setup, (_owners(), 1, address(0), "", FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        address s = IProxyFactoryFork(PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, init, uint256(keccak256("p")));
        safe = s;
        _safeExec(s, address(factory), 0, abi.encodeCall(PurserFactory.setupAccount, (_setup(USDG, "ipfs://agent"))), 1);
        assertTrue(ISafeFull(s).isModuleEnabled(address(module)));
        assertTrue(module.getAccount(s).initialized);
        assertEq(IIdentityRegistry(IDENTITY_REGISTRY).ownerOf(module.getAccount(s).agentId), s);
    }

    function test_fork_payUsdg_withFee() public {
        _createAccount(USDG);
        _fundUsdg(safe, 1_000e6);
        address payee = makeAddr("payee");
        assertTrue(_doPay(USDG, payee, 250e6));
        assertEq(IERC20Like(USDG).balanceOf(payee), 250e6);
        assertEq(IERC20Like(USDG).balanceOf(feeRecipient), 0.25e6);
        assertEq(IERC20Like(USDG).balanceOf(safe), 1_000e6 - 250.25e6);
    }

    function test_fork_payEth() public {
        _createAccount(USDG);
        vm.deal(safe, 1 ether);
        address payee = makeAddr("payee");
        assertTrue(_doPay(ETH, payee, 0.2 ether));
        assertEq(payee.balance, 0.2 ether);
    }

    /// The real Safe returns false (not revert) for a failed module call; the module must turn that into a revert.
    function test_fork_failedInnerTransfer_reverts() public {
        _createAccount(USDG);
        _fundUsdg(safe, 10e6);
        PurserModule.Pay memory p = _pay(USDG, makeAddr("payee"), 100e6);
        bytes memory sig = _agentSig(_payDigest(p));
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.pay(p, sig);
    }

    function test_fork_receiveWithAuthorization_realUsdg_withSplits() public {
        _createAccount(USDG);
        address dev = makeAddr("dev");
        PurserModule.Split[] memory sp = new PurserModule.Split[](1);
        sp[0] = PurserModule.Split(dev, 2_000);
        vm.prank(safe);
        module.setSplits(sp);
        uint256 payerPk = 0x7a1e5;
        address payer = vm.addr(payerPk);
        _fundUsdg(payer, 50e6);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _usdgReceiveSig(payerPk, safe, 50e6, vb, bytes32("x402-1"));
        module.receiveWithAuthorization(safe, USDG, payer, 50e6, 0, vb, bytes32("x402-1"), sig, bytes32("order"), false);
        assertEq(IERC20Like(USDG).balanceOf(dev), 10e6);
        assertEq(IERC20Like(USDG).balanceOf(safe), 40e6);
        assertEq(IERC20Like(USDG).balanceOf(payer), 0);
    }

    function test_fork_transferWithAuthorization_realUsdg() public {
        _createAccount(USDG);
        uint256 payerPk = 0x7a1e6;
        address payer = vm.addr(payerPk);
        _fundUsdg(payer, 3e6);
        uint256 vb = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Like(USDG).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
                        ),
                        payer,
                        safe,
                        3e6,
                        0,
                        vb,
                        bytes32("x402-2")
                    )
                )
            )
        );
        module.receiveWithAuthorization(
            safe, USDG, payer, 3e6, 0, vb, bytes32("x402-2"), _sig(payerPk, digest), bytes32(0), true
        );
        assertEq(IERC20Like(USDG).balanceOf(safe), 3e6);
    }

    function test_fork_attack_delegatecallMultiSend_realContract() public {
        _createAccount(USDG);
        _fundUsdg(safe, 1_000e6);
        address[] memory list = new address[](1);
        list[0] = MULTISEND;
        vm.prank(safe);
        module.setAllowed(list, true);
        address attacker = makeAddr("attacker");
        bytes memory inner = abi.encodePacked(
            uint8(0), USDG, uint256(0), uint256(68), abi.encodeCall(MockToken.transfer, (attacker, 1_000e6))
        );
        PurserModule.Call memory c = PurserModule.Call(
            safe,
            MULTISEND,
            0,
            abi.encodeCall(IMultiSendFork.multiSend, (inner)),
            address(0),
            0,
            nextNonce++,
            block.timestamp + 1 hours
        );
        bytes memory sig = _agentSig(_callDigest(c));
        vm.expectRevert(PurserModule.ExecFailed.selector);
        module.call(c, sig);
        assertEq(IERC20Like(USDG).balanceOf(attacker), 0);
    }

    function test_fork_recovery_realSafeOwnerManagement() public {
        _createAccount(USDG);
        vm.prank(safe);
        module.setGuardian(guardian, 1 days);
        address[] memory n = new address[](2);
        n[0] = owner2;
        n[1] = guardian;
        vm.prank(guardian);
        module.startRecovery(safe, n, 1);
        vm.warp(block.timestamp + 1 days);
        module.finishRecovery(safe, n, 1);
        assertFalse(ISafeFull(safe).isOwner(owner));
        assertTrue(ISafeFull(safe).isOwner(owner2));
        assertEq(ISafeFull(safe).getThreshold(), 1);
    }
}
