/**
 * Pair joint pools: a 4-outcome market over two Gemini binary contracts.
 *
 * A pair pool is created on its first buy. Because the exchange pays every
 * seed, the relayer only creates one when a buyer has already signed a first
 * buy of at least 25 USDC, at most 20 new pairs are created per day, and the
 * treasury must be able to cover the seed.
 *
 * The buyer signs their buy before the pool exists (its addresses are
 * deterministic). The relayer then creates the pool and submits that signed
 * buy. It can submit only the exact transaction it showed the buyer.
 */
import { randomBytes } from "node:crypto";
import {
  PPM,
  UNIT,
  buyIxs,
  getProgram,
  marketIdFromRefs,
  marketPda,
  quoteBuy,
  seedShares,
  toHex,
} from "@pmec/sdk";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { ChainApi } from "./chain";
import type { GeminiSource } from "./gemini/client";
import type { GeminiCombo } from "./gemini/types";
import { type MarketPlan, type PairReference, findCombo, findContract, midPrice, planPair, referenceFor } from "./mapping";
import type { Relayer } from "./relayer";
import type { Store } from "./store";

/** One leg: the Gemini event to fetch and the contract inside it. */
export interface LegRef {
  event: string;
  contract: string;
}

export interface CuratedPair {
  a: LegRef;
  b: LegRef;
  /** Why these two belong together, shown in the pair builder. */
  note?: string;
}

export class PairError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PairPreview {
  idHex: string;
  address: string;
  /** True when this pool already exists on-chain. */
  exists: boolean;
  title: string;
  /** Joint outcome labels in on-chain order: No/No, No/Yes, Yes/No, Yes/Yes. */
  outcomes: string[];
  legs: PairReference["legs"];
  /** Event and contract of each leg, in the same order as `legs` (sorted by instrument symbol). */
  legRefs: LegRef[];
  /** Seed probabilities (product of the legs, clamped), ppm. */
  probsPpm: number[];
  combo: PairReference["combo"];
  seedUsdc: number;
  minFirstBuyUsdc: number;
}

interface Prepared {
  plan: MarketPlan;
  buyer: string;
  message: Uint8Array;
  expiresAt: number;
  used: boolean;
  bodies: { ticker: string; body: string }[];
}

export interface PairOptions {
  relayer: Relayer;
  gemini: GeminiSource;
  chain: ChainApi;
  store: Store;
  seedUsdc: number;
  minFirstBuyUsdc?: number;
  dailyCap?: number;
  now?: () => number;
}

// Only used to encode instructions; it never talks to the network.
const offlineProgram = getProgram(new Connection("http://127.0.0.1:8899"));

export class PairService {
  private readonly prepared = new Map<string, Prepared>();
  private combos: { at: number; list: GeminiCombo[] } = { at: 0, list: [] };
  readonly minFirstBuyUsdc: number;
  readonly dailyCap: number;
  private readonly now: () => number;

  constructor(private readonly o: PairOptions) {
    this.minFirstBuyUsdc = o.minFirstBuyUsdc ?? 25;
    this.dailyCap = o.dailyCap ?? 20;
    this.now = o.now ?? Date.now;
  }

  private async combosList(): Promise<GeminiCombo[]> {
    if (this.now() - this.combos.at > 60_000) {
      try {
        this.combos = { at: this.now(), list: await this.o.gemini.listCombos() };
      } catch {
        this.combos = { at: this.now(), list: [] };
      }
    }
    return this.combos.list;
  }

