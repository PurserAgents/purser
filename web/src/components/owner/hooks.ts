"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { EngineEventType } from "@/lib/types";
import { useEngineEvents } from "../Live";

/**
 * Loads one path per key (for example every agent's account) and keeps them fresh on engine events.
 * Returns a map from key to answer; keys whose call failed are left out.
 */
export function useMany<T>(keys: string[], path: (key: string) => string, refreshOn: EngineEventType[] = []) {
  const [data, setData] = useState<Record<string, T>>({});
  const [loading, setLoading] = useState(true);
  const joined = keys.join(",");
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  const seq = useRef(0);
  const applied = useRef(0);
  const load = useCallback(() => {
    const list = joined ? joined.split(",") : [];
    const id = ++seq.current;
    Promise.all(list.map((k) => api<T>(pathRef.current(k)).then((v) => [k, v] as const).catch(() => null))).then((pairs) => {
      // Keep the newest answer that has arrived; a stream of events must never starve the view.
      if (id < applied.current) return;
      applied.current = id;
      const next: Record<string, T> = {};
      for (const pair of pairs) if (pair) next[pair[0]] = pair[1];
      setData(next);
      setLoading(false);
    });
  }, [joined]);
  useEffect(() => {
    applied.current = 0;
    load();
  }, [load]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEngineEvents(
    refreshOn,
    () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(load, 600);
    },
    refreshOn.length > 0,
  );
  return { data, loading, reload: load };
}
