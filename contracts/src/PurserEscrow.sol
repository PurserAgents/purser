// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Min} from "./Interfaces.sol";

/// @title PurserEscrow
/// @notice Escrow for one job between two parties (agent to agent invoices). The payer funds a job, the payee
///         delivers, and the money goes out by rule only: to the payee on release (or when the review window ends
///         without a dispute), back to the payer after the deadline when nothing was delivered, or split by the
///         arbiter both parties named when there is a dispute. There is no owner and no fee.
contract PurserEscrow {
    enum Status {
        None,
        Funded,
        Delivered,
        Disputed,
        Released,
        Refunded,
        Resolved
    }

    struct Job {
        address payer;
        address payee;
        address arbiter; // 0 = no arbiter: a dispute refunds the payer
        address token; // address(0) = ETH
        uint128 amount;
        uint64 deadline; // delivery deadline
        uint64 reviewUntil; // set on delivery
        uint32 reviewPeriod;
        Status status;
        bytes32 invoiceRef;
        bytes32 deliveryHash;
    }

    uint256 public constant ARBITER_TIMEOUT = 30 days;

    uint256 public jobCount;
    mapping(uint256 => Job) public jobs;
    uint256 private _lock = 1;

    event JobFunded(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        uint64 deadline,
        bytes32 invoiceRef
    );
    event JobDelivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewUntil);
    event JobDisputed(uint256 indexed id);
    event JobReleased(uint256 indexed id, uint256 amount);
    event JobRefunded(uint256 indexed id, uint256 amount);
    event JobResolved(uint256 indexed id, uint256 toPayee, uint256 toPayer);

    error BadParams();
    error NotAllowed();
    error WrongStatus();
    error TooEarly();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Fund a job. ERC-20: the payer approved `amount` to this contract (Purser's module grants and resets
    ///         an exact allowance in the same call). ETH: send `amount` as value.
    function fund(
        address payee,
        address arbiter,
        address token,
        uint128 amount,
        uint64 deadline,
        uint32 reviewPeriod,
        bytes32 invoiceRef
    ) external payable nonReentrant returns (uint256 id) {
        if (payee == address(0) || payee == msg.sender || arbiter == msg.sender || arbiter == payee) revert BadParams();
        if (amount == 0 || deadline <= block.timestamp || reviewPeriod == 0) revert BadParams();
        if (token == address(0)) {
            if (msg.value != amount) revert BadParams();
        } else {
            if (msg.value != 0) revert BadParams();
            if (token.code.length == 0) revert TransferFailed();
            uint256 before = IERC20Min(token).balanceOf(address(this));
            if (!_tryTransferFrom(token, msg.sender, amount)) revert TransferFailed();
            if (IERC20Min(token).balanceOf(address(this)) != before + amount) revert TransferFailed();
        }
        id = ++jobCount;
        jobs[id] = Job(msg.sender, payee, arbiter, token, amount, deadline, 0, reviewPeriod, Status.Funded, invoiceRef, 0);
        emit JobFunded(id, msg.sender, payee, token, amount, deadline, invoiceRef);
    }

    /// @notice The payee marks the work delivered before the deadline; the review window starts.
    function deliver(uint256 id, bytes32 deliveryHash) external {
        Job storage j = jobs[id];
        if (msg.sender != j.payee) revert NotAllowed();
        if (j.status != Status.Funded) revert WrongStatus();
        if (block.timestamp > j.deadline) revert TooEarly();
        j.status = Status.Delivered;
        j.deliveryHash = deliveryHash;
        j.reviewUntil = uint64(block.timestamp) + j.reviewPeriod;
        emit JobDelivered(id, deliveryHash, j.reviewUntil);
    }

    /// @notice The payer accepts (before or after delivery): the payee is paid in full.
    function release(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.payer) revert NotAllowed();
        if (j.status != Status.Funded && j.status != Status.Delivered) revert WrongStatus();
        j.status = Status.Released;
        _send(j.token, j.payee, j.amount);
        emit JobReleased(id, j.amount);
    }

    /// @notice After the review window with no dispute, anyone can pay the payee.
    function claim(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.status != Status.Delivered) revert WrongStatus();
        if (block.timestamp <= j.reviewUntil) revert TooEarly();
        j.status = Status.Released;
        _send(j.token, j.payee, j.amount);
        emit JobReleased(id, j.amount);
    }

    /// @notice The payer disputes a delivery inside the review window.
    function dispute(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.payer) revert NotAllowed();
        if (j.status != Status.Delivered || block.timestamp > j.reviewUntil) revert WrongStatus();
        if (j.arbiter == address(0)) {
            j.status = Status.Refunded;
            _send(j.token, j.payer, j.amount);
            emit JobRefunded(id, j.amount);
            return;
        }
        j.status = Status.Disputed;
        emit JobDisputed(id);
    }

    /// @notice The arbiter splits a disputed job: `payeeBps` of the amount to the payee, the rest to the payer.
    function resolve(uint256 id, uint16 payeeBps) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.arbiter) revert NotAllowed();
        if (j.status != Status.Disputed) revert WrongStatus();
        if (payeeBps > 10_000) revert BadParams();
        j.status = Status.Resolved;
        uint256 toPayee = uint256(j.amount) * payeeBps / 10_000;
        uint256 toPayer = j.amount - toPayee;
        if (toPayee > 0) _send(j.token, j.payee, toPayee);
        if (toPayer > 0) _send(j.token, j.payer, toPayer);
        emit JobResolved(id, toPayee, toPayer);
    }

    /// @notice Anyone can refund the payer: after the deadline with no delivery, or when the arbiter has not
    ///         resolved a dispute within ARBITER_TIMEOUT after the review window.
    function refund(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        bool undelivered = j.status == Status.Funded && block.timestamp > j.deadline;
        bool stuck = j.status == Status.Disputed && block.timestamp > uint256(j.reviewUntil) + ARBITER_TIMEOUT;
        if (!undelivered && !stuck) revert TooEarly();
        j.status = Status.Refunded;
        _send(j.token, j.payer, j.amount);
        emit JobRefunded(id, j.amount);
    }

    function getJob(uint256 id) external view returns (Job memory) {
        return jobs[id];
    }

    function _send(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        }
    }

    function _tryTransferFrom(address token, address from, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeCall(IERC20Min.transferFrom, (from, address(this), amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}
