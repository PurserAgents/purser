/**
 * The "Pay an agent" button: one script tag. Usage:
 *   <script src="https://ENGINE/embed.js" data-agent="0xSAFE" data-amount="5" data-token="USDG" async></script>
 * or any element with data-purser-pay data-agent="0x..." on a page that loads the script.
 * Pays through MetaMask (EIP-1193). On a phone without an injected wallet it opens the page in the MetaMask app.
 * USDG: the payer signs an EIP-3009 authorization and the engine settles it into the agent's Safe through the
 * Purser module (the owner's splits apply). ETH: the payer sends receiveETH on the module.
 */
export const EMBED_JS = String.raw`(function () {
  "use strict";
  var ENGINE = "__ENGINE__";
  var CHAIN_ID = 4663;
  var CHAIN_HEX = "0x1237";
  var ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="flex:none"><rect x="3" y="6" width="18" height="13" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18" stroke="currentColor" stroke-width="1.6"/><circle cx="16.5" cy="14.5" r="1.4" fill="currentColor"/></svg>';

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function toUnits(v, d) {
    var p = String(v).trim().split(".");
    var frac = (p[1] || "").slice(0, d);
    while (frac.length < d) frac += "0";
    return BigInt(p[0] || "0") * (BigInt(10) ** BigInt(d)) + BigInt(frac || "0");
  }
  function randomNonce() {
    var b = new Uint8Array(32); crypto.getRandomValues(b);
    return "0x" + Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }
  function isMobile() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent); }

  async function ensureChain(eth) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
    } catch (e) {
      if (e && (e.code === 4902 || /Unrecognized chain/i.test(e.message || ""))) {
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"] }] });
      } else { throw e; }
    }
  }

  async function pay(cfg, setStatus) {
    var eth = window.ethereum;
    if (!eth) {
      if (isMobile()) { location.href = "https://metamask.app.link/dapp/" + location.host + location.pathname + location.search; return; }
      setStatus("Install MetaMask to pay.", true); return;
    }
    setStatus("Connecting...");
    var accounts = await eth.request({ method: "eth_requestAccounts" });
    var from = accounts[0];
    await ensureChain(eth);
    var info = await (await fetch(ENGINE + "/v1/paylink/" + cfg.agent)).json();
    if (info.error) throw new Error(info.error.message);
    if (cfg.token === "ETH") {
      var wei = toUnits(cfg.amount, 18);
      setStatus("Confirm in MetaMask...");
      var hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: from, to: info.ethTx.to, data: info.ethTx.data, value: "0x" + wei.toString(16) }] });
      setStatus("Paid. Transaction " + hash.slice(0, 10) + "...");
      return;
    }
    var value = toUnits(cfg.amount, 6).toString();
    var validBefore = String(Math.floor(Date.now() / 1000) + 600);
    var nonce = randomNonce();
    var typed = {
      types: {
        EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
        TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }]
      },
      domain: { name: info.usdg.name, version: info.usdg.version, chainId: CHAIN_ID, verifyingContract: info.usdg.address },
      primaryType: "TransferWithAuthorization",
      message: { from: from, to: info.safe, value: value, validAfter: "0", validBefore: validBefore, nonce: nonce }
    };
    setStatus("Sign in MetaMask...");
    var signature = await eth.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typed)] });
    var payload = {
      x402Version: 2,
      accepted: { scheme: "exact", network: "eip155:4663", amount: value, asset: info.usdg.address, payTo: info.safe, maxTimeoutSeconds: 600, extra: { name: info.usdg.name, version: info.usdg.version } },
      payload: { signature: signature, authorization: { from: from, to: info.safe, value: value, validAfter: "0", validBefore: validBefore, nonce: nonce } }
    };
    setStatus("Settling...");
    var res = await (await fetch(info.settleUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: payload, amount: value }) })).json();
    if (!res.success) throw new Error(res.errorReason || "payment failed");
    setStatus("Paid. Transaction " + res.transaction.slice(0, 10) + "...");
  }

  function mount(node, after) {
    if (node.__purserMounted) return;
    node.__purserMounted = true;
    var cfg = {
      agent: node.getAttribute("data-agent"),
      amount: node.getAttribute("data-amount") || "1",
      token: (node.getAttribute("data-token") || "USDG").toUpperCase(),
      label: node.getAttribute("data-label") || "Pay this agent"
    };
    if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.agent || "")) return;
    var wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;flex-direction:column;gap:6px;font:500 14px/1.2 system-ui,-apple-system,Segoe UI,sans-serif";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = "display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:10px;border:1px solid #111;background:#111;color:#fff;cursor:pointer;font:inherit";
    btn.innerHTML = ICON + "<span>" + esc(cfg.label) + " &middot; " + esc(cfg.amount) + " " + esc(cfg.token) + "</span>";
    var status = document.createElement("span");
    status.setAttribute("role", "status");
    status.style.cssText = "font-size:12px;color:#555";
    function setStatus(t, err) { status.textContent = t; status.style.color = err ? "#b42318" : "#555"; }
    btn.addEventListener("click", function () {
      btn.disabled = true;
      pay(cfg, setStatus).catch(function (e) { setStatus((e && e.message) || "Payment cancelled.", true); }).finally(function () { btn.disabled = false; });
    });
    wrap.appendChild(btn);
    wrap.appendChild(status);
    if (after) node.parentNode.insertBefore(wrap, node.nextSibling); else node.appendChild(wrap);
  }

  function scan() {
    var nodes = document.querySelectorAll("[data-purser-pay]");
    for (var i = 0; i < nodes.length; i++) mount(nodes[i], false);
    var scripts = document.querySelectorAll('script[src*="embed.js"][data-agent]');
    for (var j = 0; j < scripts.length; j++) mount(scripts[j], true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan); else scan();
  window.PurserPay = { mount: mount, scan: scan };
})();
`;
