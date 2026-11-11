// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe, IERC20Min, IERC4626Min, IERC3009} from "./Interfaces.sol";

/// @title PurserModule
/// @notice A Safe 1.4.1 module that lets an agent's session key spend from the owner's Safe within the owner's rules.
///         One deployment serves every account; all state is keyed by the Safe address. The module never holds
///         funds: tokens move from the Safe straight to the payee, and ETH sent to `receiveETH` is forwarded to the
///         Safe in the same call.
contract PurserModule {
    // ------------------------------------------------------------------------------------------------------------
    // Constants and immutables
    // ------------------------------------------------------------------------------------------------------------

    uint256 public constant MAX_FEE_BPS = 100; // 1%
    uint256 public constant MAX_SPLITS = 8;
    uint256 public constant MAX_TOKENS = 8;
    uint256 public constant MIN_RECOVERY_DELAY = 1 days;
    uint128 public constant NO_CAP = type(uint128).max;
    address public constant ETH = address(0);

    bytes32 public constant PAY_TYPEHASH = keccak256(
        "Pay(address safe,address token,address to,uint256 amount,bytes32 service,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CALL_TYPEHASH = keccak256(
        "Call(address safe,address target,uint256 value,bytes32 dataHash,address spendToken,uint256 spendLimit,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant TREASURY_TYPEHASH = keccak256(
        "Treasury(address safe,address vault,bool deposit,uint256 assets,uint256 limit,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant AGENT_OP_TYPEHASH = keccak256(
        "AgentOp(address safe,address extension,bytes32 opHash,address token,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    /// @dev Selectors the agent may never call through `call`: approvals, permits and direct token transfers
    ///      (approve, increaseAllowance, setApprovalForAll, transfer, transferFrom, EIP-2612 permit, ERC-721 and
    ///      ERC-1155 safeTransferFrom / safeBatchTransferFrom, Permit2 approve and permit (single, batch),
    ///      ERC-677 transferAndCall, ERC-777 send and authorizeOperator, EIP-3009 transferWithAuthorization).
    bytes public constant BLOCKED_SELECTORS = hex"095ea7b3" hex"39509351" hex"a22cb465" hex"a9059cbb" hex"23b872dd"
        hex"d505accf" hex"42842e0e" hex"b88d4fde" hex"f242432a" hex"2eb2c2d6" hex"87517c45" hex"2b67b570"
        hex"2a2d80d1" hex"4000aea0" hex"9bd9bbc6" hex"959b8c3f" hex"e3ee160e" hex"cf092995";

    address public immutable FEE_RECIPIENT;
    uint256 public immutable FEE_BPS;
    bytes32 private immutable _DOMAIN_SEPARATOR;
    uint256 private immutable _CHAIN_ID;

    // ------------------------------------------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------------------------------------------

    struct Config {
        address agent; // session key that signs intents
        address cosigner; // second key above the co-sign threshold (0 = none)
        address firewall; // if set, every intent needs this key's signature too
        address watchdog; // may freeze (never unfreeze); 0 = off
        uint16 maxPerMinute; // 0 = no rate limit
        uint24 hoursMask; // bit h = UTC hour h allowed; 0 = any hour
        uint8 daysMask; // bit d = weekday d allowed (0 = Monday); 0 = any day
        bool payeeAllowlist; // payments only to allowlisted addresses
        bool serviceAllowlist; // payments only with an allowlisted service id
    }

    /// @dev Limits and thresholds use NO_CAP for "no cap" / "never". A threshold of 0 means "always".
    struct TokenRule {
        bool enabled; // the agent may spend this token
        bool receivable; // incoming payments in this token go through receive paths (with splits)
        uint128 maxSingle;
        uint128 daily;
        uint128 weekly;
        uint128 perCounterpartyDaily;
        uint128 approvalAbove;
        uint128 cosignAbove;
        uint128 keepLiquid; // treasury: never deposit below this balance
    }

    struct Split {
        address to;
        uint16 bps;
    }

    struct Account {
        bool initialized;
        bool frozen;
        uint16 minuteCount;
        uint64 minute;
        address guardian;
        uint64 recoveryDelay;
        address approver; // may approve queued intents (e.g. PurserPasskey); 0 = owners only
        uint256 agentId;
        Config config;
    }

    struct Recovery {
        bytes32 ownersHash;
        uint64 executeAfter;
    }

    struct Pay {
        address safe;
        address token;
        address to;
        uint256 amount;
        bytes32 service;
        uint256 nonce;
        uint256 deadline;
    }

    struct Call {
        address safe;
        address target;
        uint256 value;
        bytes data;
        address spendToken; // token granted to `target` for this call only (0 = none)
        uint256 spendLimit;
        uint256 nonce;
        uint256 deadline;
    }

    struct Treasury {
        address safe;
        address vault;
        bool deposit;
        uint256 assets;
        uint256 limit; // deposit: min shares out; withdraw: max shares burned
        uint256 nonce;
        uint256 deadline;
    }

    enum IntentState {
        None,
        Pending,
        Approved,
        Rejected
    }

    // ------------------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------------------

    mapping(address safe => Account) internal _accounts;
    mapping(address safe => mapping(address token => TokenRule)) internal _rules;
    mapping(address safe => address[]) internal _tokens;
    mapping(address safe => mapping(address token => mapping(address cp => uint256))) public counterpartyLimit;
    mapping(address safe => mapping(address target => bool)) public allowed;
    mapping(address safe => mapping(bytes32 service => bool)) public allowedService;
    mapping(address safe => mapping(address vault => bool)) public treasuryVault;
    mapping(address safe => mapping(address ext => bool)) public extensionEnabled;
    mapping(address safe => Split[]) internal _splits;
    mapping(address safe => mapping(uint256 nonce => bool)) public nonceUsed;
    mapping(address safe => mapping(bytes32 digest => IntentState)) public intentState;
    mapping(address safe => Recovery) public recovery;
    mapping(address safe => mapping(address token => mapping(uint256 day => uint256))) public spentOnDay;
    mapping(address safe => mapping(address token => mapping(uint256 week => uint256))) public spentInWeek;
    mapping(bytes32 key => uint256) public counterpartySpent; // keccak(safe, token, cp, day)
    uint256 private _lock = 1;

    // ------------------------------------------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------------------------------------------

    event AccountInitialized(address indexed safe, address indexed agent);
    event ConfigSet(address indexed safe, address indexed agent);
    event TokenRuleSet(address indexed safe, address indexed token);
    event CounterpartyLimitSet(address indexed safe, address indexed token, address indexed cp, uint256 limit);
    event AllowedSet(address indexed safe, address indexed target, bool allowed);
    event ServiceSet(address indexed safe, bytes32 indexed service, bool allowed);
    event TreasuryVaultSet(address indexed safe, address indexed vault, bool allowed);
    event ExtensionSet(address indexed safe, address indexed extension, bool enabled);
    event SplitsSet(address indexed safe, uint256 count);
    event ApproverSet(address indexed safe, address indexed approver);
    event GuardianSet(address indexed safe, address indexed guardian, uint64 delay);
    event AgentIdSet(address indexed safe, uint256 agentId);
    event Frozen(address indexed safe, address indexed by);
    event Unfrozen(address indexed safe, address indexed by);
    event IntentQueued(address indexed safe, bytes32 indexed digest, address token, uint256 amount);
    event IntentApproved(address indexed safe, bytes32 indexed digest, address indexed by);
    event IntentRejected(address indexed safe, bytes32 indexed digest, address indexed by);
    event Paid(
        address indexed safe,
        address indexed token,
        address indexed to,
        uint256 amount,
        uint256 fee,
        bytes32 service,
        bytes32 digest
    );
    event Called(address indexed safe, address indexed target, uint256 value, bytes4 selector, bytes32 digest);
    event Outflow(address indexed safe, address indexed token, address indexed to, uint256 amount, uint256 fee);
    event TreasuryMoved(address indexed safe, address indexed vault, bool deposit, uint256 assets, uint256 shares);
    event Received(address indexed safe, address indexed token, address indexed from, uint256 amount, bytes32 ref);
    event SplitPaid(address indexed safe, address indexed token, address indexed to, uint256 amount);
    event RecoveryStarted(address indexed safe, address[] owners, uint256 threshold, uint64 executeAfter);
    event RecoveryCancelled(address indexed safe, address indexed by);
    event RecoveryFinished(address indexed safe, address[] owners, uint256 threshold);

    // ------------------------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------------------------

    error NotSafe();
    error NotOwner();
    error NotInitialized();
    error AlreadyInitialized();
    error ModuleNotEnabled();
    error IsFrozen();
    error Expired();
    error NonceUsed();
    error BadSignature();
    error IntentWasRejected();
    error TokenNotEnabled();
    error OverMaxSingle();
    error OverDaily();
    error OverWeekly();
    error OverCounterparty();
    error PayeeNotAllowed();
    error ServiceNotAllowed();
    error TargetNotAllowed();
    error SelectorBlocked();
    error OutsideTimeWindow();
    error RateLimited();
    error ExecFailed();
    error BadAmount();
    error BadConfig();
    error NotExtension();
    error VaultNotAllowed();
    error KeepLiquid();
    error Slippage();
    error NotGuardian();
    error RecoveryNotReady();
    error Reentrancy();
    error NotReceivable();

    // ------------------------------------------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------------------------------------------

    constructor(address feeRecipient, uint256 feeBps) {
        if (feeBps > MAX_FEE_BPS || (feeBps > 0 && feeRecipient == address(0))) revert BadConfig();
        FEE_RECIPIENT = feeRecipient;
        FEE_BPS = feeBps;
        _CHAIN_ID = block.chainid;
        _DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlySafe(address safe) {
        if (msg.sender != safe) revert NotSafe();
        _;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Owner configuration (always a Safe transaction: msg.sender == safe)
    // ------------------------------------------------------------------------------------------------------------

    struct TokenRuleInit {
        address token;
        TokenRule rule;
    }

    /// @notice First configuration, called by the Safe (from PurserFactory's setup, or a Safe transaction).
    function initialize(
        Config calldata config,
        TokenRuleInit[] calldata rules,
        address[] calldata allow,
        address[] calldata extensions
    ) external {
        Account storage a = _accounts[msg.sender];
        if (a.initialized) revert AlreadyInitialized();
        if (!ISafe(msg.sender).isModuleEnabled(address(this))) revert ModuleNotEnabled();
        a.initialized = true;
        _setConfig(msg.sender, config);
        for (uint256 i; i < rules.length; ++i) {
            _setTokenRule(msg.sender, rules[i].token, rules[i].rule);
        }
        for (uint256 i; i < allow.length; ++i) {
            _setAllowed(msg.sender, allow[i], true);
        }
        for (uint256 i; i < extensions.length; ++i) {
            _setExtension(msg.sender, extensions[i], true);
        }
        emit AccountInitialized(msg.sender, config.agent);
    }

    function setConfig(Config calldata config) external {
        _requireInit(msg.sender);
        _setConfig(msg.sender, config);
    }

    function setTokenRule(address token, TokenRule calldata rule) external {
        _requireInit(msg.sender);
        _setTokenRule(msg.sender, token, rule);
    }

    function setCounterpartyLimit(address token, address cp, uint256 limit) external {
        _requireInit(msg.sender);
        counterpartyLimit[msg.sender][token][cp] = limit;
        emit CounterpartyLimitSet(msg.sender, token, cp, limit);
    }

    function setAllowed(address[] calldata targets, bool on) external {
        _requireInit(msg.sender);
        for (uint256 i; i < targets.length; ++i) {
            _setAllowed(msg.sender, targets[i], on);
        }
    }

    function setServices(bytes32[] calldata services, bool on) external {
        _requireInit(msg.sender);
        for (uint256 i; i < services.length; ++i) {
            allowedService[msg.sender][services[i]] = on;
            emit ServiceSet(msg.sender, services[i], on);
        }
    }

    function setTreasuryVault(address vault, bool on) external {
        _requireInit(msg.sender);
        if (vault == msg.sender || vault == address(this)) revert BadConfig();
        treasuryVault[msg.sender][vault] = on;
        emit TreasuryVaultSet(msg.sender, vault, on);
    }

    function setExtension(address ext, bool on) external {
        _requireInit(msg.sender);
        _setExtension(msg.sender, ext, on);
    }

    function setSplits(Split[] calldata splits) external {
        _requireInit(msg.sender);
        if (splits.length > MAX_SPLITS) revert BadConfig();
        delete _splits[msg.sender];
        uint256 total;
        for (uint256 i; i < splits.length; ++i) {
            if (splits[i].to == address(0) || splits[i].to == msg.sender || splits[i].bps == 0) revert BadConfig();
            total += splits[i].bps;
            _splits[msg.sender].push(splits[i]);
        }
        if (total > 10_000) revert BadConfig();
        emit SplitsSet(msg.sender, splits.length);
    }

    /// @notice An address that may approve or reject queued intents besides the owners, e.g. PurserPasskey.
    function setApprover(address approver) external {
        _requireInit(msg.sender);
        _accounts[msg.sender].approver = approver;
        emit ApproverSet(msg.sender, approver);
    }

    function setGuardian(address guardian, uint64 delay) external {
        _requireInit(msg.sender);
        if (guardian != address(0) && delay < MIN_RECOVERY_DELAY) revert BadConfig();
        Account storage a = _accounts[msg.sender];
        a.guardian = guardian;
        a.recoveryDelay = delay;
        delete recovery[msg.sender];
        emit GuardianSet(msg.sender, guardian, delay);
    }

    function setAgentId(uint256 agentId) external {
        _requireInit(msg.sender);
        _accounts[msg.sender].agentId = agentId;
        emit AgentIdSet(msg.sender, agentId);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Freeze, approvals, recovery (owner wallets act directly)
    // ------------------------------------------------------------------------------------------------------------

    function freeze(address safe) external {
        _requireInit(safe);
        Account storage a = _accounts[safe];
        bool byWatchdog = a.config.watchdog != address(0) && msg.sender == a.config.watchdog;
        if (!byWatchdog) _requireOwner(safe);
        a.frozen = true;
        emit Frozen(safe, msg.sender);
    }

    function unfreeze(address safe) external {
        _requireInit(safe);
        _requireOwner(safe);
        _accounts[safe].frozen = false;
        emit Unfrozen(safe, msg.sender);
    }

    function approveIntent(address safe, bytes32 digest) external {
        _requireInit(safe);
        _requireApprover(safe);
        if (intentState[safe][digest] == IntentState.Rejected) revert IntentWasRejected();
        intentState[safe][digest] = IntentState.Approved;
        emit IntentApproved(safe, digest, msg.sender);
    }

    function rejectIntent(address safe, bytes32 digest) external {
        _requireInit(safe);
        _requireApprover(safe);
        intentState[safe][digest] = IntentState.Rejected;
        emit IntentRejected(safe, digest, msg.sender);
    }

    function startRecovery(address safe, address[] calldata owners, uint256 threshold) external {
        Account storage a = _accounts[safe];
        if (a.guardian == address(0) || msg.sender != a.guardian) revert NotGuardian();
        if (owners.length == 0 || threshold == 0 || threshold > owners.length) revert BadConfig();
        uint64 after_ = uint64(block.timestamp) + a.recoveryDelay;
        recovery[safe] = Recovery(keccak256(abi.encode(owners, threshold)), after_);
        emit RecoveryStarted(safe, owners, threshold, after_);
    }

    function cancelRecovery(address safe) external {
        _requireOwner(safe);
        delete recovery[safe];
        emit RecoveryCancelled(safe, msg.sender);
    }

    /// @notice After the delay, anyone can apply the guardian's new owner set.
    function finishRecovery(address safe, address[] calldata owners, uint256 threshold) external nonReentrant {
        Recovery memory r = recovery[safe];
        if (r.executeAfter == 0 || block.timestamp < r.executeAfter) revert RecoveryNotReady();
        if (r.ownersHash != keccak256(abi.encode(owners, threshold))) revert RecoveryNotReady();
        delete recovery[safe];
        ISafe s = ISafe(safe);
        for (uint256 i; i < owners.length; ++i) {
            if (!s.isOwner(owners[i])) {
                _exec(safe, safe, 0, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", owners[i], 1));
            }
        }
        address[] memory current = s.getOwners();
        for (uint256 i; i < current.length; ++i) {
            if (!_contains(owners, current[i])) {
                address[] memory now_ = s.getOwners();
                address prev = address(0x1);
                for (uint256 j; j < now_.length; ++j) {
                    if (now_[j] == current[i]) break;
                    prev = now_[j];
                }
                _exec(safe, safe, 0, abi.encodeWithSignature("removeOwner(address,address,uint256)", prev, current[i], 1));
            }
        }
        _exec(safe, safe, 0, abi.encodeWithSignature("changeThreshold(uint256)", threshold));
        emit RecoveryFinished(safe, owners, threshold);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Agent intents
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Pay `amount` of `token` (address(0) = ETH) from the Safe to `to`.
    /// @return executed false when the payment was queued for the owner's approval.
    function pay(Pay calldata p, bytes calldata sigs) external nonReentrant returns (bool executed) {
        Account storage a = _live(p.safe);
        _checkFresh(p.safe, p.nonce, p.deadline);
        if (p.amount == 0 || p.to == address(0)) revert BadAmount();
        TokenRule storage rule = _rules[p.safe][p.token];
        bytes32 digest = _hashTyped(
            keccak256(abi.encode(PAY_TYPEHASH, p.safe, p.token, p.to, p.amount, p.service, p.nonce, p.deadline))
        );
        _checkSigs(a.config, digest, sigs, p.amount > rule.cosignAbove);
        if (!rule.enabled) revert TokenNotEnabled();
        if (a.config.payeeAllowlist && !allowed[p.safe][p.to]) revert PayeeNotAllowed();
        if (a.config.serviceAllowlist && !allowedService[p.safe][p.service]) revert ServiceNotAllowed();
        if (!_approvedOrQueue(p.safe, digest, p.amount > rule.approvalAbove, p.token, p.amount)) return false;
        nonceUsed[p.safe][p.nonce] = true;

        uint256 fee = _spend(p.safe, a, p.token, p.to, p.amount);
        _transferOut(p.safe, p.token, p.to, p.amount);
        if (fee > 0) _transferOut(p.safe, p.token, FEE_RECIPIENT, fee);
        emit Paid(p.safe, p.token, p.to, p.amount, fee, p.service, digest);
        return true;
    }

    /// @notice Call an allowlisted contract from the Safe. Balance changes of ETH and every enabled token are
    ///         measured and counted against the rules.
    function call(Call calldata c, bytes calldata sigs) external nonReentrant returns (bool executed) {
        Account storage a = _live(c.safe);
        _checkFresh(c.safe, c.nonce, c.deadline);
        _checkTarget(c.safe, c.target, c.data);
        if (c.spendToken != address(0) && !_rules[c.safe][c.spendToken].enabled) revert TokenNotEnabled();

        bytes32 digest = _hashTyped(
            keccak256(
                abi.encode(
                    CALL_TYPEHASH,
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
        (bool needCosign, bool needApproval) = _callThresholds(c);
        _checkSigs(a.config, digest, sigs, needCosign);
        if (!_approvedOrQueue(c.safe, digest, needApproval, c.spendToken, c.spendLimit)) return false;
        nonceUsed[c.safe][c.nonce] = true;

        address[] memory tokens = _tokens[c.safe];
        uint256[] memory before = new uint256[](tokens.length + 1);
        before[0] = c.safe.balance;
        for (uint256 i; i < tokens.length; ++i) {
            before[i + 1] = IERC20Min(tokens[i]).balanceOf(c.safe);
        }

        if (c.spendToken != address(0)) {
            _execOk(c.safe, c.spendToken, 0, abi.encodeCall(IERC20Min.approve, (c.target, c.spendLimit)));
        }
        _exec(c.safe, c.target, c.value, c.data);
        if (c.spendToken != address(0)) {
            _execOk(c.safe, c.spendToken, 0, abi.encodeCall(IERC20Min.approve, (c.target, 0)));
        }

        _settleOutflow(c.safe, a, ETH, c.target, before[0], c.safe.balance);
        for (uint256 i; i < tokens.length; ++i) {
            _settleOutflow(c.safe, a, tokens[i], c.target, before[i + 1], IERC20Min(tokens[i]).balanceOf(c.safe));
        }
        emit Called(c.safe, c.target, c.value, bytes4(c.data.length >= 4 ? c.data[:4] : bytes("")), digest);
        return true;
    }

    /// @notice Move idle balance into an allowlisted ERC-4626 vault, or back. Signed by the agent, or sent
    ///         directly by a Safe owner (then `sigs` is ignored and a frozen account may still withdraw).
    function treasury(Treasury calldata t, bytes calldata sigs) external nonReentrant {
        _requireInit(t.safe);
        Account storage a = _accounts[t.safe];
        bool byOwner = msg.sender == t.safe || ISafe(t.safe).isOwner(msg.sender);
        if (!byOwner) {
            if (a.frozen) revert IsFrozen();
            _checkFresh(t.safe, t.nonce, t.deadline);
            bytes32 digest = _hashTyped(
                keccak256(
                    abi.encode(TREASURY_TYPEHASH, t.safe, t.vault, t.deposit, t.assets, t.limit, t.nonce, t.deadline)
                )
            );
            _checkSigs(a.config, digest, sigs, false);
            nonceUsed[t.safe][t.nonce] = true;
        }
        if (!treasuryVault[t.safe][t.vault]) revert VaultNotAllowed();
        if (t.assets == 0) revert BadAmount();
        address asset = IERC4626Min(t.vault).asset();
        if (!_rules[t.safe][asset].enabled) revert TokenNotEnabled();
        uint256 assetsBefore = IERC20Min(asset).balanceOf(t.safe);
        uint256 sharesBefore = IERC4626Min(t.vault).balanceOf(t.safe);
        uint256 shares;
        if (t.deposit) {
            if (assetsBefore < t.assets || assetsBefore - t.assets < _rules[t.safe][asset].keepLiquid) {
                revert KeepLiquid();
            }
            _execOk(t.safe, asset, 0, abi.encodeCall(IERC20Min.approve, (t.vault, t.assets)));
            _exec(t.safe, t.vault, 0, abi.encodeCall(IERC4626Min.deposit, (t.assets, t.safe)));
            _execOk(t.safe, asset, 0, abi.encodeCall(IERC20Min.approve, (t.vault, 0)));
            shares = IERC4626Min(t.vault).balanceOf(t.safe) - sharesBefore;
            if (shares < t.limit || IERC20Min(asset).balanceOf(t.safe) != assetsBefore - t.assets) revert Slippage();
        } else {
            _exec(t.safe, t.vault, 0, abi.encodeCall(IERC4626Min.withdraw, (t.assets, t.safe, t.safe)));
            shares = sharesBefore - IERC4626Min(t.vault).balanceOf(t.safe);
            if (shares > t.limit || IERC20Min(asset).balanceOf(t.safe) < assetsBefore + t.assets) revert Slippage();
        }
        emit TreasuryMoved(t.safe, t.vault, t.deposit, t.assets, shares);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Extensions (PurserRecurring): opt-in per Safe, every payment still passes the rules
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Checks an agent-signed operation for an extension (e.g. creating a stream). Returns false when the
    ///         operation was queued for the owner's approval.
    function authorizeAgentOp(
        address safe,
        bytes32 opHash,
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sigs
    ) external nonReentrant returns (bool) {
        Account storage a = _live(safe);
        if (!extensionEnabled[safe][msg.sender]) revert NotExtension();
        _checkFresh(safe, nonce, deadline);
        if (!_rules[safe][token].enabled) revert TokenNotEnabled();
        TokenRule storage rule = _rules[safe][token];
        bytes32 digest = _hashTyped(
            keccak256(abi.encode(AGENT_OP_TYPEHASH, safe, msg.sender, opHash, token, amount, nonce, deadline))
        );
        _checkSigs(a.config, digest, sigs, amount > rule.cosignAbove);
        if (!_approvedOrQueue(safe, digest, amount > rule.approvalAbove, token, amount)) return false;
        nonceUsed[safe][nonce] = true;
        return true;
    }

    /// @notice Pays from the Safe for an enabled extension, through every spending rule.
    function extPay(address safe, address token, address to, uint256 amount, bytes32 ref)
        external
        nonReentrant
        returns (uint256 fee)
    {
        Account storage a = _live(safe);
        if (!extensionEnabled[safe][msg.sender]) revert NotExtension();
        if (amount == 0 || to == address(0)) revert BadAmount();
        if (a.config.payeeAllowlist && !allowed[safe][to]) revert PayeeNotAllowed();
        fee = _spend(safe, a, token, to, amount);
        _transferOut(safe, token, to, amount);
        if (fee > 0) _transferOut(safe, token, FEE_RECIPIENT, fee);
        emit Paid(safe, token, to, amount, fee, ref, bytes32(0));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Money in
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Settles an EIP-3009 authorization from `from` to the Safe, then applies the owner's splits.
    ///         `transferForm` picks transferWithAuthorization (what standard x402 clients sign) instead of
    ///         receiveWithAuthorization. The Safe itself makes the token call.
    function receiveWithAuthorization(
        address safe,
        address token,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        bytes32 ref,
        bool transferForm
    ) external nonReentrant {
        _requireInit(safe);
        if (token == ETH || !_rules[safe][token].receivable) revert NotReceivable();
        uint256 before = IERC20Min(token).balanceOf(safe);
        _exec(
            safe,
            token,
            0,
            abi.encodeWithSelector(
                transferForm ? bytes4(0xcf092995) : IERC3009.receiveWithAuthorization.selector,
                from,
                safe,
                value,
                validAfter,
                validBefore,
                nonce,
                signature
            )
        );
        if (IERC20Min(token).balanceOf(safe) != before + value) revert BadAmount();
        emit Received(safe, token, from, value, ref);
        _applySplits(safe, token, value);
    }

    /// @notice Forwards ETH to the Safe and applies the owner's splits in the same call.
    function receiveETH(address safe, bytes32 ref) external payable nonReentrant {
        _requireInit(safe);
        if (msg.value == 0) revert BadAmount();
        (bool ok,) = safe.call{value: msg.value}("");
        if (!ok) revert ExecFailed();
        emit Received(safe, ETH, msg.sender, msg.value, ref);
        _applySplits(safe, ETH, msg.value);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _CHAIN_ID ? _DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function getAccount(address safe) external view returns (Account memory) {
        return _accounts[safe];
    }

    function getTokenRule(address safe, address token) external view returns (TokenRule memory) {
        return _rules[safe][token];
    }

    function getTokens(address safe) external view returns (address[] memory) {
        return _tokens[safe];
    }

    function getSplits(address safe) external view returns (Split[] memory) {
        return _splits[safe];
    }

    function feeFor(uint256 amount) public view returns (uint256) {
        return amount * FEE_BPS / 10_000;
    }

    function hashTyped(bytes32 structHash) external view returns (bytes32) {
        return _hashTyped(structHash);
    }

    /// @notice What the agent may still spend today in `token` (after the daily and weekly caps).
    function remainingToday(address safe, address token) external view returns (uint256) {
        TokenRule storage r = _rules[safe][token];
        if (!r.enabled) return 0;
        uint256 day = block.timestamp / 1 days;
        uint256 dLeft = _left(r.daily, spentOnDay[safe][token][day]);
        uint256 wLeft = _left(r.weekly, spentInWeek[safe][token][(day + 3) / 7]);
        return dLeft < wLeft ? dLeft : wLeft;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------------------

    function _setConfig(address safe, Config calldata config) internal {
        if (config.agent == address(0) || config.agent == safe) revert BadConfig();
        _accounts[safe].config = config;
        emit ConfigSet(safe, config.agent);
    }

    function _setTokenRule(address safe, address token, TokenRule calldata rule) internal {
        if (token == safe || token == address(this)) revert BadConfig();
        if (token != ETH && !_rules[safe][token].enabled && rule.enabled) {
            address[] storage list = _tokens[safe];
            bool present;
            for (uint256 i; i < list.length; ++i) {
                if (list[i] == token) present = true;
            }
            if (!present) {
                if (list.length >= MAX_TOKENS) revert BadConfig();
                list.push(token);
            }
        }
        _rules[safe][token] = rule;
        emit TokenRuleSet(safe, token);
    }

    function _setAllowed(address safe, address target, bool on) internal {
        if (target == safe || target == address(this) || target == address(0)) revert BadConfig();
        allowed[safe][target] = on;
        emit AllowedSet(safe, target, on);
    }

    function _setExtension(address safe, address ext, bool on) internal {
        if (ext == safe || ext == address(this) || ext == address(0)) revert BadConfig();
        extensionEnabled[safe][ext] = on;
        emit ExtensionSet(safe, ext, on);
    }

    function _requireInit(address safe) internal view {
        if (!_accounts[safe].initialized) revert NotInitialized();
    }

    function _requireOwner(address safe) internal view {
        if (msg.sender != safe && !ISafe(safe).isOwner(msg.sender)) revert NotOwner();
    }

    function _requireApprover(address safe) internal view {
        address ap = _accounts[safe].approver;
        if (ap != address(0) && msg.sender == ap) return;
        _requireOwner(safe);
    }

    function _live(address safe) internal view returns (Account storage a) {
        a = _accounts[safe];
        if (!a.initialized) revert NotInitialized();
        if (a.frozen) revert IsFrozen();
    }

    function _checkFresh(address safe, uint256 nonce, uint256 deadline) internal view {
        if (block.timestamp > deadline) revert Expired();
        if (nonceUsed[safe][nonce]) revert NonceUsed();
    }

    /// @return proceed true when no approval is needed or the owner approved the digest.
    function _approvedOrQueue(address safe, bytes32 digest, bool needApproval, address token, uint256 amount)
        internal
        returns (bool proceed)
    {
        IntentState st = intentState[safe][digest];
        if (st == IntentState.Rejected) revert IntentWasRejected();
        if (!needApproval || st == IntentState.Approved) return true;
        if (st == IntentState.None) {
            intentState[safe][digest] = IntentState.Pending;
            emit IntentQueued(safe, digest, token, amount);
        }
        return false;
    }

    function _callThresholds(Call calldata c) internal view returns (bool needCosign, bool needApproval) {
        if (c.value > 0) {
            TokenRule storage e = _rules[c.safe][ETH];
            needCosign = c.value > e.cosignAbove;
            needApproval = c.value > e.approvalAbove;
        }
        if (c.spendToken != address(0)) {
            TokenRule storage t = _rules[c.safe][c.spendToken];
            needCosign = needCosign || c.spendLimit > t.cosignAbove;
            needApproval = needApproval || c.spendLimit > t.approvalAbove;
        }
    }

    /// @dev sigs = agent (65) [+ cosigner (65) when needed] [+ firewall (65) when set].
    function _checkSigs(Config storage cfg, bytes32 digest, bytes calldata sigs, bool needCosign) internal view {
        uint256 off;
        if (_recover(digest, sigs, off) != cfg.agent) revert BadSignature();
        off += 65;
        if (needCosign && cfg.cosigner != address(0)) {
            if (_recover(digest, sigs, off) != cfg.cosigner) revert BadSignature();
            off += 65;
        }
        if (cfg.firewall != address(0)) {
            if (_recover(digest, sigs, off) != cfg.firewall) revert BadSignature();
        }
    }

    function _recover(bytes32 digest, bytes calldata sigs, uint256 off) internal pure returns (address signer) {
        if (sigs.length < off + 65) revert BadSignature();
        bytes32 r = bytes32(sigs[off:off + 32]);
        bytes32 s = bytes32(sigs[off + 32:off + 64]);
        uint8 v = uint8(sigs[off + 64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _checkTarget(address safe, address target, bytes calldata data) internal view {
        if (target == safe || target == address(this) || !allowed[safe][target]) revert TargetNotAllowed();
        if (target != ETH && _rules[safe][target].enabled) revert TargetNotAllowed();
        if (data.length >= 4) {
            bytes4 sel = bytes4(data[:4]);
            bytes memory list = BLOCKED_SELECTORS;
            for (uint256 i; i < list.length; i += 4) {
                bytes4 b;
                assembly {
                    b := mload(add(add(list, 32), i))
                }
                if (b == sel) revert SelectorBlocked();
            }
        }
    }

    /// @dev Checks every spending rule for `amount` (+ fee) and books it. Returns the fee.
    function _spend(address safe, Account storage a, address token, address to, uint256 amount)
        internal
        returns (uint256 fee)
    {
        TokenRule storage r = _rules[safe][token];
        if (!r.enabled) revert TokenNotEnabled();
        if (amount > r.maxSingle) revert OverMaxSingle();
        fee = feeFor(amount);
        uint256 total = amount + fee;
        uint256 day = block.timestamp / 1 days;
        uint256 week = (day + 3) / 7; // weeks start Monday 00:00 UTC
        uint256 d = spentOnDay[safe][token][day] + total;
        if (d > r.daily) revert OverDaily();
        uint256 w = spentInWeek[safe][token][week] + total;
        if (w > r.weekly) revert OverWeekly();
        uint256 cpCap = counterpartyLimit[safe][token][to];
        if (cpCap == 0) cpCap = r.perCounterpartyDaily;
        bytes32 key = keccak256(abi.encode(safe, token, to, day));
        uint256 c = counterpartySpent[key] + amount;
        if (c > cpCap) revert OverCounterparty();
        _checkWindowAndRate(a);
        spentOnDay[safe][token][day] = d;
        spentInWeek[safe][token][week] = w;
        counterpartySpent[key] = c;
    }

    function _checkWindowAndRate(Account storage a) internal {
        Config storage cfg = a.config;
        if (cfg.hoursMask != 0 && (cfg.hoursMask >> ((block.timestamp / 1 hours) % 24)) & 1 == 0) {
            revert OutsideTimeWindow();
        }
        if (cfg.daysMask != 0 && (cfg.daysMask >> ((block.timestamp / 1 days + 3) % 7)) & 1 == 0) {
            revert OutsideTimeWindow();
        }
        if (cfg.maxPerMinute != 0) {
            uint64 minute = uint64(block.timestamp / 60);
            if (a.minute != minute) {
                a.minute = minute;
                a.minuteCount = 0;
            }
            if (a.minuteCount >= cfg.maxPerMinute) revert RateLimited();
            a.minuteCount += 1;
        }
    }

    function _settleOutflow(address safe, Account storage a, address token, address to, uint256 before_, uint256 after_)
        internal
    {
        if (after_ >= before_) return;
        uint256 out = before_ - after_;
        uint256 fee = _spend(safe, a, token, to, out);
        if (fee > 0) _transferOut(safe, token, FEE_RECIPIENT, fee);
        emit Outflow(safe, token, to, out, fee);
    }

    function _applySplits(address safe, address token, uint256 value) internal {
        Split[] storage s = _splits[safe];
        for (uint256 i; i < s.length; ++i) {
            uint256 part = value * s[i].bps / 10_000;
            if (part == 0) continue;
            _transferOut(safe, token, s[i].to, part);
            emit SplitPaid(safe, token, s[i].to, part);
        }
    }

    function _transferOut(address safe, address token, address to, uint256 amount) internal {
        if (token == ETH) {
            _exec(safe, to, amount, "");
        } else {
            _execOk(safe, token, 0, abi.encodeCall(IERC20Min.transfer, (to, amount)));
        }
    }

    /// @dev CALL only (operation 0). Never delegatecall.
    function _exec(address safe, address to, uint256 value, bytes memory data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = ISafe(safe).execTransactionFromModuleReturnData(to, value, data, 0);
        if (!ok) revert ExecFailed();
    }

    /// @dev Like _exec, and the call must return nothing or `true` (ERC-20 style).
    function _execOk(address safe, address to, uint256 value, bytes memory data) internal {
        bytes memory ret = _exec(safe, to, value, data);
        if (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1)) revert ExecFailed();
        if (ret.length == 0 && to.code.length == 0) revert ExecFailed();
    }

    function _hashTyped(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Purser"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function _left(uint256 cap, uint256 used) internal pure returns (uint256) {
        return used >= cap ? 0 : cap - used;
    }

    function _contains(address[] calldata list, address x) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == x) return true;
        }
        return false;
    }
}
