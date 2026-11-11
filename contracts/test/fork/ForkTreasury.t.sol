// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IERC20Like} from "../utils/ForkBase.sol";
import {PurserModule} from "../../src/PurserModule.sol";

interface IVault {
    function asset() external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
    function previewDeposit(uint256) external view returns (uint256);
    function previewWithdraw(uint256) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function name() external view returns (string memory);
}

/// @notice 14.1 on a fork of chain 4663: idle USDG from an agent's own Safe into real ERC-4626 vaults and back.
contract ForkTreasuryTest is ForkBase {
    address constant SPARK_USDG = 0xde770c84FE66E063336b31737cFE9790f18c4087;

    function setUp() public {
        _fork();
    }

    function _roundTrip(address vault) internal {
        _createAccount(USDG);
        _fundUsdg(safe, 1_000e6);
        vm.prank(safe);
        module.setTreasuryVault(vault, true);
        assertEq(IVault(vault).asset(), USDG);
        uint256 expected = IVault(vault).previewDeposit(400e6);
        PurserModule.Treasury memory t =
            PurserModule.Treasury(safe, vault, true, 400e6, expected * 995 / 1000, nextNonce++, block.timestamp + 1 hours);
        module.treasury(t, _agentSig(_treasuryDigest(t)));
        uint256 shares = IVault(vault).balanceOf(safe);
        assertGe(shares, expected * 995 / 1000);
        assertEq(IERC20Like(USDG).balanceOf(safe), 600e6);
        assertEq(IERC20Like(USDG).allowance(safe, vault), 0);
        assertApproxEqAbs(IVault(vault).convertToAssets(shares), 400e6, 2);
        assertEq(module.spentOnDay(safe, USDG, block.timestamp / 1 days), 0, "moving to the vault is not spending");

        uint256 burn = IVault(vault).previewWithdraw(399e6);
        t = PurserModule.Treasury(safe, vault, false, 399e6, burn, nextNonce++, block.timestamp + 1 hours);
        module.treasury(t, _agentSig(_treasuryDigest(t)));
        assertEq(IERC20Like(USDG).balanceOf(safe), 999e6);
    }

    function test_fork_steakhouseUsdg_morphoVaultV2_roundTrip() public {
        _roundTrip(STEAKHOUSE_USDG);
    }

    function test_fork_sparkSavingsUsdg_roundTrip() public {
        _roundTrip(SPARK_USDG);
    }

    function test_fork_vaultNotAllowlisted_refused() public {
        _createAccount(USDG);
        _fundUsdg(safe, 100e6);
        PurserModule.Treasury memory t = PurserModule.Treasury(safe, STEAKHOUSE_USDG, true, 10e6, 0, nextNonce++, block.timestamp + 1 hours);
        bytes memory sig = _agentSig(_treasuryDigest(t));
        vm.expectRevert(PurserModule.VaultNotAllowed.selector);
        module.treasury(t, sig);
    }
}