  /** Fetches both legs from Gemini and plans the pool. Fails if either is not an active binary contract. */
  private async plan(a: LegRef, b: LegRef) {
    if (!a?.event || !a?.contract || !b?.event || !b?.contract) throw new PairError(400, "Each leg needs an event ticker and a contract symbol.");
    if (a.contract === b.contract) throw new PairError(400, "Pick two different contracts.");
    const fetched = await Promise.all([this.o.gemini.getEvent(a.event), a.event === b.event ? null : this.o.gemini.getEvent(b.event)]);
    const evA = fetched[0];
    const evB = a.event === b.event ? evA : fetched[1];
    if (!evA || !evB) throw new PairError(404, "Gemini does not know one of those events.");
    const cA = findContract(evA.event, a.contract);
    const cB = findContract(evB.event, b.contract);
    if (!cA || !cB) throw new PairError(404, "One of those contracts is not in its event.");
    let plan: MarketPlan;
    try {
      plan = planPair({ event: evA.event, contract: cA }, { event: evB.event, contract: cB });
    } catch (e) {
      throw new PairError(409, (e as Error).message);
    }
    const combos = await this.combosList();
    const lookupBase = new Map([
      [evA.event.ticker, evA.event],
      [evB.event.ticker, evB.event],
    ]);
    // A combo's price lives on the combo's own event.
    if (plan.source.type === "pair") {
      const combo = findCombo(combos, plan.source.legs[0].instrumentSymbol, plan.source.legs[1].instrumentSymbol);
      if (combo) {
        const ce = await this.o.gemini.getEvent(combo.contract.eventTicker).catch(() => null);
        if (ce) lookupBase.set(ce.event.ticker, ce.event);
      }
    }
    const ref = referenceFor(plan.source, (t) => lookupBase.get(t), combos);
    const bodies = [evA, evB].filter((e, i, all) => all.indexOf(e) === i).map((e) => ({ ticker: e.event.ticker, body: e.raw }));
    return { plan, pair: ref.pair!, bodies };
  }

  /** What the pool over these two legs would be (or is): outcomes, seed odds, Gemini's combo price. */
  async preview(a: LegRef, b: LegRef): Promise<PairPreview> {
    const { plan, pair } = await this.plan(a, b);
    const marketId = marketIdFromRefs(plan.refs);
    const existing = await this.o.chain.getMarket(marketId);
    return {
      idHex: toHex(marketId),
      address: marketPda(marketId).toBase58(),
      exists: !!existing,
      title: plan.title,
      outcomes: plan.outcomes,
      legs: pair.legs,
      legRefs: pair.legs.map((l) => (l.instrumentSymbol === a.contract ? { event: a.event, contract: a.contract } : { event: b.event, contract: b.contract })),
      probsPpm: plan.probsPpm,
      combo: pair.combo,
      seedUsdc: this.o.seedUsdc,
      minFirstBuyUsdc: this.minFirstBuyUsdc,
    };
  }

  /**
   * Step 1: checks every rule and returns the first-buy transaction for the
   * buyer to sign. Nothing is created yet.
   */
  async prepare(a: LegRef, b: LegRef, buyerText: string, outcome: number, usdcInText: string) {
    let buyer: PublicKey;
    try {
      buyer = new PublicKey(buyerText);
    } catch {
      throw new PairError(400, "buyer must be a Solana address.");
    }
    if (!/^\d{1,20}$/.test(usdcInText ?? "")) throw new PairError(400, "usdcIn must be a whole number of base units.");
    const usdcIn = BigInt(usdcInText);
    if (!Number.isInteger(outcome) || outcome < 0 || outcome > 3) throw new PairError(400, "outcome must be 0 to 3.");
    if (usdcIn < BigInt(this.minFirstBuyUsdc) * UNIT) {
      throw new PairError(400, `The first buy of a new pair must be at least ${this.minFirstBuyUsdc} USDC, because the exchange pays the seed.`);
    }

    const { plan, pair, bodies } = await this.plan(a, b);
    const marketId = marketIdFromRefs(plan.refs);
    const idHex = toHex(marketId);
    if (await this.o.chain.getMarket(marketId)) {
      throw new PairError(409, "This pair already has a pool. Buy from it on its market page.");
    }
    if (this.o.store.pairCreationsSince(this.now() - 24 * 60 * 60 * 1000) >= this.dailyCap) {
      throw new PairError(429, `New pairs are capped at ${this.dailyCap} a day, and today's are used up. Existing pairs can still be traded.`);
    }
    const seed = BigInt(this.o.seedUsdc) * UNIT;
    if ((await this.o.chain.treasuryBalance()) < seed) throw new PairError(503, "The treasury cannot cover the seed for a new pair right now.");
    const cfg = await this.o.chain.getConfig();
    if (!cfg) throw new PairError(503, "The exchange is not initialized.");
    if ((await this.o.chain.usdcBalance(buyer)) < usdcIn) throw new PairError(400, "This wallet does not hold enough USDC for that first buy.");

    // Quote against the pool exactly as it will be seeded, with 1% slippage room.
    const q = seedShares(plan.probsPpm, seed);
    const quote = quoteBuy(q, seed, outcome, usdcIn, cfg.poolFeeBps);
    const minSharesOut = (quote.shares * 99n) / 100n;
    const market = marketPda(marketId);
    const ixs = await buyIxs(offlineProgram, { buyer, market, usdcMint: cfg.usdcMint, outcome, usdcIn, minSharesOut });
    const { blockhash, lastValidBlockHeight } = await this.o.chain.latestBlockhash();
    const tx = new Transaction({ feePayer: buyer, blockhash, lastValidBlockHeight }).add(...ixs);

    const prepareId = randomBytes(12).toString("hex");
    this.prepared.set(prepareId, { plan, buyer: buyer.toBase58(), message: Uint8Array.from(tx.serializeMessage()), expiresAt: this.now() + 60_000, used: false, bodies });
    for (const [id, p] of this.prepared) if (p.expiresAt < this.now() - 60_000) this.prepared.delete(id);

    return {
      prepareId,
      idHex,
      address: market.toBase58(),
      title: plan.title,
      outcomes: plan.outcomes,
      legs: pair.legs,
      probsPpm: plan.probsPpm,
      combo: pair.combo,
      outcome,
      usdcIn: usdcIn.toString(),
      shares: quote.shares.toString(),
      minSharesOut: minSharesOut.toString(),
      probAfter: quote.probAfterPpm / PPM,
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      expiresAt: this.now() + 60_000,
    };
  }

