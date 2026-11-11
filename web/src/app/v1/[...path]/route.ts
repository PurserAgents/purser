/**
 * Same-origin proxy to the engine: the browser calls /v1/... on the site and this forwards it to
 * PURSER_ENGINE_URL, including the live event stream. Auth headers pass through unchanged; the engine decides.
 */
import { engineUrl } from "@/lib/data";

export const dynamic = "force-dynamic";

const PASS_REQUEST = ["authorization", "content-type", "accept", "last-event-id", "payment-signature", "x-payment"];
const PASS_RESPONSE = ["content-type", "content-disposition", "payment-required", "payment-response", "x-payment-response"];

async function proxy(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const base = engineUrl();
  if (!base) return Response.json({ error: { code: "no_engine", message: "The engine is not connected to this site." } }, { status: 503 });
  const { path } = await ctx.params;
  const search = new URL(req.url).search;
  const target = `${base}/v1/${path.map(encodeURIComponent).join("/")}${search}`;
  const headers = new Headers();
  for (const name of PASS_REQUEST) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      signal: req.signal,
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return Response.json({ error: { code: "engine_unreachable", message: "The engine did not answer." } }, { status: 503 });
  }
  const out = new Headers();
  for (const name of PASS_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  const stream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  out.set("cache-control", stream ? "no-cache, no-transform" : "no-store");
  if (stream) out.set("x-accel-buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
