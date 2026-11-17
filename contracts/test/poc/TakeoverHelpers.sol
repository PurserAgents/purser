// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test helper. A contract the Safe owns, with its own batch entry points: an OpenZeppelin-style
///         multicall(bytes[]) and a custom wrapper the firewall cannot decode. Both run calls on itself.
contract OwnedMulti {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address o) {
        owner = o;
        emit OwnershipTransferred(address(0), o);
    }

    function transferOwnership(address n) external {
        require(msg.sender == owner, "owner");
        emit OwnershipTransferred(owner, n);
        owner = n;
    }

    function multicall(bytes[] calldata data) external returns (bytes[] memory out) {
        out = new bytes[](data.length);
        for (uint256 i; i < data.length; ++i) {
            (bool ok, bytes memory r) = address(this).delegatecall(data[i]);
            require(ok, "call");
            out[i] = r;
        }
    }

    /// @dev A shape no decoder knows: the selector check cannot see inside, the logs still show what happened.
    function poke(uint8 tag, bytes calldata data) external {
        require(tag == 7, "tag");
        (bool ok,) = address(this).delegatecall(data);
        require(ok, "call");
    }
}

/// @notice Test helper. Grants roles; the default admin role (zero) is the one that controls the contract.
contract RoleThing {
    address public admin;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);

    constructor(address a) {
        admin = a;
    }

    function grantRole(bytes32 role, address account) external {
        require(msg.sender == admin, "admin");
        emit RoleGranted(role, account, msg.sender);
    }
}

/// @notice Test helper. Deploys a contract owned by the caller: its constructor emits OwnershipTransferred(0, caller),
///         which is not a takeover.
contract OwnedFactory {
    event Made(address thing);

    function make() external returns (address t) {
        t = address(new OwnedMulti(msg.sender));
        emit Made(t);
    }
}
