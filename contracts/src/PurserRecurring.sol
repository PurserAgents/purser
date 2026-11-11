// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe} from "./Interfaces.sol";
import {PurserModule} from "./PurserModule.sol";

/// @title PurserRecurring
/// @notice Streams (pay per second, kept alive by the payee's heartbeats) and subscriptions (a fixed amount every
///         period). An account opts in by enabling this contract as an extension in PurserModule. Creating a stream
///         or a subscription needs the agent's signature (plus co-sign, firewall and owner approval by the account's
///         rules); every settlement is a payment through the module's spending rules. Holds no funds.
contract PurserRecurring {
    bytes32 public constant STREAM_TYPEHASH = keccak256(
        "Stream(address payee,address token,uint256 ratePerSecond,uint256 maxDuration,uint256 grace)"
    );
    bytes32 public constant SUBSCRIPTION_TYPEHASH =
        keccak256("Subscription(address payee,address token,uint256 amount,uint256 period,uint256 maxCharges)");
    bytes32 public constant STOP_TYPEHASH = keccak256("Stop(uint256 kind,uint256 id)");
    bytes32 public constant HEARTBEAT_TYPEHASH = keccak256("Heartbeat(uint256 streamId,uint256 upTo)");
    uint256 public constant MIN_PERIOD = 1 hours;

    PurserModule public immutable MODULE;
    bytes32 public immutable DOMAIN_SEPARATOR;

    struct Stream {
        address safe;
        address payee;
        address token;
        uint128 rate; // token units per second
        uint64 start;
        uint64 end; // max end, or the stop time
        uint64 settledUntil;
        uint64 lastBeat;
        uint32 grace; // seconds paid after the last heartbeat
    }

    struct Subscription {
        address safe;
        address payee;
        address token;
        uint128 amount;
        uint64 period;
        uint64 nextDue;
        uint32 chargesLeft;
        bool active;
    }

    uint256 public streamCount;
    uint256 public subscriptionCount;
    mapping(uint256 => Stream) public streams;
    mapping(uint256 => Subscription) public subscriptions;

    event StreamCreated(
        uint256 indexed id, address indexed safe, address indexed payee, address token, uint256 rate, uint64 end, uint32 grace
    );
    event StreamQueued(address indexed safe, address indexed payee, bytes32 opHash);
    event Heartbeat(uint256 indexed id, uint64 upTo);
    event StreamSettled(uint256 indexed id, uint256 amount, uint64 until);
    event StreamStopped(uint256 indexed id, address indexed by);
    event SubscriptionCreated(
        uint256 indexed id, address indexed safe, address indexed payee, address token, uint256 amount, uint64 period
    );
    event SubscriptionQueued(address indexed safe, address indexed payee, bytes32 opHash);
    event SubscriptionCharged(uint256 indexed id, uint256 amount, uint64 nextDue);
    event SubscriptionCancelled(uint256 indexed id, address indexed by);

    error BadParams();
    error NotAllowed();
    error NotDue();
    error BadSignature();

    constructor(PurserModule module) {
        MODULE = module;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Purser Recurring"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------- streams

    function streamOpHash(address payee, address token, uint256 rate, uint256 maxDuration, uint256 grace)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(STREAM_TYPEHASH, payee, token, rate, maxDuration, grace));
    }

    /// @return id 0 when the stream was queued for the owner's approval.
    function createStream(
        address safe,
        address payee,
        address token,
        uint128 rate,
        uint64 maxDuration,
        uint32 grace,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sigs
    ) external returns (uint256 id) {
        if (payee == address(0) || payee == safe || rate == 0 || maxDuration == 0 || grace == 0) revert BadParams();
        bytes32 opHash = streamOpHash(payee, token, rate, maxDuration, grace);
        uint256 total = uint256(rate) * maxDuration;
        if (!MODULE.authorizeAgentOp(safe, opHash, token, total, nonce, deadline, sigs)) {
            emit StreamQueued(safe, payee, opHash);
            return 0;
        }
        id = ++streamCount;
        uint64 now_ = uint64(block.timestamp);
        streams[id] = Stream(safe, payee, token, rate, now_, now_ + maxDuration, now_, now_, grace);
        emit StreamCreated(id, safe, payee, token, rate, now_ + maxDuration, grace);
    }

    /// @notice The payee says it delivered up to `upTo`. Sent by the payee, or relayed with the payee's signature.
    ///         When the payee is itself a Purser account, its agent key may sign for it.
    function heartbeat(uint256 id, uint64 upTo, bytes calldata payeeSig) external {
        Stream storage s = streams[id];
        if (s.safe == address(0)) revert BadParams();
        if (msg.sender != s.payee) {
            bytes32 digest = _digest(keccak256(abi.encode(HEARTBEAT_TYPEHASH, id, upTo)));
            address signer = _recover(digest, payeeSig);
            if (signer != s.payee && !_isPayeeAgent(s.payee, signer)) revert BadSignature();
        }
        if (upTo > block.timestamp) upTo = uint64(block.timestamp);
        if (upTo > s.lastBeat) {
            s.lastBeat = upTo;
            emit Heartbeat(id, upTo);
        }
    }

    /// @notice Paid up to min(now, end, last heartbeat + grace).
    function accrued(uint256 id) public view returns (uint256 amount, uint64 until) {
        Stream storage s = streams[id];
        until = uint64(block.timestamp);
        if (s.end < until) until = s.end;
        uint64 beatLimit = s.lastBeat + s.grace;
        if (beatLimit < until) until = beatLimit;
        if (until <= s.settledUntil) return (0, s.settledUntil);
        amount = uint256(until - s.settledUntil) * s.rate;
    }

    /// @notice Anyone may settle; the payment goes through the module's rules.
    function settle(uint256 id) public returns (uint256 amount) {
        Stream storage s = streams[id];
        if (s.safe == address(0)) revert BadParams();
        uint64 until;
        (amount, until) = accrued(id);
        if (amount == 0) return 0;
        s.settledUntil = until;
        MODULE.extPay(s.safe, s.token, s.payee, amount, bytes32(id));
        emit StreamSettled(id, amount, until);
    }

    /// @notice Stop a stream: the payee, the Safe or a Safe owner directly, or the agent with a signature.
    function stopStream(uint256 id, uint256 nonce, uint256 deadline, bytes calldata sigs) external {
        Stream storage s = streams[id];
        if (s.safe == address(0)) revert BadParams();
        _authorizeStop(s.safe, s.payee, s.token, 1, id, nonce, deadline, sigs);
        if (s.end > block.timestamp) s.end = uint64(block.timestamp);
        try this.settle(id) {} catch {}
        emit StreamStopped(id, msg.sender);
    }

    // ---------------------------------------------------------------- subscriptions

    function subscriptionOpHash(address payee, address token, uint256 amount, uint256 period, uint256 maxCharges)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(SUBSCRIPTION_TYPEHASH, payee, token, amount, period, maxCharges));
    }

    /// @notice Creates a subscription and charges the first period. Returns 0 when queued for approval.
    function createSubscription(
        address safe,
        address payee,
        address token,
        uint128 amount,
        uint64 period,
        uint32 maxCharges,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sigs
    ) external returns (uint256 id) {
        if (payee == address(0) || payee == safe || amount == 0 || period < MIN_PERIOD || maxCharges == 0) {
            revert BadParams();
        }
        bytes32 opHash = subscriptionOpHash(payee, token, amount, period, maxCharges);
        if (!MODULE.authorizeAgentOp(safe, opHash, token, uint256(amount) * maxCharges, nonce, deadline, sigs)) {
            emit SubscriptionQueued(safe, payee, opHash);
            return 0;
        }
        id = ++subscriptionCount;
        subscriptions[id] = Subscription(safe, payee, token, amount, period, uint64(block.timestamp), maxCharges, true);
        emit SubscriptionCreated(id, safe, payee, token, amount, period);
        charge(id);
    }

    /// @notice Anyone may charge a due subscription; the payment goes through the module's rules.
    function charge(uint256 id) public {
        Subscription storage s = subscriptions[id];
        if (!s.active || s.chargesLeft == 0 || block.timestamp < s.nextDue) revert NotDue();
        s.nextDue += s.period;
        s.chargesLeft -= 1;
        if (s.chargesLeft == 0) s.active = false;
        MODULE.extPay(s.safe, s.token, s.payee, s.amount, bytes32(id));
        emit SubscriptionCharged(id, s.amount, s.nextDue);
    }

    function cancelSubscription(uint256 id, uint256 nonce, uint256 deadline, bytes calldata sigs) external {
        Subscription storage s = subscriptions[id];
        if (s.safe == address(0)) revert BadParams();
        _authorizeStop(s.safe, s.payee, s.token, 2, id, nonce, deadline, sigs);
        s.active = false;
        emit SubscriptionCancelled(id, msg.sender);
    }

    // ---------------------------------------------------------------- internals

    function _authorizeStop(
        address safe,
        address payee,
        address token,
        uint256 kind,
        uint256 id,
        uint256 nonce,
        uint256 deadline,
        bytes calldata sigs
    ) internal {
        if (msg.sender == payee || msg.sender == safe || ISafe(safe).isOwner(msg.sender)) return;
        bytes32 opHash = keccak256(abi.encode(STOP_TYPEHASH, kind, id));
        if (!MODULE.authorizeAgentOp(safe, opHash, token, 0, nonce, deadline, sigs)) revert NotAllowed();
    }

    function _isPayeeAgent(address payee, address signer) internal view returns (bool) {
        if (payee.code.length == 0) return false;
        PurserModule.Account memory a = MODULE.getAccount(payee);
        return a.initialized && !a.frozen && a.config.agent == signer;
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
