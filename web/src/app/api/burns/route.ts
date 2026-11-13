// Every $PURSER burn, read from the chain: the burn pot's Burned events plus the dev wallet's tokens sent to the dead
// address at launch. Scanned in 20,000-block windows from the burn pot's deploy block and kept in memory, so after the
// first request only the new blocks are read.
export const dynamic = "force-dynamic";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const POT = "0xd3049f1ef0569d3c9bf9c44f114a76bf7cfd404f";
const FROM = 113460541;
const BURNED = "0xe0b021f9909dbe92ea94cab49adba6815f9979e26ab8d0e6d5b255d63b848d3d";
const WINDOW = 20_000;

export type Burn = { n: number; at: number; tokens: number; eth: number; tx: string; kind: "pot" | "dev" };

const DEV: Burn = {
  n: 0,
  at: 1794584717,
  tokens: 10_000_000,
  eth: 0,
  tx: "0x3964bcd08b7c1a9bc664731646c297e7476f0496233d0978ebfe95b24f4d6680",
  kind: "dev",
};

let scanned = FROM - 1;
const burns: Burn[] = [];
let busy: Promise<void> | null = null;
let lastScan = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result as T;
}

const big = (hex: string, i: number) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const units = (v: bigint) => Number(v / 10n ** 12n) / 1e6;

type Log = { blockNumber: string; transactionHash: string; topics: string[]; data: string };

async function scan(): Promise<void> {
  const head = parseInt(await rpc<string>("eth_blockNumber", []), 16);
  const times = new Map<number, number>();
  while (scanned < head) {
    const from = scanned + 1;
    const to = Math.min(head, from + WINDOW - 1);
    const logs = await rpc<Log[]>("eth_getLogs", [
      { address: POT, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [BURNED] },
    ]);
    for (const l of logs) {
      const blk = parseInt(l.blockNumber, 16);
      let at = times.get(blk);
      if (at === undefined) {
        const b = await rpc<{ timestamp: string }>("eth_getBlockByNumber", ["0x" + blk.toString(16), false]);
        at = parseInt(b.timestamp, 16);
        times.set(blk, at);
      }
      burns.push({
        n: Number(BigInt(l.topics[1])),
        at,
        eth: units(big(l.data, 0)),
        tokens: units(big(l.data, 1)),
        tx: l.transactionHash,
        kind: "pot",
      });
    }
    scanned = to;
  }
}

export async function GET() {
  try {
    if (Date.now() - lastScan > 20_000) {
      if (!busy) busy = scan().finally(() => (busy = null));
      await busy;
      lastScan = Date.now();
    }
    const list = [...burns].sort((a, b) => b.n - a.n);
    return Response.json({ burns: [...list, DEV] }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ burns: [...burns].sort((a, b) => b.n - a.n).concat(DEV), partial: true }, { status: 200 });
  }
}
