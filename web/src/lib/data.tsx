"use client";

import { type MarketState, type PmecProgram, fetchMarkets, getProgram } from "@pmec/sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type MarketMeta, type RelayerConfig, getConfig, getMarkets } from "./api";

/** A market as the UI sees it: the relayer's names and Gemini prices plus live on-chain state. */
export interface MarketView {
  meta: MarketMeta;
  chain: MarketState | null;
}

interface Data {
  config: RelayerConfig | null;
  usdcMint: PublicKey | null;
  program: PmecProgram;
  markets: MarketView[];
  /** False until the first load finished (successfully or not). */
  ready: boolean;
  /** Set when the relayer cannot be reached. */
  relayerError: string | null;
  refresh: () => Promise<void>;
  /** Connected wallet's balances; null while unknown or disconnected. */
  usdc: bigint | null;
  sol: number | null;
  /** Token balance per mint address (base units). */
  tokens: Map<string, bigint>;
  refreshWallet: () => Promise<void>;
}

const DataContext = createContext<Data | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const program = useMemo(() => getProgram(connection), [connection]);

  const [config, setConfig] = useState<RelayerConfig | null>(null);
  const [metas, setMetas] = useState<MarketMeta[]>([]);
  const [chain, setChain] = useState<Map<string, MarketState>>(new Map());
  const [ready, setReady] = useState(false);
  const [relayerError, setRelayerError] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [sol, setSol] = useState<number | null>(null);
  const [tokens, setTokens] = useState<Map<string, bigint>>(new Map());
  const metasRef = useRef<MarketMeta[]>([]);

  const usdcMint = useMemo(() => (config?.usdcMint ? new PublicKey(config.usdcMint) : null), [config?.usdcMint]);

  const loadChain = useCallback(
    async (list: MarketMeta[]) => {
      try {
        const states = await fetchMarkets(
          program,
          list.map((m) => new PublicKey(m.address)),
        );
        setChain(new Map(states.map((s) => [s.idHex, s])));
      } catch {
        // Keep the last known state; the next poll retries.
      }
    },
    [program],
  );

  const refresh = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([getConfig(), getMarkets()]);
      setConfig(cfg);
      setMetas(list);
      metasRef.current = list;
      setRelayerError(null);
      await loadChain(list);
    } catch (e) {
      setRelayerError((e as Error).message);
    } finally {
      setReady(true);
    }
  }, [loadChain]);

  useEffect(() => {
    void refresh();
    // Relayer data (names, Gemini prices) every 20 s; chain state every 8 s.
    const slow = setInterval(() => void refresh(), 20_000);
    const fast = setInterval(() => void loadChain(metasRef.current), 8_000);
    return () => {
      clearInterval(slow);
      clearInterval(fast);
    };
  }, [refresh, loadChain]);

  const refreshWallet = useCallback(async () => {
    if (!publicKey) {
      setUsdc(null);
      setSol(null);
      setTokens(new Map());
      return;
    }
    try {
      const [lamports, accounts] = await Promise.all([
        connection.getBalance(publicKey, "confirmed"),
        connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
      ]);
      const map = new Map<string, bigint>();
      for (const a of accounts.value) {
        const info = a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
        map.set(info.mint, (map.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
      setSol(lamports / LAMPORTS_PER_SOL);
      setTokens(map);
      setUsdc(usdcMint ? (map.get(usdcMint.toBase58()) ?? 0n) : null);
    } catch {
      // Leave balances as they were; the next refresh retries.
    }
  }, [connection, publicKey, usdcMint]);

  useEffect(() => {
    void refreshWallet();
    const t = setInterval(() => void refreshWallet(), 15_000);
    return () => clearInterval(t);
  }, [refreshWallet]);

  const markets = useMemo(
    () => metas.map((meta) => ({ meta, chain: chain.get(meta.idHex) ?? null })),
    [metas, chain],
  );

  const value: Data = { config, usdcMint, program, markets, ready, relayerError, refresh, usdc, sol, tokens, refreshWallet };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): Data {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used inside DataProvider");
  return ctx;
}
