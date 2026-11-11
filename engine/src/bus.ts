import type { Address } from "viem";
import type { EngineEvent, EngineEventType } from "../../packages/sdk/src/schema.ts";
import { now } from "./util.ts";

export type Bus = ReturnType<typeof makeBus>;
type Listener = (e: EngineEvent) => void;

/** In-process event bus. Feeds the SSE stream (with replay by Last-Event-ID) and the webhook dispatcher. */
export function makeBus(keep = 500) {
  let seq = 0;
  const ring: EngineEvent[] = [];
  const listeners = new Set<Listener>();

  function emit<T>(type: EngineEventType, safe: string | null, data: T): EngineEvent<T> {
    const e: EngineEvent<T> = { id: ++seq, type, safe: (safe?.toLowerCase() ?? null) as Address | null, ts: now(), data };
    ring.push(e as EngineEvent);
    if (ring.length > keep) ring.shift();
    for (const l of listeners) {
      try {
        l(e as EngineEvent);
      } catch {
        /* a listener never breaks the emitter */
      }
    }
    return e;
  }

  function subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  }

  const since = (id: number) => ring.filter((e) => e.id > id);

  return { emit, subscribe, since };
}
