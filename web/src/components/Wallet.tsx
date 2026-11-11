"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, EngineError } from "@/lib/client";
import { shortAddress } from "@/lib/format";
import { metamaskSigner, testSigner, type Eip1193Provider, type OwnerSigner, type SignerKind } from "@/lib/owner";
import { site } from "@/lib/site";
import type { EngineConfig } from "@/lib/types";
import { IconWallet } from "./Icons";

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

type WalletStatus = "idle" | "connecting" | "connected" | "no-wallet" | "choose";
/** "unopened": the engine answers but runs read-only, without Purser contracts on its chain yet. */
type EngineState = "loading" | "ready" | "offline" | "unopened";

interface WalletState {
  status: WalletStatus;
  address: string | null;
  /** true when the wallet is on Robinhood Chain (always true for the test wallet) */
  onChain: boolean;
  error: string | null;
  /** which wallet is connected */
  kind: SignerKind | null;
  /** signs and sends what the engine prepares; null until a wallet is connected */
  signer: OwnerSigner | null;
  /** the engine's public settings, loaded once */
  engine: EngineConfig | null;
  engineState: EngineState;
  connect(): Promise<void>;
  connectMetaMask(): Promise<void>;
  connectTest(): Promise<void>;
  disconnect(): void;
  switchChain(): Promise<void>;
  closeChooser(): void;
}

const WalletContext = createContext<WalletState | null>(null);
const OPT_OUT_KEY = "purser-wallet-off";
const MODE_KEY = "purser-wallet-mode";

function getProvider(): Eip1193Provider | null {
  if (typeof window === "undefined" || !window.ethereum) return null;
  const injected = window.ethereum;
  // Several wallets installed: prefer MetaMask.
  return injected.providers?.find((p) => p.isMetaMask) ?? injected;
}

function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Opens this page inside the MetaMask app's browser. */
export function metamaskDeepLink(): string {
  return `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}${window.location.search}`;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function errorText(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 4001) return "The request was rejected in the wallet.";
  if (code === -32002) return "A request is already open in MetaMask.";
  return "The wallet did not answer. Try again.";
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<SignerKind | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineConfig | null>(null);
  const [engineState, setEngineState] = useState<EngineState>("loading");
  const kindRef = useRef<SignerKind | null>(null);
  useEffect(() => {
    kindRef.current = kind;
  }, [kind]);

  const configRef = useRef<Promise<EngineConfig | null> | null>(null);
  useEffect(() => {
    let alive = true;
    let unopened = false;
    const loading = api<EngineConfig>("/v1/config").catch((e: unknown) => {
      unopened = e instanceof EngineError && e.code === "no_deployment";
      return null;
    });
    configRef.current = loading;
    loading.then((config) => {
      if (!alive) return;
      setEngine(config);
      setEngineState(config ? "ready" : unopened ? "unopened" : "offline");
    });
    return () => {
      alive = false;
    };
  }, []);

  const connectTest = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    try {
      const s = await api<{ token: string; address: string; expires: number }>("/v1/testmode/session", { body: {} });
      write(MODE_KEY, "test");
      write(OPT_OUT_KEY, null);
      try {
        localStorage.setItem("purser-owner-session:" + s.address.toLowerCase(), JSON.stringify({ token: s.token, expires: s.expires }));
      } catch {
        /* ignore */
      }
      setKind("test");
      setAddress(s.address);
      setStatus("connected");
    } catch {
      setStatus("idle");
      setError("The engine is not in test mode.");
    }
  }, []);

  // Reconnect on load: the test wallet when it was chosen last time, otherwise MetaMask if it already allowed this site.
  useEffect(() => {
    if (engineState === "loading") return;
    if (read(OPT_OUT_KEY) === "1") return;
    if (read(MODE_KEY) === "test" && engine?.testMode) {
      const t = setTimeout(() => void connectTest(), 0);
      return () => clearTimeout(t);
    }
    const provider = getProvider();
    if (!provider) return;
    provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        const first = (accounts as string[])[0] ?? null;
        if (first) {
          setKind("metamask");
          setAddress(first);
          setStatus("connected");
        }
      })
      .catch(() => {});
  }, [engineState, engine?.testMode, connectTest]);

  // MetaMask events
  useEffect(() => {
    const provider = getProvider();
    if (!provider) return;
    let alive = true;
    const onAccounts = (accounts: string[]) => {
      if (!alive || kindRef.current !== "metamask") return;
      const first = accounts[0] ?? null;
      setAddress(first);
      setStatus(first ? "connected" : "idle");
      if (!first) setKind(null);
    };
    const onChain = (id: string) => {
      if (alive) setChainId(id);
    };
    provider
      .request({ method: "eth_chainId" })
      .then((id) => onChain(id as string))
      .catch(() => {});
    provider.on?.("accountsChanged", onAccounts as (...args: never[]) => void);
    provider.on?.("chainChanged", onChain as (...args: never[]) => void);
    return () => {
      alive = false;
      provider.removeListener?.("accountsChanged", onAccounts as (...args: never[]) => void);
      provider.removeListener?.("chainChanged", onChain as (...args: never[]) => void);
    };
  }, []);

  const switchChain = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: site.chain.hexId }] });
    } catch (err) {
      if ((err as { code?: number })?.code === 4902) {
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: site.chain.hexId, chainName: site.chain.name, rpcUrls: [site.chain.rpc], nativeCurrency: site.chain.currency }],
          });
        } catch (addError) {
          setError(errorText(addError));
        }
      } else {
        setError(errorText(err));
      }
    }
  }, []);

  const connectMetaMask = useCallback(async () => {
    setError(null);
    const provider = getProvider();
    if (!provider) {
      if (isMobile()) {
        window.location.href = metamaskDeepLink();
        return;
      }
      setStatus("no-wallet");
      return;
    }
    setStatus("connecting");
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const first = accounts[0] ?? null;
      write(OPT_OUT_KEY, null);
      write(MODE_KEY, "metamask");
      setKind(first ? "metamask" : null);
      setAddress(first);
      setStatus(first ? "connected" : "idle");
      const id = (await provider.request({ method: "eth_chainId" })) as string;
      setChainId(id);
      if (first && id.toLowerCase() !== site.chain.hexId) await switchChain();
    } catch (err) {
      setStatus("idle");
      setError(errorText(err));
    }
  }, [switchChain]);

  const connect = useCallback(async () => {
    // The choice depends on the engine: wait for its settings if they are still loading.
    const config = engine ?? (await configRef.current?.catch(() => null)) ?? null;
    if (config?.testMode) {
      setError(null);
      setStatus("choose");
      return;
    }
    await connectMetaMask();
  }, [engine, connectMetaMask]);

  const disconnect = useCallback(() => {
    write(OPT_OUT_KEY, "1");
    write(MODE_KEY, null);
    setAddress(null);
    setKind(null);
    setStatus("idle");
    setError(null);
  }, []);

  const closeChooser = useCallback(() => {
    setStatus((s) => (s === "choose" || s === "no-wallet" ? "idle" : s));
    setError(null);
  }, []);

  const signer = useMemo<OwnerSigner | null>(() => {
    if (status !== "connected" || !address) return null;
    if (kind === "test") return testSigner(address);
    const provider = getProvider();
    return provider ? metamaskSigner(provider, address) : null;
  }, [status, address, kind]);

  const value = useMemo<WalletState>(
    () => ({
      status,
      address,
      onChain: kind === "test" || chainId?.toLowerCase() === site.chain.hexId,
      error,
      kind,
      signer,
      engine,
      engineState,
      connect,
      connectMetaMask,
      connectTest,
      disconnect,
      switchChain,
      closeChooser,
    }),
    [status, address, kind, chainId, error, signer, engine, engineState, connect, connectMetaMask, connectTest, disconnect, switchChain, closeChooser],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}

