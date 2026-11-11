"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, errorMessage } from "@/lib/client";
import type { EngineEvent, EngineEventType } from "@/lib/types";

type Listener = (event: EngineEvent) => void;

interface LiveApi {
  subscribe(types: EngineEventType[] | null, listener: Listener): () => void;
}

const LiveContext = createContext<LiveApi | null>(null);

/**
 * One Server-Sent Events connection to the engine (through the /v1 proxy), shared by every view on the page.
 * It opens on the first subscriber and closes when the last one leaves.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<{ types: EngineEventType[] | null; listener: Listener }>());
  const source = useRef<EventSource | null>(null);

  const open = useCallback(() => {
    if (source.current || typeof EventSource === "undefined") return;
    const es = new EventSource("/v1/events");
    const dispatch = (message: MessageEvent) => {
      let event: EngineEvent;
      try {
        event = JSON.parse(message.data) as EngineEvent;
      } catch {
        return;
      }
      for (const entry of listeners.current) {
        if (!entry.types || entry.types.includes(event.type)) entry.listener(event);
      }
    };
    const types: EngineEventType[] = ["receipt", "intent", "verdict", "approval", "watchdog", "account", "stream", "subscription", "invoice", "audit", "alert", "demo"];
    for (const type of types) es.addEventListener(type, dispatch as EventListener);
    source.current = es;
  }, []);

  const subscribe = useCallback(
    (types: EngineEventType[] | null, listener: Listener) => {
      const entry = { types, listener };
      listeners.current.add(entry);
      open();
      return () => {
        listeners.current.delete(entry);
        if (listeners.current.size === 0 && source.current) {
          source.current.close();
          source.current = null;
        }
      };
    },
    [open],
  );

  // Close the stream when the page is hidden or kept in the back-forward cache, so a stream never outlives its page
  // and holds one of the browser's few connections to this host; open it again when the page comes back.
  useEffect(() => {
    const hide = () => {
      source.current?.close();
      source.current = null;
    };
    const show = () => {
      if (listeners.current.size > 0) open();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      hide();
    };
  }, [open]);

  return <LiveContext.Provider value={{ subscribe }}>{children}</LiveContext.Provider>;
}

/** Calls `handler` for every engine event of these types (all types when null). */
export function useEngineEvents(types: EngineEventType[] | null, handler: Listener, enabled = true) {
  const live = useContext(LiveContext);
  const saved = useRef(handler);
  useEffect(() => {
    saved.current = handler;
  }, [handler]);
  const key = types ? types.join(",") : "*";
  useEffect(() => {
    if (!live || !enabled) return;
    return live.subscribe(key === "*" ? null : (key.split(",") as EngineEventType[]), (e) => saved.current(e));
  }, [live, key, enabled]);
}

export interface EngineView<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/**
 * Loads `path` from the engine, and loads it again when an event of `refreshOn` arrives (debounced), or every
 * `every` milliseconds. `path` null means "nothing to load yet".
 */
export function useEngine<T>(path: string | null, opts: { refreshOn?: EngineEventType[]; every?: number } = {}): EngineView<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; path: string | null }>({
    data: null,
    error: null,
    loading: path !== null,
    path,
  });
  const seq = useRef(0);
  const applied = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!path) return;
    const id = ++seq.current;
    // Keep the newest answer that has arrived for this path; frequent events must never starve the view.
    const fresh = () => {
      if (id < applied.current) return false;
      applied.current = id;
      return true;
    };
    api<T>(path)
      .then((data) => {
        if (fresh()) setState({ data, error: null, loading: false, path });
      })
      .catch((error) => {
        if (fresh()) setState((s) => ({ data: s.path === path ? s.data : null, error: errorMessage(error), loading: false, path }));
      });
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!opts.every || !path) return;
    const t = setInterval(load, opts.every);
    return () => clearInterval(t);
  }, [opts.every, path, load]);

  useEngineEvents(
    opts.refreshOn ?? [],
    () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 500);
    },
    Boolean(path && opts.refreshOn?.length),
  );

  const stale = state.path !== path;
  return { data: stale ? null : state.data, error: stale ? null : state.error, loading: stale ? path !== null : state.loading, reload: load };
}

/** The current time in unix seconds, updated every `everyMs`. Keeps render pure. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
