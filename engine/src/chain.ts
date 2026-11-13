import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  fallback,
  http,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  purserEscrowAbi,
  purserFactoryAbi,
  purserModuleAbi,
  purserPasskeyAbi,
  purserRecurringAbi,
} from "../../packages/sdk/src/abi.ts";
import type { Config } from "./config.ts";
import { sleep } from "./util.ts";

export type Chain = ReturnType<typeof makeChain>;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True only when every configured RPC is a local node (anvil). Live sending needs PURSER_LIVE=on (see makeChain). */
export function isLocalRpc(urls: string[]): boolean {
  return urls.length > 0 && urls.every((u) => {
    try {
      return LOCAL_HOSTS.has(new URL(u).hostname);
    } catch {
      return false;
    }
  });
}

export function makeChain(cfg: Config) {
  const chain = defineChain({
    id: cfg.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls } },
  });
  const transport = cfg.rpcUrls.length > 1 ? fallback(cfg.rpcUrls.map((u) => http(u, { retryCount: 2 }))) : http(cfg.rpcUrls[0], { retryCount: 2 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const local = isLocalRpc(cfg.rpcUrls);
  // Live: only with an explicit switch, on Robinhood Chain, with a live deployment and keys. PURSER_LIVE=off rolls it back.
  const live = !local && process.env.PURSER_LIVE === "on" && cfg.chainId === 4663 && cfg.deployment?.mode === "live" && !!cfg.keys;
  const broadcast = (local && process.env.PURSER_BROADCAST !== "0" && !!cfg.keys) || live;
  // A hard cap on what each engine key may spend on gas per UTC day, so nobody can drain the keys by flooding the API.
  const capWei = BigInt(process.env.PURSER_GAS_DAY_WEI ?? "3000000000000000"); // 0.003 ETH per key per day
  const spent = new Map<string, { day: string; wei: bigint }>();
  const pollingInterval = local ? 50 : 1000;

  const accounts = {
    relayer: cfg.keys ? privateKeyToAccount(cfg.keys.relayer) : null,
    firewall: cfg.keys ? privateKeyToAccount(cfg.keys.firewall) : null,
    watchdog: cfg.keys ? privateKeyToAccount(cfg.keys.watchdog) : null,
    audit: cfg.keys ? privateKeyToAccount(cfg.keys.audit) : null,
    owner: cfg.keys?.owner ? privateKeyToAccount(cfg.keys.owner) : null,
    agent: cfg.keys?.agent ? privateKeyToAccount(cfg.keys.agent) : null,
  };

  const wallets = new Map<string, WalletClient>();
  function wallet(account: PrivateKeyAccount): WalletClient {
    let w = wallets.get(account.address);
    if (!w) {
      w = createWalletClient({ account, chain, transport });
      wallets.set(account.address, w);
    }
    return w;
  }

  // One queue per sender so nonces never race.
  const queues = new Map<string, Promise<unknown>>();
  async function send(
    account: PrivateKeyAccount,
    tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint },
  ): Promise<TransactionReceipt> {
    if (!broadcast) throw new Error("broadcast disabled: this engine only sends transactions to a local node");
    if (live) {
      const day = new Date().toISOString().slice(0, 10);
      const s = spent.get(account.address);
      const used = s && s.day === day ? s.wei : 0n;
      if (used >= capWei) throw new Error("the engine's gas budget for today is used up; it resets at 00:00 UTC");
    }
    const prev = queues.get(account.address) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const hash = await wallet(account).sendTransaction({
        account,
        chain,
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
        gas: tx.gas,
      });
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval });
      if (live) {
        const day = new Date().toISOString().slice(0, 10);
        const prevSpent = spent.get(account.address);
        const base = prevSpent && prevSpent.day === day ? prevSpent.wei : 0n;
        spent.set(account.address, { day, wei: base + r.gasUsed * r.effectiveGasPrice });
      }
      return r;
    });
    queues.set(account.address, run);
    return run as Promise<TransactionReceipt>;
  }

  return { chain, pub, broadcast, live, accounts, send, wallet };
}

/**
 * eth_getLogs over a block range in 100,000-block spans, halving the span when the node refuses (too many
 * results or a timeout), with a short pause between requests.
 */