export function WalletButton({ size = "sm" }: { size?: "sm" | "md" | "lg" }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sizeClass = size === "sm" ? " btn--sm" : size === "lg" ? " btn--lg" : "";
  const popOpen = open || wallet.status === "no-wallet" || wallet.status === "choose" || (wallet.error !== null && wallet.status !== "connected");

  useEffect(() => {
    if (!popOpen) return;
    const close = () => {
      setOpen(false);
      wallet.closeChooser();
    };
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [popOpen, wallet]);

  async function copy() {
    if (!wallet.address) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  if (wallet.status === "connected" && wallet.address) {
    return (
      <div className="wallet" ref={ref}>
        <button
          type="button"
          className={"btn btn--secondary" + sizeClass}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
          data-wallet={wallet.kind ?? undefined}
        >
          <span className="dot" style={{ color: wallet.onChain ? "var(--ok)" : "var(--wait)" }} />
          <span className="wallet__addr">{shortAddress(wallet.address)}</span>
        </button>
        {open && (
          <div className="wallet__pop" role="dialog" aria-label="Wallet">
            <div className="stack" style={{ gap: 4 }}>
              <span className="dim micro">{wallet.kind === "test" ? "Test wallet of the local engine" : "Connected with MetaMask"}</span>
              <span className="wallet__addr">{shortAddress(wallet.address)}</span>
            </div>
            {!wallet.onChain && (
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void wallet.switchChain()}>
                Switch to {site.chain.name}
              </button>
            )}
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy address"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                wallet.disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet" ref={ref}>
      <button
        type="button"
        className={"btn btn--primary" + sizeClass}
        onClick={() => void wallet.connect()}
        disabled={wallet.status === "connecting"}
      >
        <IconWallet size={16} />
        {wallet.status === "connecting" ? "Check MetaMask" : "Connect wallet"}
      </button>
      {wallet.status === "choose" && (
        <div className="wallet__pop" role="dialog" aria-label="Choose a wallet">
          <strong style={{ fontWeight: 500 }}>Connect a wallet</strong>
          <span className="muted small">This engine runs in test mode on a local node. Its test wallet owns the agents there.</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void wallet.connectTest()}>
            Use the test wallet
          </button>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void wallet.connectMetaMask()}>
            MetaMask
          </button>
        </div>
      )}
      {wallet.status === "no-wallet" && (
        <div className="wallet__pop" role="dialog" aria-label="MetaMask not found">
          <strong style={{ fontWeight: 500 }}>MetaMask not found</strong>
          <span className="muted">Purser connects through MetaMask. Install it, then reload this page.</span>
          <a className="btn btn--secondary btn--sm" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            Get MetaMask
          </a>
        </div>
      )}
      {wallet.error && wallet.status !== "no-wallet" && wallet.status !== "choose" && (
        <div className="wallet__pop" role="alert">
          <span className="muted">{wallet.error}</span>
        </div>
      )}
    </div>
  );
}
