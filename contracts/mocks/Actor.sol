// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEscrowLike {
    function refund(uint256 jobId) external;
    function withdraw(address token) external;
    function claimAfterReview(uint256 jobId) external;
    function createJob(address provider, address token, uint256 amount, uint64 deadline, address arbiter)
        external
        payable
        returns (uint256);
}

/// @dev A contract wallet that can act as client/provider. It can reject ETH (to test the pull-payment
///      fallback) or try to re-enter the escrow when it receives ETH (to test reentrancy protection).
contract Actor {
    enum Attack {
        None,
        Refund,
        Claim,
        Withdraw,
        CreateJob
    }

    bool public acceptEth = true;
    Attack public attack;
    uint256 public attackJobId;
    address public escrow;
    bool public attackReverted; // whether the re-entrant call failed (it should)
    uint256 public attackAttempts;

    function setAcceptEth(bool v) external {
        acceptEth = v;
    }

    function setAttack(address escrow_, Attack a, uint256 jobId) external {
        escrow = escrow_;
        attack = a;
        attackJobId = jobId;
    }

    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        if (attack != Attack.None) {
            attackAttempts++;
            bytes memory data;
            if (attack == Attack.Refund) data = abi.encodeCall(IEscrowLike.refund, (attackJobId));
            else if (attack == Attack.Claim) data = abi.encodeCall(IEscrowLike.claimAfterReview, (attackJobId));
            else if (attack == Attack.Withdraw) data = abi.encodeCall(IEscrowLike.withdraw, (address(0)));
            else data = abi.encodeCall(IEscrowLike.createJob, (address(1), address(0), 1, type(uint64).max, address(0)));
            (bool ok,) = escrow.call{value: attack == Attack.CreateJob ? 1 : 0}(data);
            attackReverted = !ok;
            return;
        }
        require(acceptEth, "no eth");
    }
}
