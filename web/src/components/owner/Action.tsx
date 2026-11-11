"use client";

import { useCallback, useState } from "react";
import { errorMessage } from "@/lib/client";
import { IconCheck, IconX } from "../Icons";

export interface ActionState {
  kind: "idle" | "busy" | "ok" | "error";
  message: string | null;
}

/**
 * Runs one owner action at a time and keeps a plain status line: what is happening (sign in MetaMask, waiting
 * for the chain), then what happened or why it failed.
 */
export function useAction() {
  const [state, setState] = useState<ActionState>({ kind: "idle", message: null });
  const run = useCallback(async (work: (step: (message: string) => void) => Promise<string | void>, busyMessage = "Confirm in your wallet...") => {
    setState({ kind: "busy", message: busyMessage });
    try {
      const done = await work((message) => setState({ kind: "busy", message }));
      setState({ kind: "ok", message: done || "Done." });
      return true;
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
      return false;
    }
  }, []);
  const reset = useCallback(() => setState({ kind: "idle", message: null }), []);
  return { state, busy: state.kind === "busy", run, reset };
}

export function ActionStatus({ state }: { state: ActionState }) {
  if (state.kind === "idle" || !state.message) return null;
  return (
    <div className={"action-status" + (state.kind === "ok" ? " action-status--ok" : state.kind === "error" ? " action-status--error" : "")} role={state.kind === "error" ? "alert" : "status"}>
      {state.kind === "busy" ? <span className="spinner" aria-hidden="true" /> : state.kind === "ok" ? <IconCheck size={15} /> : <IconX size={15} />}
      <span>{state.message}</span>
    </div>
  );
}
