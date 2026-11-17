// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test helper. A payee that burns gas whenever it receives ETH.
contract BurnOnReceive {
    uint256 public sink;

    receive() external payable {
        uint256 s = sink;
        for (uint256 i; i < 300; ++i) {
            s = uint256(keccak256(abi.encode(s, i)));
        }
        sink = s;
    }
}

/// @notice Test helper. A contract the Safe owns that changes owner without any event, behind a wrapper of its own
///         that no decoder knows.
contract SilentOwned {
    address public owner;

    constructor(address o) {
        owner = o;
    }

    function setOwner(address n) external {
        require(msg.sender == owner, "owner");
        owner = n;
    }

    function wrap(uint8 tag, bytes calldata data) external {
        require(tag != 0, "tag");
        (bool ok,) = address(this).delegatecall(data);
        require(ok, "call");
    }
}

/// @notice Test helper. Code a Safe could be pointed at: it moves the ETH only when the gas price is zero, as in a
///         replay without fee fields, and moves nothing on chain.
contract GasPriceSafe {
    function isModuleEnabled(address) external pure returns (bool) {
        return true;
    }

    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8)
        external
        returns (bool, bytes memory)
    {
        if (tx.gasprice == 0) {
            (bool ok,) = to.call{value: value}(data);
            return (ok, abi.encode(true));
        }
        return (true, abi.encode(true));
    }
}
