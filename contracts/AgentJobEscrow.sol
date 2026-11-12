// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AgentJobEscrow is Ownable2Step, ReentrancyGuard {

    enum Status {
        None,
        Funded,
        Delivered,
        Released,
        Refunded,
        Disputed,
        Resolved
    }

    struct Job {
        address client;
        address provider;
        address arbiter;
        address token;
        uint96 amount;
        uint64 deadline;
        uint64 reviewEnd;
        uint16 feeBps;
        Status status;
        bytes32 deliveryHash;
    }

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000;
    uint64 public constant MAX_REVIEW_WINDOW = 30 days;
    uint256 private constant ETH_PUSH_GAS = 100_000;

    uint16 public feeBps;
    address public feeRecipient;
    uint64 public reviewWindow = 3 days;

    uint256 public nextJobId = 1;
    mapping(uint256 jobId => Job) private _jobs;

    mapping(address token => mapping(address account => uint256)) public pending;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address token,
        uint256 amount,
        uint64 deadline,
        address arbiter,
        uint16 feeBps
    );
    event DeliverySubmitted(uint256 indexed jobId, bytes32 deliveryHash, uint64 reviewEnd);
    event JobReleased(uint256 indexed jobId, uint256 providerPayout, uint256 fee, bool byProvider);
    event JobRefunded(uint256 indexed jobId, uint256 amount);
    event JobDisputed(uint256 indexed jobId, address indexed by);
    event JobResolved(
        uint256 indexed jobId, uint16 providerBps, uint256 providerPayout, uint256 fee, uint256 clientRefund
    );
    event PayoutCredited(address indexed token, address indexed account, uint256 amount);
    event Withdrawn(address indexed token, address indexed account, uint256 amount);
    event FeeBpsUpdated(uint16 feeBps);
    event FeeRecipientUpdated(address feeRecipient);
    event ReviewWindowUpdated(uint64 reviewWindow);

    error ZeroAddress();
    error ZeroAmount();
    error AmountTooLarge();
    error InvalidDeadline();
    error InvalidParties();
    error NotAContract(address token);
    error WrongEthValue();
    error UnexpectedEth();
    error UnsupportedToken();
    error TokenTransferFailed();
    error FeeTooHigh();
    error ReviewWindowTooLong();
    error JobNotFound(uint256 jobId);
    error WrongState(Status current);
    error NotClient();
    error NotProvider();
    error NotArbiter();
    error NotParty();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error ReviewWindowOpen();
    error ReviewWindowClosed();
    error NoArbiter();
    error InvalidBps();
    error NothingToWithdraw();
    error WithdrawFailed();

    constructor(address initialOwner, uint16 initialFeeBps, address initialFeeRecipient) Ownable(initialOwner) {
        _setFeeBps(initialFeeBps);
        _setFeeRecipient(initialFeeRecipient);
    }

    function createJob(address provider, address token, uint256 amount, uint64 deadline, address arbiter)
        external
        payable
        nonReentrant
        returns (uint256 jobId)
    {
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint96).max) revert AmountTooLarge();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (provider == msg.sender || (arbiter != address(0) && (arbiter == msg.sender || arbiter == provider))) {
            revert InvalidParties();
        }

        jobId = nextJobId++;
        _jobs[jobId] = Job({
            client: msg.sender,
            provider: provider,
            arbiter: arbiter,
            token: token,
            amount: uint96(amount),
            deadline: deadline,
            reviewEnd: 0,
            feeBps: feeBps,
            status: Status.Funded,
            deliveryHash: bytes32(0)
        });

        if (token == address(0)) {
            if (msg.value != amount) revert WrongEthValue();
        } else {
            if (msg.value != 0) revert UnexpectedEth();
            if (token.code.length == 0) revert NotAContract(token);
            uint256 balBefore = IERC20(token).balanceOf(address(this));
            _pullToken(token, msg.sender, amount);
            if (IERC20(token).balanceOf(address(this)) - balBefore != amount) revert UnsupportedToken();
        }

        emit JobCreated(jobId, msg.sender, provider, token, amount, deadline, arbiter, feeBps);
    }

    function submitDelivery(uint256 jobId, bytes32 deliveryHash) external {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != Status.Funded) revert WrongState(job.status);
        if (block.timestamp > job.deadline) revert DeadlinePassed();

        job.status = Status.Delivered;
        job.deliveryHash = deliveryHash;
        uint64 reviewEnd = uint64(block.timestamp) + reviewWindow;
        job.reviewEnd = reviewEnd;

        emit DeliverySubmitted(jobId, deliveryHash, reviewEnd);
    }

    function approve(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        _release(jobId, job, false);
    }

    function claimAfterReview(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != Status.Delivered) revert WrongState(job.status);
        if (block.timestamp <= job.reviewEnd) revert ReviewWindowOpen();
        _release(jobId, job, true);
    }

    function refund(uint256 jobId) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.client) revert NotClient();
        if (job.status != Status.Funded) revert WrongState(job.status);
        if (block.timestamp <= job.deadline) revert DeadlineNotPassed();

        job.status = Status.Refunded;
        uint256 amount = job.amount;
        _pay(job.token, job.client, amount);

        emit JobRefunded(jobId, amount);
    }

    function dispute(uint256 jobId) external {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.client && msg.sender != job.provider) revert NotParty();
        if (job.status != Status.Delivered) revert WrongState(job.status);
        if (job.arbiter == address(0)) revert NoArbiter();
        if (block.timestamp > job.reviewEnd) revert ReviewWindowClosed();

        job.status = Status.Disputed;

        emit JobDisputed(jobId, msg.sender);
    }

    function resolve(uint256 jobId, uint16 providerBps) external nonReentrant {
        Job storage job = _getJob(jobId);
        if (msg.sender != job.arbiter) revert NotArbiter();
        if (job.status != Status.Disputed) revert WrongState(job.status);
        if (providerBps > BPS) revert InvalidBps();

        job.status = Status.Resolved;

        (uint256 providerNet, uint256 fee, uint256 clientPart) = splitAmount(job.amount, providerBps, job.feeBps);
        _payout(job, providerNet, fee, clientPart);

        emit JobResolved(jobId, providerBps, providerNet, fee, clientPart);
    }

    function withdraw(address token) external nonReentrant {
        uint256 amount = pending[token][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pending[token][msg.sender] = 0;

        if (token == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert WithdrawFailed();
        } else {
            _pushToken(token, msg.sender, amount);
        }

        emit Withdrawn(token, msg.sender, amount);
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        _setFeeBps(newFeeBps);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        _setFeeRecipient(newRecipient);
    }

    function setReviewWindow(uint64 newWindow) external onlyOwner {
        if (newWindow > MAX_REVIEW_WINDOW) revert ReviewWindowTooLong();
        reviewWindow = newWindow;
        emit ReviewWindowUpdated(newWindow);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _getJob(jobId);
    }

    function splitAmount(uint256 amount, uint16 providerBps, uint16 feeBps_)
        public
        pure
        returns (uint256 providerNet, uint256 fee, uint256 clientPart)
    {
        uint256 providerPart = (amount * providerBps) / BPS;
        fee = (providerPart * feeBps_) / BPS;
        providerNet = providerPart - fee;
        clientPart = amount - providerPart;
    }

    function _getJob(uint256 jobId) private view returns (Job storage job) {
        job = _jobs[jobId];
        if (job.status == Status.None) revert JobNotFound(jobId);
    }

    function _release(uint256 jobId, Job storage job, bool byProvider) private {
        if (job.status != Status.Delivered) revert WrongState(job.status);
        job.status = Status.Released;

        (uint256 providerNet, uint256 fee,) = splitAmount(job.amount, uint16(BPS), job.feeBps);
        _payout(job, providerNet, fee, 0);

        emit JobReleased(jobId, providerNet, fee, byProvider);
    }

    function _payout(Job storage job, uint256 providerNet, uint256 fee, uint256 clientPart) private {
        address token = job.token;
        if (providerNet > 0) _pay(token, job.provider, providerNet);
        if (fee > 0) _pay(token, feeRecipient, fee);
        if (clientPart > 0) _pay(token, job.client, clientPart);
    }

    function _pay(address token, address to, uint256 amount) private {
        bool ok = token == address(0) ? _tryPushEth(to, amount) : _tryPushToken(token, to, amount);
        if (!ok) {
            pending[token][to] += amount;
            emit PayoutCredited(token, to, amount);
        }
    }

    function _tryPushEth(address to, uint256 amount) private returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(ETH_PUSH_GAS, to, amount, 0, 0, 0, 0)
        }
    }

    function _tryPushToken(address token, address to, uint256 amount) private returns (bool) {
        return _callToken(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _pushToken(address token, address to, uint256 amount) private {
        if (!_tryPushToken(token, to, amount)) revert TokenTransferFailed();
    }

    function _pullToken(address token, address from, uint256 amount) private {
        if (!_callToken(token, abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)))) {
            revert TokenTransferFailed();
        }
    }

    function _callToken(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }

    function _setFeeBps(uint16 newFeeBps) private {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    function _setFeeRecipient(address newRecipient) private {
        if (newRecipient == address(0)) revert ZeroAddress();
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(newRecipient);
    }
}
