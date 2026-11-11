// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {MockToken} from "./Mocks.sol";

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Fork tests run against the live Robinhood Chain (4663). RPC_URL overrides the public node;
///         RPC_URL="" skips every fork test cleanly.
abstract contract ForkBase is Base {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant IDENTITY_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant USDG_WETH_POOL_100 = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca; // holds USDG, used as a funder
    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant STEAKHOUSE_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;
    bytes32 constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bool internal forked;

    function _fork() internal returns (bool) {
        string memory rpc = vm.envOr("RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 4663, "not Robinhood Chain");
        _labels();
        _deployPurser(IDENTITY_REGISTRY);
        usd = MockToken(USDG); // only standard ERC-20 functions are called on it
        forked = true;
        return true;
    }

    function _fundUsdg(address to, uint256 amount) internal {
        vm.prank(USDG_WETH_POOL_100);
        IERC20Like(USDG).transfer(to, amount);
    }

    function _usdgReceiveSig(uint256 pk, address to, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Like(USDG).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, vm.addr(pk), to, value, 0, validBefore, nonce))
            )
        );
        return _sig(pk, digest);
    }
}
