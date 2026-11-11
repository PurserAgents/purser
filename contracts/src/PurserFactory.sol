// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe, ISafeProxyFactory, IIdentityRegistry} from "./Interfaces.sol";
import {PurserModule} from "./PurserModule.sol";

/// @title PurserFactory
/// @notice Creates an agent account in one transaction: a Safe 1.4.1 owned by the owner's wallets, the Purser
///         module enabled, the first rules written and (optionally) an ERC-8004 identity registered to the Safe.
///         `setupAccount` also attaches an existing Safe: the owners sign one Safe transaction that delegatecalls it.
contract PurserFactory {
    address public immutable MODULE;
    address public immutable SAFE_SINGLETON;
    address public immutable PROXY_FACTORY;
    address public immutable FALLBACK_HANDLER;
    address public immutable IDENTITY_REGISTRY;
    address private immutable SELF;

    struct Setup {
        PurserModule.Config config;
        PurserModule.TokenRuleInit[] rules;
        address[] allow;
        address[] extensions;
        string agentURI; // empty = no ERC-8004 registration
    }

    event AccountCreated(address indexed safe, address indexed creator, uint256 agentId);

    error OnlyDelegateCall();

    constructor(
        address module,
        address safeSingleton,
        address proxyFactory,
        address fallbackHandler,
        address identityRegistry
    ) {
        MODULE = module;
        SAFE_SINGLETON = safeSingleton;
        PROXY_FACTORY = proxyFactory;
        FALLBACK_HANDLER = fallbackHandler;
        IDENTITY_REGISTRY = identityRegistry;
        SELF = address(this);
    }

    /// @notice Create a new Safe for an agent, owned by `owners`, with the module enabled and configured.
    function createAccount(address[] calldata owners, uint256 threshold, Setup calldata s, uint256 salt)
        external
        returns (address safe)
    {
        bytes memory initializer = _initializer(owners, threshold, s);
        safe = ISafeProxyFactory(PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, initializer, _salt(msg.sender, salt));
        emit AccountCreated(safe, msg.sender, PurserModule(MODULE).getAccount(safe).agentId);
    }

    /// @notice The address `createAccount` will produce for these arguments.
    function predictAddress(
        address[] calldata owners,
        uint256 threshold,
        Setup calldata s,
        address creator,
        uint256 salt
    ) external view returns (address) {
        bytes32 create2Salt = keccak256(abi.encodePacked(keccak256(_initializer(owners, threshold, s)), _salt(creator, salt)));
        bytes memory code = abi.encodePacked(
            ISafeProxyFactory(PROXY_FACTORY).proxyCreationCode(), uint256(uint160(SAFE_SINGLETON))
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), PROXY_FACTORY, create2Salt, keccak256(code)))))
        );
    }

    /// @notice Runs inside the Safe by delegatecall: from Safe.setup, or from a Safe transaction (operation 1) to
    ///         attach an existing Safe. Enables the module, writes the rules, registers the ERC-8004 identity.
    ///         It emits nothing itself (it runs as the Safe); the module's AccountInitialized is the record.
    function setupAccount(Setup calldata s) external {
        if (address(this) == SELF) revert OnlyDelegateCall();
        if (!ISafe(address(this)).isModuleEnabled(MODULE)) ISafe(address(this)).enableModule(MODULE);
        PurserModule(MODULE).initialize(s.config, s.rules, s.allow, s.extensions);
        if (IDENTITY_REGISTRY != address(0) && bytes(s.agentURI).length > 0) {
            uint256 agentId = IIdentityRegistry(IDENTITY_REGISTRY).register(s.agentURI);
            PurserModule(MODULE).setAgentId(agentId);
        }
    }

    function _initializer(address[] calldata owners, uint256 threshold, Setup calldata s)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(
            ISafe.setup,
            (
                owners,
                threshold,
                address(this),
                abi.encodeCall(this.setupAccount, (s)),
                FALLBACK_HANDLER,
                address(0),
                0,
                payable(address(0))
            )
        );
    }

    function _salt(address creator, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(creator, salt)));
    }
}
