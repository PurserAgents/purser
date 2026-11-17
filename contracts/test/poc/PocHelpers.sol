// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Proof helper (HEY Research Lab). A contract that is NOT a Safe. It answers the few Safe calls the Purser
///         module and engine make, and moves no money: every "transfer" the module asks for reports success.
contract FakeSafe {
    address public immutable boss;

    constructor() {
        boss = msg.sender;
    }

    function isModuleEnabled(address) external pure returns (bool) {
        return true;
    }

    function isOwner(address) external pure returns (bool) {
        return true;
    }

    function getOwners() external view returns (address[] memory o) {
        o = new address[](1);
        o[0] = boss;
    }

    function getThreshold() external pure returns (uint256) {
        return 1;
    }

    function nonce() external pure returns (uint256) {
        return 0;
    }

    /// @dev What a real Safe would run for the module. Here: nothing happens, and it answers (true, true).
    function execTransactionFromModuleReturnData(address, uint256, bytes calldata, uint8)
        external
        pure
        returns (bool, bytes memory)
    {
        return (true, abi.encode(true));
    }

    /// @dev Lets the attacker's wallet make this contract call the module (initialize, setConfig, setAllowed).
    function run(address to, bytes calldata data) external {
        require(msg.sender == boss, "boss");
        (bool ok, bytes memory r) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(r, 32), mload(r))
            }
        }
    }
}

/// @notice Proof helper. A contract the Safe owns. transferOwnership is on the firewall's "takeover-style call" list.
contract OwnedThing {
    address public owner;

    constructor(address o) {
        owner = o;
    }

    function transferOwnership(address n) external {
        require(msg.sender == owner, "owner");
        owner = n;
    }
}

/// @notice Proof helper. Looks enough like an EIP-3009 token for the x402 facilitator, and burns gas when "settled".
contract GasBurner {
    uint256 public sink;

    function balanceOf(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function authorizationState(address, bytes32) external pure returns (bool) {
        return false;
    }

    function transferWithAuthorization(address, address, uint256 loops, uint256, uint256, bytes32, bytes calldata)
        external
    {
        uint256 s = sink;
        assembly {
            for { let i := 0 } lt(i, loops) { i := add(i, 1) } {
                mstore(0, s)
                s := keccak256(0, 32)
            }
        }
        sink = s;
    }
}
