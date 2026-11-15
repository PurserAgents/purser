"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EngineError, errorMessage } from "@/lib/client";
import { pocketApi, readCache, writeCache, type PocketAuth } from "@/lib/pocket";
import type { EngineEventType } from "@/lib/types";
import { useEngineEvents } from "../Live";

export interface PocketView<T> {
  data: T | null;
  error: string | null;
  /** the engine could not be reached; `data` is the last copy this phone kept */
  offline: boolean;
  /** when `data` was loaded (ms) */
  at: number | null;
  reload(): void;
}

const unreachable = (e: unknown) => e instanceof EngineError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);

/**
 * Loads a device-token path and reloads it on engine events. With `cacheName` the last answer is kept on the phone
 * and shown when the engine cannot be reached; it then tries again every few seconds.
 */
export function usePocketData<T>(auth: PocketAuth | null, path: string | null, refreshOn: EngineEventType[], onUnauthorized?: () => void, cacheName?: string): PocketView<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; offline: boolean; at: number | null; path: string | null }>(() => {
    const kept = cacheName ? readCache<T>(cacheName) : null;
    return { data: kept?.data ?? null, error: null, offline: false, at: kept?.at ?? null, path };
  });
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => {
    unauthorized.current = onUnauthorized;
  }, [onUnauthorized]);
  const load = useCallback(() => {
    if (!auth || !path) return;
    const id = ++seq.current;
    pocketApi<T>(auth, path)
      .then((d) => {
        if (id !== seq.current) return;
        if (cacheName) writeCache(cacheName, d);
        setState({ data: d, error: null, offline: false, at: Date.now(), path });
      })
      .catch((e) => {
        if (e instanceof EngineError && e.status === 401) unauthorized.current?.();
        if (id !== seq.current) return;
        setState((s) => ({ data: s.path === path ? s.data : null, error: errorMessage(e), offline: unreachable(e), at: s.path === path ? s.at : null, path }));
      });
  }, [auth, path, cacheName]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!state.offline) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [state.offline, load]);
  useEngineEvents(
    refreshOn,
    () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 400);
    },
    !!auth && refreshOn.length > 0,
  );
  const stale = state.path !== path;
  return { data: stale ? null : state.data, error: stale ? null : state.error, offline: !stale && state.offline, at: stale ? null : state.at, reload: load };
}
