import assert from "node:assert/strict";
import { runInContext, createContext } from "node:vm";
import { after, before, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { createExactPayload } from "../../packages/sdk/src/x402.ts";
import { EMBED_JS } from "../src/embed.ts";
import { kvGet } from "../src/db.ts";
import { createAccount, fundUsdg, makeWorld, randomAddress, usdg, usdgBalance, type World } from "./harness.ts";
import { api, type Api } from "./util-api.ts";

// ------------------------------------------------------------------------------------------ a tiny DOM for the script

class El {
  children: El[] = [];
  parentNode: El | null = null;
  style = { cssText: "", color: "" };
  listeners: Record<string, () => void> = {};
  textContent = "";
  innerHTML = "";
  disabled = false;
  type = "";
  __purserMounted?: boolean;
  constructor(
    public tag: string,
    public attrs: Record<string, string> = {},
  ) {}
  getAttribute(k: string) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: El) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: El, ref: El | null) {
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    c.parentNode = this;
    return c;
  }
  get nextSibling() {
    const p = this.parentNode!;
    return p.children[p.children.indexOf(this) + 1] ?? null;
  }
  addEventListener(t: string, f: () => void) {
    this.listeners[t] = f;
  }
  find(tag: string): El | undefined {
    for (const c of this.children) {
      if (c.tag === tag) return c;
      const d = c.find(tag);
      if (d) return d;
    }
    return undefined;
  }
}

interface Page {
  sandbox: Record<string, any>;
  body: El;
  calls: { method: string; params: any[] }[];
  fetches: { url: string; body?: any }[];
}

