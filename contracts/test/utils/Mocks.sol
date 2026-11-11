// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-20 with EIP-3009 receiveWithAuthorization (bytes signature), like USDG on chain 4663.
contract MockToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(n)),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _authorize(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        require(msg.sender == to, "CallerMustBePayee");
        _authorize(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function _authorize(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) internal {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "time");
        require(!authorizationState[from][nonce], "used");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce))
            )
        );
        (bytes32 r, bytes32 s) = abi.decode(signature[:64], (bytes32, bytes32));
        require(ecrecover(digest, uint8(signature[64]), r, s) == from, "InvalidSignature");
        authorizationState[from][nonce] = true;
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Minimal ERC-8004 identity registry: register mints an id to msg.sender.
contract MockIdentityRegistry {
    uint256 public count;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => string) public tokenURI;

    function register(string calldata uri) external returns (uint256 id) {
        id = ++count;
        ownerOf[id] = msg.sender;
        tokenURI[id] = uri;
    }
}

/// @notice ERC-4626-shaped vault, 1:1 shares, for treasury unit tests.
contract MockVault {
    address public immutable asset;
    mapping(address => uint256) public balanceOf;
    string public constant name = "Test USDG Vault";
    uint8 public constant decimals = 6;

    function totalAssets() external view returns (uint256) {
        return MockToken(asset).balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function previewWithdraw(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    constructor(address a) {
        asset = a;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        MockToken(asset).transferFrom(msg.sender, address(this), assets);
        balanceOf[receiver] += assets;
        return assets;
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256) {
        require(msg.sender == owner, "owner");
        balanceOf[owner] -= assets;
        MockToken(asset).transfer(receiver, assets);
        return assets;
    }
}

/// @notice A "dapp" that pulls a spend token from the caller, like a router.
contract MockRouter {
    function pull(address token, uint256 amount) external {
        MockToken(token).transferFrom(msg.sender, address(this), amount);
    }

    function pullFrom(address token, address from, uint256 amount) external {
        MockToken(token).transferFrom(from, address(this), amount);
    }

    function takeEth() external payable {}

    function noop() external {}
}

/// @notice Remembers an allowance it was given and tries to use it later (approve-then-transferFrom attack).
contract AllowanceThief {
    function steal(address token, address from, uint256 amount) external {
        MockToken(token).transferFrom(from, address(this), amount);
    }

    function pullNow(address token, uint256 amount) external {
        MockToken(token).transferFrom(msg.sender, address(this), amount);
    }
}

/// @notice Re-enters a target with stored calldata when it receives ETH or is called.
contract Reenterer {
    address public target;
    bytes public data;
    bool public reentered;
    bool public lastOk;

    function arm(address t, bytes calldata d) external {
        target = t;
        data = d;
    }

    function poke() external {
        _go();
    }

    receive() external payable {
        _go();
    }

    function _go() internal {
        if (target != address(0) && !reentered) {
            reentered = true;
            (lastOk,) = target.call(data);
            require(lastOk, "reenter failed");
        }
    }
}

/// @notice Multicall3-like aggregator.
contract MockMulticall {
    struct C {
        address target;
        bytes data;
    }

    function aggregate(C[] calldata calls) external returns (bytes[] memory out) {
        out = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory r) = calls[i].target.call(calls[i].data);
            require(ok, "multicall: call failed");
            out[i] = r;
        }
    }
}