  /**
   * Step 2: the buyer returns the signed first buy. The relayer creates the
   * pool (seeded from the treasury at the product of the legs) and then
   * submits the buy.
   */
  async create(prepareId: string, signedTxBase64: string) {
    const p = this.prepared.get(prepareId);
    if (!p || p.used || p.expiresAt < this.now()) throw new PairError(410, "That request expired. Start again.");

    let raw: Buffer;
    let tx: Transaction;
    try {
      raw = Buffer.from(signedTxBase64, "base64");
      tx = Transaction.from(raw);
    } catch {
      throw new PairError(400, "That is not a transaction.");
    }
    const message = tx.serializeMessage();
    const same = message.length === p.message.length && message.every((byte, i) => byte === p.message[i]);
    if (!same || !tx.verifySignatures()) throw new PairError(400, "That is not the signed first buy this pool was offered for.");
    p.used = true;

    // The rules may have changed in the last minute; check the ones that protect the treasury again.
    const marketId = marketIdFromRefs(p.plan.refs);
    if (await this.o.chain.getMarket(marketId)) throw new PairError(409, "This pair already has a pool. Buy from it on its market page.");
    if (this.o.store.pairCreationsSince(this.now() - 24 * 60 * 60 * 1000) >= this.dailyCap) {
      throw new PairError(429, `New pairs are capped at ${this.dailyCap} a day, and today's are used up.`);
    }

    const created = await this.o.relayer.createFromPlan(p.plan, { seedUsdc: this.o.seedUsdc, creator: p.buyer, geminiBodies: p.bodies });
    this.o.store.recordPairCreation(created.idHex, p.buyer, this.now());
    let buySignature: string | null = null;
    let buyError: string | null = null;
    try {
      buySignature = await this.o.chain.submitRaw(raw);
    } catch (e) {
      // The pool exists; the buyer can still buy from its market page.
      buyError = (e as Error).message.split("\n")[0] ?? "the first buy did not land";
    }
    return { idHex: created.idHex, address: created.address, buySignature, buyError };
  }

  /** The curated list with live prices, so the builder can show them without extra round trips. */
  async curated(list: CuratedPair[]): Promise<(PairPreview & { note: string | null })[]> {
    const out: (PairPreview & { note: string | null })[] = [];
    for (const c of list) {
      try {
        out.push({ ...(await this.preview(c.a, c.b)), note: c.note ?? null });
      } catch {
        // A leg that has settled or disappeared just drops off the list.
      }
    }
    return out;
  }
}

/** Legs offered in the builder: every tradable contract of the given events. */
export async function legChoices(gemini: GeminiSource, events: string[]) {
  const out: { event: string; contract: string; label: string; yes: number | null }[] = [];
  for (const ticker of [...new Set(events)]) {
    const fetched = await gemini.getEvent(ticker).catch(() => null);
    if (!fetched) continue;
    for (const c of fetched.event.contracts) {
      if (c.status !== "active" || c.marketState === "closed") continue;
      const label = fetched.event.contracts.length === 1 ? fetched.event.title : `${fetched.event.title}: ${c.label}`;
      out.push({ event: ticker, contract: c.instrumentSymbol, label, yes: midPrice(c.prices) });
    }
  }
  return out;
}