/** Loads the script into a fresh page with the given elements, an optional wallet and a stub engine. */
function loadPage(opts: { nodes: El[]; ethereum?: boolean; mobile?: boolean; info?: any; settle?: any; switchFails?: boolean }): Page {
  const body = new El("body");
  for (const n of opts.nodes) body.appendChild(n);
  const all = () => {
    const out: El[] = [];
    const walk = (e: El) => e.children.forEach((c) => (out.push(c), walk(c)));
    walk(body);
    return out;
  };
  const calls: Page["calls"] = [];
  const fetches: Page["fetches"] = [];
  const sandbox: Record<string, any> = {
    document: {
      readyState: "complete",
      addEventListener() {},
      createElement: (t: string) => new El(t),
      querySelectorAll: (sel: string) =>
        sel === "[data-purser-pay]" ? all().filter((e) => "data-purser-pay" in e.attrs) : all().filter((e) => e.tag === "script" && /embed\.js/.test(e.attrs.src ?? "") && "data-agent" in e.attrs),
    },
    navigator: { userAgent: opts.mobile ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" : "Mozilla/5.0 (Macintosh)" },
    location: { href: "https://shop.example/page?x=1", host: "shop.example", pathname: "/page", search: "?x=1" },
    crypto: { getRandomValues: (b: Uint8Array) => b.fill(7) },
    fetch: async (url: string, init?: { body?: string }) => {
      fetches.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      const data = url.includes("/settle") ? opts.settle : opts.info;
      return { json: async () => data };
    },
  };
  if (opts.ethereum)
    sandbox.ethereum = {
      async request({ method, params }: { method: string; params?: any[] }) {
        calls.push({ method, params: JSON.parse(JSON.stringify(params ?? [])) }); // plain objects from this realm
        if (method === "eth_requestAccounts") return ["0x00000000000000000000000000000000000000f1"];
        if (method === "wallet_switchEthereumChain" && opts.switchFails) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
        if (method === "eth_signTypedData_v4") return "0x" + "ab".repeat(65);
        if (method === "eth_sendTransaction") return "0x" + "cd".repeat(32);
        return null;
      },
    };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(EMBED_JS.replace(/__ENGINE__/g, "http://engine.test"), sandbox);
  return { sandbox, body, calls, fetches };
}

const SAFE = "0x1111111111111111111111111111111111111111";
const info = { safe: SAFE, usdg: { address: "0x2222222222222222222222222222222222222222", name: "Global Dollar", version: "1" }, ethTx: { to: "0x3333333333333333333333333333333333333333", data: "0xabcdef" }, settleUrl: `http://engine.test/v1/paylink/${SAFE}/settle` };
const until = async (pred: () => boolean) => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("the pay button script (runs in a sandboxed page)", () => {
  it("is plain ES5-style JavaScript that follows the copy rules", () => {
    assert.ok(EMBED_JS.includes("__ENGINE__"), "the engine URL is filled in when served");
    assert.equal(/[—↗]/u.test(EMBED_JS), false);
    assert.equal(/\p{Extended_Pictographic}/u.test(EMBED_JS), false);
    assert.doesNotThrow(() => new Function(EMBED_JS));
  });

  it("mounts a button for each valid element, once, with the label escaped", () => {
    const a = new El("div", { "data-purser-pay": "", "data-agent": SAFE, "data-amount": "5", "data-label": '<img src=x onerror="steal()">' });
    const bad = new El("div", { "data-purser-pay": "", "data-agent": "0x1234" });
    const script = new El("script", { src: "https://engine.test/embed.js", "data-agent": SAFE, "data-token": "eth", "data-amount": "0.01" });
    const page = loadPage({ nodes: [a, bad, script] });
    const btn = a.find("button")!;
    assert.ok(btn, "button mounted inside the element");
    assert.equal(btn.innerHTML.includes("<img"), false, "label is escaped");
    assert.match(btn.innerHTML, /&#60;img src=x onerror=&#34;steal\(\)&#34;&#62; &middot; 5 USDG/);
    assert.equal(bad.children.length, 0, "an invalid agent address mounts nothing");
    const afterScript = script.nextSibling!;
    assert.equal(afterScript.tag, "span", "the script tag gets its button right after it");
    assert.match(afterScript.find("button")!.innerHTML, /Pay this agent &middot; 0\.01 ETH/);
    page.sandbox.PurserPay.scan();
    assert.equal(a.children.length, 1, "scanning again mounts nothing twice");
  });

  it("without a wallet: asks for MetaMask on a computer, opens the MetaMask app on a phone", async () => {
    const a = new El("div", { "data-purser-pay": "", "data-agent": SAFE });
    loadPage({ nodes: [a] });
    a.find("button")!.listeners.click();
    const status = a.find("span")!.children[1];
    await until(() => !!status.textContent);
    assert.equal(status.textContent, "Install MetaMask to pay.");
    assert.equal(status.style.color, "#b42318");

    const m = new El("div", { "data-purser-pay": "", "data-agent": SAFE });
    const phone = loadPage({ nodes: [m], mobile: true });
    m.find("button")!.listeners.click();
    await until(() => phone.sandbox.location.href.startsWith("https://metamask.app.link"));
    assert.equal(phone.sandbox.location.href, "https://metamask.app.link/dapp/shop.example/page?x=1");
  });

  it("USDG: adds the chain if needed, signs an EIP-3009 authorization to the Safe and settles it", async () => {
    const a = new El("div", { "data-purser-pay": "", "data-agent": SAFE, "data-amount": "1.2345678" });
    const page = loadPage({ nodes: [a], ethereum: true, switchFails: true, info, settle: { success: true, transaction: "0x1234567890abcdef" } });
    const btn = a.find("button")!;
    btn.listeners.click();
    assert.equal(btn.disabled, true, "disabled while paying");
    const status = a.find("span")!.children[1];
    await until(() => status.textContent.startsWith("Paid"));
    assert.equal(status.textContent, "Paid. Transaction 0x12345678...");
    assert.equal(btn.disabled, false);
    const methods = page.calls.map((c) => c.method);
    assert.deepEqual(methods, ["eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_signTypedData_v4"]);
    const add = page.calls[2].params[0];
    assert.equal(add.chainId, "0x1237");
    assert.deepEqual(add.rpcUrls, ["https://rpc.mainnet.chain.robinhood.com"]);
    const typed = JSON.parse(page.calls[3].params[1]);
    assert.equal(typed.primaryType, "TransferWithAuthorization");
    assert.deepEqual(typed.domain, { name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: info.usdg.address });
    assert.equal(typed.message.to, SAFE);
    assert.equal(typed.message.value, "1234567", "amount in base units, extra decimals cut");
    assert.equal(page.fetches[0].url, `http://engine.test/v1/paylink/${SAFE}`);
    const settle = page.fetches[1];
    assert.equal(settle.url, info.settleUrl);
    assert.equal(settle.body.amount, "1234567");
    assert.equal(settle.body.payload.accepted.network, "eip155:4663");
    assert.equal(settle.body.payload.payload.authorization.value, "1234567");
  });

  it("ETH: sends receiveETH on the module with the amount as value", async () => {
    const a = new El("div", { "data-purser-pay": "", "data-agent": SAFE, "data-token": "ETH", "data-amount": "0.01" });
    const page = loadPage({ nodes: [a], ethereum: true, info });
    a.find("button")!.listeners.click();
    const status = a.find("span")!.children[1];
    await until(() => status.textContent.startsWith("Paid"));
    const tx = page.calls.find((c) => c.method === "eth_sendTransaction")!.params[0];
    assert.deepEqual(tx, { from: "0x00000000000000000000000000000000000000f1", to: info.ethTx.to, data: info.ethTx.data, value: "0x" + (10n ** 16n).toString(16) });
    assert.equal(page.calls.some((c) => c.method === "wallet_addEthereumChain"), false, "the chain was already known");
  });

  it("shows the engine's reason when the account is unknown or the settlement fails", async () => {
    const a = new El("div", { "data-purser-pay": "", "data-agent": SAFE });
    loadPage({ nodes: [a], ethereum: true, info: { error: { message: "No Purser account at this address." } } });
    a.find("button")!.listeners.click();
    const status = a.find("span")!.children[1];
    await until(() => status.style.color === "#b42318");
    assert.equal(status.textContent, "No Purser account at this address.");

    const b = new El("div", { "data-purser-pay": "", "data-agent": SAFE });
    loadPage({ nodes: [b], ethereum: true, info, settle: { success: false, errorReason: "insufficient_funds" } });
    b.find("button")!.listeners.click();
    const s2 = b.find("span")!.children[1];
    await until(() => s2.style.color === "#b42318");
    assert.equal(s2.textContent, "insufficient_funds");
  });
});

describe("pay button endpoints (local anvil)", () => {
  let w: World;
  let e: Api;
  let safe: Address;
  before(async () => {
    w = await makeWorld();
    e = api(w);
    safe = await createAccount(w);
  });
  after(async () => w?.stop());

  it("serves the script with this engine's public URL filled in", async () => {
    const r = await e.app.request("/embed.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /^application\/javascript/);
    assert.match(r.headers.get("cache-control")!, /max-age=300/);
    const text = await r.text();
    assert.equal(text.includes("__ENGINE__"), false);
    assert.ok(text.includes('var ENGINE = "http://engine.test"'));
  });

  it("paylink info: a fresh reference each time, tagged for the receipt; 404 for a non-account, 400 for a bad address", async () => {
    const one = await e.get(`/v1/paylink/${safe}`);
    const two = await e.get(`/v1/paylink/${safe}`);
    assert.equal(one.status, 200);
    assert.notEqual(one.body.ref, two.body.ref);
    assert.deepEqual(JSON.parse(kvGet(w.ctx.db, `ref:${one.body.ref}`)!), { category: "storefront", memo: "Pay button", service: "paylink" });
    assert.equal(one.body.chainId, 4663);
    assert.equal(one.body.name, "Test agent");
    assert.equal(one.body.settleUrl, `http://engine.test/v1/paylink/${safe.toLowerCase()}/settle`);
    assert.equal((await e.get(`/v1/paylink/${randomAddress()}`)).status, 404);
    assert.equal((await e.get(`/v1/paylink/0x1234`)).status, 400);
  });

  it("settle refuses a missing amount (400) and a payment that does not match (402), and moves nothing", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    await fundUsdg(w, payer.address, usdg(10));
    const before = await usdgBalance(w, safe);
    assert.equal((await e.post(`/v1/paylink/${safe}/settle`, { payload: {} })).status, 400);
    assert.equal((await e.post(`/v1/paylink/${safe}/settle`, { payload: {}, amount: "1.5" })).status, 400);
    const req = { scheme: "exact" as const, network: "eip155:4663", amount: usdg(1).toString(), asset: w.dep.usdg, payTo: safe, maxTimeoutSeconds: 600, extra: { name: "Global Dollar", version: "1" } };
    const p = await createExactPayload(payer, req);
    const under = await e.post(`/v1/paylink/${safe}/settle`, { payload: p, amount: usdg(2).toString() });
    assert.equal(under.status, 402, JSON.stringify(under.body));
    assert.equal(under.body.success, false);
    const toOther = await createExactPayload(payer, { ...req, payTo: randomAddress() });
    assert.equal((await e.post(`/v1/paylink/${safe}/settle`, { payload: toOther, amount: usdg(1).toString() })).status, 402);
    assert.equal((await e.post(`/v1/paylink/${safe}/settle`, { payload: { junk: true }, amount: "1" })).status, 402);
    assert.equal(await usdgBalance(w, safe), before);
    const ok = await e.post(`/v1/paylink/${safe}/settle`, { payload: p, amount: usdg(1).toString() });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(await usdgBalance(w, safe), before + usdg(1));
    const replay = await e.post(`/v1/paylink/${safe}/settle`, { payload: p, amount: usdg(1).toString() });
    assert.equal(replay.status, 402, "the same authorization cannot pay twice");
  });
});