export async function getLogsChunked(
  pub: PublicClient,
  params: { address: Address | Address[]; events?: readonly AbiEvent[]; fromBlock: bigint; toBlock: bigint },
  opts: { span?: bigint; pauseMs?: number } = {},
): Promise<Log[]> {
  let span = opts.span ?? 100_000n;
  const out: Log[] = [];
  let from = params.fromBlock;
  while (from <= params.toBlock) {
    const to = from + span - 1n > params.toBlock ? params.toBlock : from + span - 1n;
    try {
      const logs = await pub.getLogs({
        address: params.address,
        events: params.events as AbiEvent[] | undefined,
        fromBlock: from,
        toBlock: to,
      } as Parameters<PublicClient["getLogs"]>[0]);
      out.push(...(logs as Log[]));
      from = to + 1n;
      if (opts.pauseMs) await sleep(opts.pauseMs);
    } catch (e) {
      if (span === 1n) throw e;
      span = span / 2n > 0n ? span / 2n : 1n;
    }
  }
  return out;
}

const ERROR_ABIS: Abi[] = [purserModuleAbi, purserRecurringAbi, purserEscrowAbi, purserPasskeyAbi, purserFactoryAbi];

/** Plain words for every revert the Purser contracts can give. */
export const REVERT_WORDS: Record<string, string> = {
  NotSafe: "Only the Safe itself (an owner-signed Safe transaction) can change this.",
  NotOwner: "Only an owner of the Safe can do this.",
  NotInitialized: "This account is not set up with Purser.",
  AlreadyInitialized: "This account is already set up.",
  ModuleNotEnabled: "The Purser module is not enabled on this Safe.",
  IsFrozen: "The account is frozen. The owner must unfreeze it first.",
  Expired: "The signed request expired.",
  NonceUsed: "This request was already used.",
  BadSignature: "A required signature is missing or wrong.",
  IntentWasRejected: "The owner rejected this payment.",
  TokenNotEnabled: "The agent may not spend this token.",
  OverMaxSingle: "The amount is above the largest single payment the owner allows.",
  OverDaily: "The payment would go over today's budget.",
  OverWeekly: "The payment would go over this week's budget.",
  OverCounterparty: "The payment would go over today's limit for this payee.",
  PayeeNotAllowed: "The payee is not on the owner's allowlist.",
  ServiceNotAllowed: "The service is not on the owner's allowlist.",
  TargetNotAllowed: "The contract is not on the owner's allowlist.",
  SelectorBlocked: "The agent may not give approvals or move tokens directly through a contract call.",
  OutsideTimeWindow: "Payments are not allowed at this time of day or week.",
  RateLimited: "Too many payments this minute.",
  ExecFailed: "The transfer or call failed inside the Safe (such as not enough balance).",
  BadAmount: "The amount is not valid.",
  BadConfig: "The settings are not valid.",
  NotExtension: "This contract is not enabled for the account.",
  VaultNotAllowed: "The vault is not on the owner's treasury list.",
  KeepLiquid: "The deposit would leave less than the amount the owner keeps liquid.",
  Slippage: "The vault returned less than expected.",
  NotGuardian: "Only the guardian can start a recovery.",
  RecoveryNotReady: "The recovery is not ready yet.",
  Reentrancy: "A nested call was refused.",
  NotReceivable: "The owner has not enabled receiving this token through Purser.",
  BadParams: "The parameters are not valid.",
  NotAllowed: "This party is not allowed to do this.",
  NotDue: "Nothing is due yet.",
  FirewallRequired: "This account has a firewall, so every recurring payment needs a fresh firewall signature.",
  WrongStatus: "The job is not in the right state for this.",
  TooEarly: "It is too early for this.",
  TransferFailed: "The transfer failed.",
  NoPasskey: "No passkey is registered for this account.",
  BadAssertion: "The passkey signature is not valid.",
  OnlyDelegateCall: "This function only runs inside a Safe.",
};

export function revertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return r.data.errorName;
    const data = (e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data;
    if (data) return decodeRevertData(data);
  }
  const m = /reverted with custom error '(\w+)\(/.exec(String((e as Error)?.message ?? ""));
  return m ? m[1] : null;
}

export function decodeRevertData(data: Hex): string | null {
  for (const abi of ERROR_ABIS) {
    try {
      return decodeErrorResult({ abi, data }).errorName;
    } catch {
      /* next */
    }
  }
  if (data.startsWith("0x08c379a0")) return "Error";
  return null;
}

export function explainRevert(e: unknown): string {
  const name = revertName(e);
  if (name && REVERT_WORDS[name]) return REVERT_WORDS[name];
  return name ? `The chain refused it (${name}).` : `The chain refused it: ${String((e as Error)?.message ?? e).split("\n")[0]}`;
}
