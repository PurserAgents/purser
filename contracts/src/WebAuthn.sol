// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title WebAuthn
/// @notice Verifies a WebAuthn (passkey) assertion over a 32-byte challenge with the P-256 verify precompile at
///         address 0x100 (RIP-7212 input layout: hash, r, s, x, y). Robinhood Chain answers there.
library WebAuthn {
    address internal constant P256_VERIFIER = address(0x100);
    /// @dev n / 2 for the P-256 curve order. Signatures with a higher s are refused (malleability).
    uint256 internal constant P256_N_DIV_2 = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    struct Assertion {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // index of `"challenge":"` in clientDataJSON
        uint256 typeIndex; // index of `"type":"webauthn.get"` in clientDataJSON
        uint256 r;
        uint256 s;
    }

    function verify(bytes32 challenge, Assertion memory a, uint256 x, uint256 y) internal view returns (bool) {
        if (a.s > P256_N_DIV_2 || a.r == 0 || a.s == 0) return false;
        bytes memory auth = a.authenticatorData;
        // authenticatorData = rpIdHash (32) | flags (1) | signCount (4) | ...; user present bit must be set.
        if (auth.length < 37 || (uint8(auth[32]) & 0x01) == 0) return false;

        bytes memory client = bytes(a.clientDataJSON);
        if (!_contains(client, a.typeIndex, bytes('"type":"webauthn.get"'))) return false;
        bytes memory expected = abi.encodePacked('"challenge":"', base64Url(abi.encodePacked(challenge)), '"');
        if (!_contains(client, a.challengeIndex, expected)) return false;

        bytes32 message = sha256(abi.encodePacked(auth, sha256(client)));
        (bool ok, bytes memory ret) = P256_VERIFIER.staticcall(abi.encode(message, a.r, a.s, x, y));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    function _contains(bytes memory hay, uint256 at, bytes memory needle) private pure returns (bool) {
        if (at + needle.length > hay.length) return false;
        for (uint256 i; i < needle.length; ++i) {
            if (hay[at + i] != needle[i]) return false;
        }
        return true;
    }

    /// @notice Base64url without padding (RFC 4648 section 5), as browsers put the challenge in clientDataJSON.
    function base64Url(bytes memory data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        uint256 len = data.length;
        uint256 outLen = (len * 8 + 5) / 6;
        bytes memory out = new bytes(outLen);
        uint256 bitBuf;
        uint256 bits;
        uint256 o;
        for (uint256 i; i < len; ++i) {
            bitBuf = (bitBuf << 8) | uint8(data[i]);
            bits += 8;
            while (bits >= 6) {
                bits -= 6;
                out[o++] = table[(bitBuf >> bits) & 0x3f];
            }
        }
        if (bits > 0) out[o++] = table[(bitBuf << (6 - bits)) & 0x3f];
        return string(out);
    }
}
