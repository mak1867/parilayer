import { PublicKey } from "@solana/web3.js";
import idl from "./idl/pmec.json";

/** The deployed program. Comes from the IDL so there is one source of truth. */
export const PROGRAM_ID = new PublicKey(idl.address);

/** Base units in 1 USDC and in 1 share (both have 6 decimals). */
export const UNIT = 1_000_000n;
export const DECIMALS = 6;
/** Scale of payout-per-share and void-price rates. */
export const RATE_SCALE = 1_000_000_000_000n;
export const PPM = 1_000_000;
/** Seed probabilities are clamped to [0.5%, 99.5%]. */
export const MIN_PROB_PPM = 5_000;
export const MAX_PROB_PPM = 995_000;
export const BPS = 10_000n;
export const MAX_FEE_BPS = 1_000;
/** Pot cap per market: 1 billion USDC. */
export const MAX_POT = 1_000_000_000_000_000n;
export const MIN_SEED = UNIT;
export const MAX_OUTCOMES = 32;
export const NO_WINNER = 255;

const bytes = (s: string) => new TextEncoder().encode(s);

/** PDA seeds. Plain byte arrays so this file works in the browser without a Buffer polyfill. */
export const SEEDS = {
  config: bytes("config"),
  treasury: bytes("fees"),
  market: bytes("market"),
  mint: bytes("mint"),
  vault: bytes("vault"),
  seedShares: bytes("seed_shares"),
} as const;
