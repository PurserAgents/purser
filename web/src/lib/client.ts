/**
 * Browser-side engine calls through the same-origin proxy (/v1/...). Errors carry the engine's plain message.
 * A payment refused by the rules or the firewall is an answer (HTTP 422 with a verdict), not an error.
 */
export class EngineError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new EngineError(0, "offline", "The engine did not answer. Check the connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok && !(res.status === 422 && data && typeof data === "object" && "verdict" in data)) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new EngineError(res.status, err?.code ?? "http_error", err?.message ?? `The engine answered with HTTP ${res.status}.`);
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof EngineError) return error.message;
  const code = (error as { code?: number })?.code;
  if (code === 4001) return "The request was rejected in the wallet.";
  if (code === -32002) return "A request is already open in MetaMask.";
  const message = (error as { message?: string })?.message;
  return message ? message.split("\n")[0].slice(0, 200) : "Something went wrong. Try again.";
}
