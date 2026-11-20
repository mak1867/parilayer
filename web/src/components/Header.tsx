"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { requestFaucet } from "@/lib/api";
import { BURNER_NAME } from "@/lib/burner";
import { useData } from "@/lib/data";
import { fmtUsdc, shortKey } from "@/lib/format";

const NAV = [
  { href: "/", label: "Markets" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/pairs", label: "Pair builder" },
  { href: "/how-it-works", label: "How it works" },
];

function WalletMenu() {
  // Picking a wallet connects it: the provider auto-connects whatever is selected.
  const { wallets, select, wallet, publicKey, disconnect, connecting } = useWallet();
  const { usdc, sol, config, refreshWallet } = useData();
  const [open, setOpen] = useState(false);
  const [faucet, setFaucet] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const getUsdc = async () => {
    if (!publicKey) return;
    setFaucet({ busy: true, note: null });
    try {
      const r = await requestFaucet(publicKey.toBase58());
      setFaucet({ busy: false, note: `Sent ${r.usdc.toLocaleString()} test USDC${r.sol ? ` and ${r.sol} SOL for fees` : ""}.` });
      await refreshWallet();
    } catch (e) {
      setFaucet({ busy: false, note: (e as Error).message });
    }
  };

  if (!publicKey) {
    const usable = wallets.filter((w) => w.readyState === "Installed" || w.readyState === "Loadable");
    return (
      <div className="wallet" ref={ref}>
        <button className="btn btn-amber" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
        {open && (
          <div className="menu" role="menu">
            {usable.map((w) => (
              <button
                key={w.adapter.name}
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  select(w.adapter.name);
                  setOpen(false);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.adapter.icon} alt="" width={20} height={20} />
                <span>
                  {w.adapter.name}
                  {w.adapter.name === BURNER_NAME && <small>Made in this browser, devnet only. No install needed.</small>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet" ref={ref}>
      <button className="btn btn-ghost-light" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="num">{usdc === null ? "…" : fmtUsdc(usdc)}</span> USDC
        <span className="wallet-key">{shortKey(publicKey.toBase58())}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-info">
            <div>{wallet?.adapter.name}</div>
            <code>{publicKey.toBase58()}</code>
            <div>
              {usdc === null ? "…" : fmtUsdc(usdc)} USDC, {sol === null ? "…" : sol.toFixed(3)} SOL
            </div>
          </div>
          {config?.faucet && (
            <button role="menuitem" className="menu-item" onClick={getUsdc} disabled={faucet.busy}>
              <span>
                {faucet.busy ? "Sending…" : `Get ${config.faucet.usdc.toLocaleString()} test USDC`}
                <small>Devnet play money, once an hour per wallet.</small>
              </span>
            </button>
          )}
          {faucet.note && <div className="menu-note">{faucet.note}</div>}
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(publicKey.toBase58());
              setOpen(false);
            }}
          >
            <span>Copy address</span>
          </button>
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              void disconnect();
              setOpen(false);
            }}
          >
            <span>Disconnect</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const path = usePathname();
  const { relayerError, config } = useData();
  return (
    <header className="site-header">
      <div className="bar">
        <Link href="/" className="brand" aria-label="PariLayer, home">
          PariLayer
        </Link>
        <nav aria-label="Main">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" || path.startsWith("/market") : path.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
                {n.label}
              </Link>
            );
          })}
        </nav>
        <WalletMenu />
      </div>
      <div className="notice-bar">
        Solana devnet. Play money only.
        {config?.mock && " Gemini prices are recorded samples (offline mode)."}
        {relayerError && <strong> Cannot reach the relayer, so market names and Gemini prices are unavailable.</strong>}
      </div>
    </header>
  );
}
