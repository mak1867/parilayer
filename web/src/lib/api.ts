import type { MarketKind } from "@pmec/sdk";
import { RELAYER_URL } from "./env";

export interface PairReference {
  legs: { label: string; instrumentSymbol: string; yes: number | null }[];
  product: number[] | null;
  combo: { instrumentSymbol: string | null; eventTicker: string; outcomeIndex: number; price: number | null } | null;
}

export interface Reference {
  /** Gemini's price per outcome, 0..1. */
  prices: (number | null)[];
  /** The same, normalized to sum to 1. */
  normalized: (number | null)[];
  asOf: number | null;
  pair?: PairReference;
}

/** What the relayer knows about a market: names, Gemini mapping and reference prices. */
export interface MarketMeta {
  idHex: string;
  address: string;
  kind: MarketKind;
  refs: string[];
  title: string;
  category: string;
  outcomes: string[];
  seedProbsPpm: number[];
  seedUsdc: string;
  createdAt: number;
  expiryDate: string | null;
  creator?: string;
  reference: Reference | null;
}

export interface RelayerConfig {
  programId: string;
  rpcUrl: string;
  usdcMint: string | null;
  oracle: string | null;
  poolFeeBps: number | null;
  secondaryFeeBps: number | null;
  seedUsdc: number;
  faucet: { usdc: number } | null;
  mock: boolean;
}

export interface PoolTrade {
  signature: string;
  blockTime: number | null;
  market: string;
  kind: "buy" | "redeem";
  wallet: string;
  outcome: number;
  usdc: string;
  fee: string;
  shares: string;
  priceAfter: string | null;
  probAfter: number | null;
}

export interface PositionHistory {
  market: string;
  outcome: number;
  boughtShares: string;
  boughtUsdc: string;
  redeemedShares: string;
  redeemedUsdc: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(RELAYER_URL + path, { cache: "no-store" });
  if (!res.ok) throw new Error(`relayer ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const getConfig = () => get<RelayerConfig>("/config");
export const getMarkets = () => get<MarketMeta[]>("/markets");
export const getActivity = (idHex: string, limit = 30) => get<PoolTrade[]>(`/activity?market=${idHex}&limit=${limit}`);
export const getPositionHistory = (wallet: string) => get<PositionHistory[]>(`/positions/${wallet}`);

export async function requestFaucet(wallet: string): Promise<{ signature: string; usdc: number; sol: number }> {
  const res = await fetch(RELAYER_URL + "/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const body = (await res.json()) as { error?: string; retryInMs?: number; signature: string; usdc: number; sol: number };
  if (!res.ok) {
    if (res.status === 429 && body.retryInMs) {
      throw new Error(`This wallet already used the faucet. Try again in ${Math.ceil(body.retryInMs / 60000)} minutes.`);
    }
    throw new Error(body.error ?? `Faucet failed (HTTP ${res.status})`);
  }
  return body;
}
