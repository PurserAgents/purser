// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PurserModule} from "../../src/PurserModule.sol";
import {PurserFactory} from "../../src/PurserFactory.sol";
import {PurserRecurring} from "../../src/PurserRecurring.sol";
import {PurserEscrow} from "../../src/PurserEscrow.sol";
import {PurserPasskey, IPurserApprovals} from "../../src/PurserPasskey.sol";
import {MockToken, MockIdentityRegistry} from "./Mocks.sol";

interface ISafeFull {
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address) external view returns (bool);
    function isModuleEnabled(address) external view returns (bool);
    function nonce() external view returns (uint256);
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

interface IProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
}

/// @notice Shared setup. Unit tests run the real Safe 1.4.1 bytecode (copied from chain 4663 into
///         test/fixtures) at its canonical addresses, so no network is needed.
abstract contract Base is Test {
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address constant MULTISEND = 0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526;
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    address constant ETH = address(0);
    uint128 constant NO_CAP = type(uint128).max;
    uint256 constant FEE_BPS = 10; // 0.1%

    PurserModule module;
    PurserFactory factory;
    PurserRecurring recurring;
    PurserEscrow escrow;
    PurserPasskey passkey;
    MockToken usd;
    address registry;

    uint256 ownerPk = 0xB0B0B0;
    uint256 owner2Pk = 0xB0B0B1;
    uint256 agentPk = 0xA6E471;
    uint256 cosignerPk = 0xC051;
    uint256 firewallPk = 0xF12E;
    uint256 watchdogPk = 0xD06;
    uint256 guardianPk = 0x6A2D;
    uint256 strangerPk = 0x5772;
    address owner;
    address owner2;
    address agent;
    address cosigner;
    address firewall;
    address watchdog;
    address guardian;
    address stranger;
    address feeRecipient;
    address safe;
    uint256 nextNonce = 1;

    function _labels() internal {
        owner = vm.addr(ownerPk);
        owner2 = vm.addr(owner2Pk);
        agent = vm.addr(agentPk);
        cosigner = vm.addr(cosignerPk);
        firewall = vm.addr(firewallPk);
        watchdog = vm.addr(watchdogPk);
        guardian = vm.addr(guardianPk);
        stranger = vm.addr(strangerPk);
        feeRecipient = makeAddr("feeRecipient");
        vm.label(owner, "owner");
        vm.label(agent, "agent");
    }

    function _etchSafe() internal {
        vm.etch(SAFE_SINGLETON, _fixture("safe"));
        vm.etch(PROXY_FACTORY, _fixture("factory"));
        vm.etch(FALLBACK_HANDLER, _fixture("fallback"));
        vm.etch(MULTISEND, _fixture("multisend"));
        vm.etch(MULTISEND_CALL_ONLY, _fixture("multisendcallonly"));
    }

    function _fixture(string memory name) internal view returns (bytes memory) {
        return vm.parseBytes(vm.trim(vm.readFile(string.concat("test/fixtures/", name, ".hex"))));
    }

    /// @dev Unit-test world: real Safe bytecode, mock token and registry.
    function _deployUnit() internal {
        _labels();
        _etchSafe();
        usd = new MockToken("Global Dollar", "USDG", 6);
        registry = address(new MockIdentityRegistry());
        _deployPurser(registry);
    }

    function _deployPurser(address identityRegistry) internal {
        module = new PurserModule(feeRecipient, FEE_BPS);
        factory = new PurserFactory(address(module), SAFE_SINGLETON, PROXY_FACTORY, FALLBACK_HANDLER, identityRegistry);
        recurring = new PurserRecurring(module);
        escrow = new PurserEscrow();
        passkey = new PurserPasskey(IPurserApprovals(address(module)));
    }

    // ------------------------------------------------------------------ config helpers

    function _config() internal view returns (PurserModule.Config memory c) {
        c.agent = agent;
        c.watchdog = watchdog;
    }

    function _rule() internal pure returns (PurserModule.TokenRule memory r) {
        r.enabled = true;
        r.receivable = true;
        r.maxSingle = 1_000e6;
        r.daily = 5_000e6;
        r.weekly = 20_000e6;
        r.perCounterpartyDaily = 2_000e6;
        r.approvalAbove = 500e6;
        r.cosignAbove = NO_CAP;
        r.keepLiquid = 0;
    }

    function _ethRule() internal pure returns (PurserModule.TokenRule memory r) {
        r.enabled = true;
        r.receivable = true;
        r.maxSingle = 1 ether;
        r.daily = 5 ether;
        r.weekly = 20 ether;
        r.perCounterpartyDaily = 2 ether;
        r.approvalAbove = 0.5 ether;
        r.cosignAbove = NO_CAP;
    }

    function _setup(address token, string memory uri) internal view returns (PurserFactory.Setup memory s) {
        s.config = _config();
        s.rules = new PurserModule.TokenRuleInit[](2);
        s.rules[0] = PurserModule.TokenRuleInit(token, _rule());
        s.rules[1] = PurserModule.TokenRuleInit(ETH, _ethRule());
        s.allow = new address[](0);
        s.extensions = new address[](1);
        s.extensions[0] = address(recurring);
        s.agentURI = uri;
    }

    function _owners() internal view returns (address[] memory o) {
        o = new address[](1);
        o[0] = owner;
    }

    function _createAccount(address token) internal returns (address s) {
        vm.prank(owner);
        s = factory.createAccount(_owners(), 1, _setup(token, "https://purser.fun/agents/test.json"), 1);
        safe = s;
    }

    // ------------------------------------------------------------------ signing helpers

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pay(address token, address to, uint256 amount) internal returns (PurserModule.Pay memory p) {
        p = PurserModule.Pay(safe, token, to, amount, bytes32(0), nextNonce++, block.timestamp + 1 hours);
    }

    function _payDigest(PurserModule.Pay memory p) internal view returns (bytes32) {
        return module.hashTyped(
            keccak256(
                abi.encode(module.PAY_TYPEHASH(), p.safe, p.token, p.to, p.amount, p.service, p.nonce, p.deadline)
            )
        );
    }

    function _callDigest(PurserModule.Call memory c) internal view returns (bytes32) {
        return module.hashTyped(
            keccak256(
                abi.encode(
                    module.CALL_TYPEHASH(),
                    c.safe,
                    c.target,
                    c.value,
                    keccak256(c.data),
                    c.spendToken,
                    c.spendLimit,
                    c.nonce,
                    c.deadline
                )
            )
        );
    }

    function _treasuryDigest(PurserModule.Treasury memory t) internal view returns (bytes32) {
        return module.hashTyped(
            keccak256(
                abi.encode(
                    module.TREASURY_TYPEHASH(), t.safe, t.vault, t.deposit, t.assets, t.limit, t.nonce, t.deadline
                )
            )
        );
    }

    function _agentOpDigest(
        address s,
        address ext,
        bytes32 opHash,
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return module.hashTyped(
            keccak256(abi.encode(module.AGENT_OP_TYPEHASH(), s, ext, opHash, token, amount, nonce, deadline))
        );
    }

    function _agentSig(bytes32 digest) internal view returns (bytes memory) {
        return _sig(agentPk, digest);
    }

    function _doPay(address token, address to, uint256 amount) internal returns (bool) {
        PurserModule.Pay memory p = _pay(token, to, amount);
        return module.pay(p, _agentSig(_payDigest(p)));
    }

    /// @dev Runs a real Safe transaction signed by `owner` (threshold 1, pre-validated signature).
    function _safeExec(address s, address to, uint256 value, bytes memory data, uint8 op) internal {
        bytes memory sig = abi.encodePacked(uint256(uint160(owner)), uint256(0), uint8(1));
        vm.prank(owner);
        ISafeFull(s).execTransaction(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), sig);
    }
}
