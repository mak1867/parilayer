/**
 * Thin client over the on-chain program: decoded account types and the
 * instruction builders every service and the frontend share.
 */
import { Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
// bn.js directly: Node cannot see BN as a named export of the Anchor package.
import BN from "bn.js";
import { NO_WINNER } from "./constants";
import type { Pmec } from "./idl/pmec";
import idl from "./idl/pmec.json";
import { toHex } from "./marketId";
import { configPda, marketPda, outcomeMintPda, seedSharesPda, treasuryPda, vaultPda } from "./pda";

export type PmecProgram = Program<Pmec>;

export type MarketKind = "binary" | "multi" | "pair";
export type MarketStatus = "open" | "halted" | "resolved" | "voided";

export interface ConfigState {
  address: PublicKey;
  admin: PublicKey;
  oracle: PublicKey;
  usdcMint: PublicKey;
  poolFeeBps: number;
  secondaryFeeBps: number;
  feesCollected: bigint;
  seedsPaid: bigint;
  seedPayouts: bigint;
  dustSwept: bigint;
  marketCount: bigint;
}

export interface MarketState {
  address: PublicKey;
  marketId: Uint8Array;
  /** Hex of marketId; the id used in service URLs. */
  idHex: string;
  kind: MarketKind;
  /** Gemini tickers this market mirrors. */
  refs: string[];
  n: number;
  /** Shares outstanding per outcome (length n), seed included. */
  q: bigint[];
  /** USDC owed to holders. */
  pot: bigint;
  status: MarketStatus;
  winner: number | null;
  /** USDC per winning share, scaled 1e12 (0 until resolved). */
  payoutPerShare: bigint;
  /** Void price per share, scaled 1e12 (zeros unless voided). */
  finalPrices: bigint[];
  createdAt: number;
  resolvedAt: number;
  seedUsdc: bigint;
  burned: bigint[];
  mintsReady: number;
}

/** A program handle. Without a wallet it can read accounts and build instructions. */
export function getProgram(connection: Connection): PmecProgram {
  return new Program<Pmec>(idl as Pmec, { connection });
}

const big = (x: { toString(): string }) => BigInt(x.toString());
const enumKey = (e: object) => Object.keys(e)[0]!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeConfig(address: PublicKey, raw: any): ConfigState {
  return {
    address,
    admin: raw.admin,
    oracle: raw.oracle,
    usdcMint: raw.usdcMint,
    poolFeeBps: raw.poolFeeBps,
    secondaryFeeBps: raw.secondaryFeeBps,
    feesCollected: big(raw.feesCollected),
    seedsPaid: big(raw.seedsPaid),
    seedPayouts: big(raw.seedPayouts),
    dustSwept: big(raw.dustSwept),
    marketCount: big(raw.marketCount),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeMarket(address: PublicKey, raw: any): MarketState {
  const n: number = raw.nOutcomes;
  const marketId = Uint8Array.from(raw.marketId as number[]);
  return {
    address,
    marketId,
    idHex: toHex(marketId),
    kind: enumKey(raw.kind) as MarketKind,
    refs: raw.geminiRefs as string[],
    n,
    q: (raw.q as BN[]).slice(0, n).map(big),
    pot: big(raw.pot),
    status: enumKey(raw.status) as MarketStatus,
    winner: raw.winner === NO_WINNER ? null : (raw.winner as number),
    payoutPerShare: big(raw.payoutPerShare),
    finalPrices: (raw.finalPrices as BN[]).slice(0, n).map(big),
    createdAt: Number(raw.createdAt),
    resolvedAt: Number(raw.resolvedAt),
    seedUsdc: big(raw.seedUsdc),
    burned: (raw.burned as BN[]).slice(0, n).map(big),
    mintsReady: raw.mintsReady as number,
  };
}

export async function fetchConfig(program: PmecProgram): Promise<ConfigState | null> {
  const address = configPda();
  const raw = await program.account.config.fetchNullable(address);
  return raw ? decodeConfig(address, raw) : null;
}

export async function fetchMarket(program: PmecProgram, address: PublicKey): Promise<MarketState | null> {
  const raw = await program.account.market.fetchNullable(address);
  return raw ? decodeMarket(address, raw) : null;
}

export async function fetchMarketById(program: PmecProgram, marketId: Uint8Array): Promise<MarketState | null> {
  return fetchMarket(program, marketPda(marketId));
}

export async function fetchAllMarkets(program: PmecProgram): Promise<MarketState[]> {
  const all = await program.account.market.all();
  return all.map((a) => decodeMarket(a.publicKey, a.account)).sort((a, b) => a.createdAt - b.createdAt);
}

/** True once every outcome mint of the market exists. */
export function allMintsReady(m: Pick<MarketState, "n" | "mintsReady">): boolean {
  const want = m.n >= 32 ? 0xffffffff : (1 << m.n) - 1;
  return (m.mintsReady >>> 0) === (want >>> 0);
}

export const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

const bn = (x: bigint | number) => new BN(x.toString());

// ------------------------------------------------------------------ admin / oracle

export function initializeIx(
  program: PmecProgram,
  args: { admin: PublicKey; oracle: PublicKey; usdcMint: PublicKey; poolFeeBps: number; secondaryFeeBps: number },
): Promise<TransactionInstruction> {
  return program.methods
    .initialize(args.oracle, args.poolFeeBps, args.secondaryFeeBps)
    .accountsStrict({
      admin: args.admin,
      config: configPda(),
      usdcMint: args.usdcMint,
      treasuryVault: treasuryPda(),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface CreateMarketArgs {
  oracle: PublicKey;
  usdcMint: PublicKey;
  marketId: Uint8Array;
  kind: MarketKind;
  refs: string[];
  probsPpm: number[];
  seedUsdc: bigint;
}

const kindArg = (kind: MarketKind) =>
  kind === "binary" ? { binary: {} } : kind === "multi" ? { multi: {} } : { pair: {} };

export function createMarketIx(program: PmecProgram, a: CreateMarketArgs): Promise<TransactionInstruction> {
  const market = marketPda(a.marketId);
  return program.methods
    .createMarket(Array.from(a.marketId), kindArg(a.kind), a.refs, a.probsPpm.length, a.probsPpm, bn(a.seedUsdc))
    .accountsStrict({
      oracle: a.oracle,
      config: configPda(),
      market,
      potVault: vaultPda(market),
      treasuryVault: treasuryPda(),
      usdcMint: a.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function initOutcomeMintIx(
  program: PmecProgram,
  a: { oracle: PublicKey; market: PublicKey; i: number },
): Promise<TransactionInstruction> {
  return program.methods
    .initOutcomeMint(a.i)
    .accountsStrict({
      oracle: a.oracle,
      config: configPda(),
      market: a.market,
      outcomeMint: outcomeMintPda(a.market, a.i),
      seedShares: seedSharesPda(a.market, a.i),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

const oracleAccounts = (oracle: PublicKey, market: PublicKey) => ({ oracle, config: configPda(), market });

export const haltIx = (program: PmecProgram, oracle: PublicKey, market: PublicKey) =>
  program.methods.halt().accountsStrict(oracleAccounts(oracle, market)).instruction();

export const unhaltIx = (program: PmecProgram, oracle: PublicKey, market: PublicKey) =>
  program.methods.unhalt().accountsStrict(oracleAccounts(oracle, market)).instruction();

export const resolveIx = (program: PmecProgram, oracle: PublicKey, market: PublicKey, winner: number) =>
  program.methods.resolve(winner).accountsStrict(oracleAccounts(oracle, market)).instruction();

export const voidIx = (program: PmecProgram, oracle: PublicKey, market: PublicKey) =>
  program.methods.void().accountsStrict(oracleAccounts(oracle, market)).instruction();

export function sweepDustIx(
  program: PmecProgram,
  a: { admin: PublicKey; market: PublicKey; usdcMint: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .sweepDust()
    .accountsStrict({
      admin: a.admin,
      config: configPda(),
      market: a.market,
      potVault: vaultPda(a.market),
      treasuryVault: treasuryPda(),
      usdcMint: a.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

// ------------------------------------------------------------------ traders

export interface BuyArgs {
  buyer: PublicKey;
  market: PublicKey;
  usdcMint: PublicKey;
  outcome: number;
  /** Gross USDC to spend, fee included (base units). */
  usdcIn: bigint;
  /** Fail if fewer shares than this would be minted. */
  minSharesOut: bigint;
  /** Wallet that receives the shares. Defaults to the buyer. */
  recipient?: PublicKey;
}

/** Instructions for a pool buy: create the share account if needed, then buy. */
export async function buyIxs(program: PmecProgram, a: BuyArgs): Promise<TransactionInstruction[]> {
  const mint = outcomeMintPda(a.market, a.outcome);
  const recipient = a.recipient ?? a.buyer;
  const recipientShares = ata(mint, recipient);
  const createAta = createAssociatedTokenAccountIdempotentInstruction(
    a.buyer,
    recipientShares,
    recipient,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const buy = await program.methods
    .buy(a.outcome, bn(a.usdcIn), bn(a.minSharesOut))
    .accountsStrict({
      buyer: a.buyer,
      config: configPda(),
      market: a.market,
      outcomeMint: mint,
      buyerUsdc: ata(a.usdcMint, a.buyer),
      recipientShares,
      potVault: vaultPda(a.market),
      treasuryVault: treasuryPda(),
      usdcMint: a.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return [createAta, buy];
}

export interface RedeemArgs {
  holder: PublicKey;
  market: PublicKey;
  usdcMint: PublicKey;
  outcome: number;
  /** Shares to burn (base units). */
  amount: bigint;
}

/** Instructions to redeem shares after resolution or void. */
export async function redeemIxs(program: PmecProgram, a: RedeemArgs): Promise<TransactionInstruction[]> {
  const mint = outcomeMintPda(a.market, a.outcome);
  const recipientUsdc = ata(a.usdcMint, a.holder);
  const createAta = createAssociatedTokenAccountIdempotentInstruction(
    a.holder,
    recipientUsdc,
    a.holder,
    a.usdcMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const redeem = await program.methods
    .redeem(a.outcome, bn(a.amount))
    .accountsStrict({
      holder: a.holder,
      market: a.market,
      outcomeMint: mint,
      holderShares: ata(mint, a.holder),
      recipientUsdc,
      potVault: vaultPda(a.market),
      usdcMint: a.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return [createAta, redeem];
}

/** Permissionless: pays the treasury for its seed shares of `outcome`. */
export function redeemSeedIx(
  program: PmecProgram,
  a: { market: PublicKey; usdcMint: PublicKey; outcome: number },
): Promise<TransactionInstruction> {
  return program.methods
    .redeemSeed(a.outcome)
    .accountsStrict({
      config: configPda(),
      market: a.market,
      outcomeMint: outcomeMintPda(a.market, a.outcome),
      seedShares: seedSharesPda(a.market, a.outcome),
      potVault: vaultPda(a.market),
      treasuryVault: treasuryPda(),
      usdcMint: a.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}
