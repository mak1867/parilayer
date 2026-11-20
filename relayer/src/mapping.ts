/**
 * Pure rules that turn Gemini data into decisions. No I/O here, so every rule
 * is unit-tested against recorded Gemini responses.
 *
 *   planMarkets        Gemini event  -> which market(s) to create, seeded at what odds
 *   referenceFor       Gemini events -> reference price per outcome
 *   settlementDecision Gemini events -> resolve / void / halt / unhalt / nothing
 */
import { type MarketKind, type MarketStatus, clampNormalize, pairWeights } from "@parilayer/sdk";
import type { GeminiCombo, GeminiContract, GeminiEvent, GeminiPrices } from "./gemini/types";

// ------------------------------------------------------------------ prices

function parsePrice(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s === "") return null;
  const x = Number(s);
  return Number.isFinite(x) && x >= 0 && x <= 1 ? x : null;
}

/**
 * Gemini's YES price for a contract, 0..1, or null if there is nothing to go on.
 *
 * - Both sides quoted: the midpoint of best bid and best ask.
 * - One side or neither: the last trade, kept inside whatever the book does
 *   show (never above the best ask, never below the best bid), because a last
 *   trade can be stale.
 * - No last trade either: the midpoint of the quoted range, taking a missing
 *   bid as 0 and a missing ask as 1. With an empty book and no trade: null.
 */
export function midPrice(prices: GeminiPrices | null | undefined): number | null {
  if (!prices) return null;
  const bid = parsePrice(prices.bestBid);
  const ask = parsePrice(prices.bestAsk);
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  const last = parsePrice(prices.lastTradePrice);
  if (last !== null) return Math.min(Math.max(last, bid ?? 0), ask ?? 1);
  if (bid !== null || ask !== null) return ((bid ?? 0) + (ask ?? 1)) / 2;
  return null;
}

// ------------------------------------------------------------------ what to mirror

/** One line of the mirror config file. */
export type MirrorEntry =
  /** One contract as a YES/NO market. */
  | { kind: "binary"; event: string; contract: string }
  /** Every active contract of the event as its own YES/NO market. */
  | { kind: "binary-all"; event: string }
  /**
   * The whole event as one multi-outcome market. Only for events whose
   * contracts are mutually exclusive; Gemini has no field that says so, which
   * is why this is opt-in per event. `addOther` adds an outcome that wins when
   * no contract settles YES.
   */
  | { kind: "multi"; event: string; addOther?: boolean };

/** Where a market's outcomes come from on Gemini. Stored with the market. */
export type MarketSource =
  | { type: "binary"; eventTicker: string; instrumentSymbol: string }
  | { type: "multi"; eventTicker: string; contracts: string[]; hasOther: boolean }
  | { type: "pair"; legs: [PairLeg, PairLeg] };

export interface PairLeg {
  eventTicker: string;
  instrumentSymbol: string;
  label: string;
}

export interface MarketPlan {
  kind: MarketKind;
  /** Stored on-chain; the market id is the hash of these, sorted. */
  refs: string[];
  title: string;
  category: string;
  /** Outcome labels in on-chain index order. */
  outcomes: string[];
  /** Gemini's probability per outcome, normalized to sum 1, before clamping. */
  geminiProbs: number[];
  /** Seed probabilities: clamped to [0.5%, 99.5%], summing to 1e6 ppm. */
  probsPpm: number[];
  source: MarketSource;
  expiryDate: string | null;
}

export const OTHER_LABEL = "Other";
/** A "multi" event whose YES prices sum above this is not mutually exclusive. */
export const MAX_EXCLUSIVE_SUM = 1.15;
/** Below this the listed contracts clearly miss part of the outcome space. */
export const MIN_EXHAUSTIVE_SUM = 0.85;

const isTradable = (c: GeminiContract) => c.status === "active" && c.marketState !== "closed";

function bySortOrder(contracts: GeminiContract[]): GeminiContract[] {
  return contracts
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.sortOrder ?? 1e9) - (b.c.sortOrder ?? 1e9) || a.i - b.i)
    .map((x) => x.c);
}

function normalize(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  return total > 0 ? weights.map((w) => w / total) : weights.map(() => 1 / weights.length);
}

function binaryPlan(event: GeminiEvent, c: GeminiContract): MarketPlan {
  const yes = midPrice(c.prices);
  if (yes === null) throw new Error(`${c.instrumentSymbol}: no bid, ask or last trade to seed from`);
  const weights = [1 - yes, yes]; // index 0 = NO, 1 = YES
  return {
    kind: "binary",
    refs: [c.instrumentSymbol],
    title: event.contracts.length === 1 ? event.title : `${event.title}: ${c.label}`,
    category: event.category,
    outcomes: ["No", "Yes"],
    geminiProbs: weights,
    probsPpm: clampNormalize(weights),
    source: { type: "binary", eventTicker: event.ticker, instrumentSymbol: c.instrumentSymbol },
    expiryDate: c.expiryDate ?? event.expiryDate ?? null,
  };
}

/** The market(s) one config entry asks for, seeded at Gemini's current prices. */
export function planMarkets(entry: MirrorEntry, event: GeminiEvent): MarketPlan[] {
  if (event.ticker !== entry.event) throw new Error(`expected event ${entry.event}, got ${event.ticker}`);

  if (entry.kind === "binary") {
    const c = event.contracts.find((c) => c.instrumentSymbol === entry.contract);
    if (!c) throw new Error(`${entry.event}: no contract ${entry.contract}`);
    if (!isTradable(c)) throw new Error(`${c.instrumentSymbol}: not open for trading (${c.status}/${c.marketState})`);
    return [binaryPlan(event, c)];
  }

  if (entry.kind === "binary-all") {
    return bySortOrder(event.contracts)
      .filter((c) => isTradable(c) && midPrice(c.prices) !== null)
      .map((c) => binaryPlan(event, c));
  }

  // multi
  if (event.type !== "categorical") throw new Error(`${event.ticker}: type is ${event.type}, not categorical`);
  if (event.contracts.some((c) => c.resolutionSide === "yes")) {
    throw new Error(`${event.ticker}: a contract has already settled YES`);
  }
  const contracts = bySortOrder(event.contracts).filter(isTradable);
  const addOther = entry.addOther ?? false;
  const n = contracts.length + (addOther ? 1 : 0);
  if (n < 3) throw new Error(`${event.ticker}: ${n} outcomes; mirror a 2-way event as a binary market instead`);
  if (n > 32) throw new Error(`${event.ticker}: ${n} outcomes is over the 32 limit`);

  const mids = contracts.map((c) => midPrice(c.prices) ?? 0);
  const sum = mids.reduce((a, b) => a + b, 0);
  if (sum > MAX_EXCLUSIVE_SUM) {
    throw new Error(
      `${event.ticker}: YES prices sum to ${sum.toFixed(2)}; these contracts are not mutually exclusive. Use "binary-all".`,
    );
  }
  if (!addOther && sum < MIN_EXHAUSTIVE_SUM) {
    throw new Error(
      `${event.ticker}: YES prices sum to only ${sum.toFixed(2)}; the contracts may not cover every result. Set "addOther": true.`,
    );
  }
  const weights = addOther ? [...mids, Math.max(0, 1 - sum)] : mids;
  return [
    {
      kind: "multi",
      refs: [event.ticker],
      title: event.title,
      category: event.category,
      outcomes: [...contracts.map((c) => c.label), ...(addOther ? [OTHER_LABEL] : [])],
      geminiProbs: normalize(weights),
      probsPpm: clampNormalize(weights),
      source: {
        type: "multi",
        eventTicker: event.ticker,
        contracts: contracts.map((c) => c.instrumentSymbol),
        hasOther: addOther,
      },
      expiryDate: event.expiryDate ?? null,
    },
  ];
}

/** Looks a contract up by its instrument symbol. */
export function findContract(event: GeminiEvent | undefined, instrumentSymbol: string): GeminiContract | undefined {
  return event?.contracts.find((c) => c.instrumentSymbol === instrumentSymbol);
}

/**
 * A pair joint pool over two binary contracts. Legs are ordered by instrument
 * symbol so the same two contracts always give the same pool. Outcome index =
 * 2*a + b (a = leg A is YES, b = leg B is YES): [NN, NY, YN, YY]. The seed is
 * the product of the legs' probabilities.
 */
export function planPair(
  legA: { event: GeminiEvent; contract: GeminiContract },
  legB: { event: GeminiEvent; contract: GeminiContract },
): MarketPlan {
  if (legA.contract.instrumentSymbol === legB.contract.instrumentSymbol) throw new Error("a pair needs two different contracts");
  const [a, b] = [legA, legB].sort((x, y) => (x.contract.instrumentSymbol < y.contract.instrumentSymbol ? -1 : 1)) as [
    typeof legA,
    typeof legB,
  ];
  for (const leg of [a, b]) {
    if (!isTradable(leg.contract)) throw new Error(`${leg.contract.instrumentSymbol}: not an active contract`);
  }
  const pA = midPrice(a.contract.prices);
  const pB = midPrice(b.contract.prices);
  if (pA === null || pB === null) throw new Error("a leg has no price to seed from");
  const weights = pairWeights(pA, pB);
  const name = (l: typeof a) => (l.event.contracts.length === 1 ? l.event.title : `${l.event.title}: ${l.contract.label}`);
  const la = name(a);
  const lb = name(b);
  const expiries = [a, b].map((l) => l.contract.expiryDate ?? l.event.expiryDate ?? null).filter((x): x is string => !!x);
  return {
    kind: "pair",
    refs: [a.contract.instrumentSymbol, b.contract.instrumentSymbol],
    title: `${la} × ${lb}`,
    category: a.event.category === b.event.category ? a.event.category : "Pairs",
    outcomes: ["No / No", "No / Yes", "Yes / No", "Yes / Yes"],
    geminiProbs: [...weights],
    probsPpm: clampNormalize(weights),
    source: {
      type: "pair",
      legs: [
        { eventTicker: a.event.ticker, instrumentSymbol: a.contract.instrumentSymbol, label: la },
        { eventTicker: b.event.ticker, instrumentSymbol: b.contract.instrumentSymbol, label: lb },
      ],
    },
    expiryDate: expiries.length ? expiries.sort()[expiries.length - 1]! : null,
  };
}

/** Event tickers a market needs fetched to price or settle it. */
export function eventTickers(source: MarketSource): string[] {
  if (source.type === "pair") return [...new Set(source.legs.map((l) => l.eventTicker))];
  return [source.eventTicker];
}

// ------------------------------------------------------------------ reference prices

export interface PairReference {
  /** Gemini's YES price for each leg. */
  legs: { label: string; instrumentSymbol: string; yes: number | null }[];
  /** Product of the legs per joint outcome [NN, NY, YN, YY], if both legs have a price. */
  product: number[] | null;
  /** Gemini's own combo instrument on these two legs, when one exists. */
  combo: { instrumentSymbol: string | null; eventTicker: string; outcomeIndex: number; price: number | null } | null;
}

export interface Reference {
  /** Gemini's price for each outcome (0..1), in on-chain index order; null if unknown. */
  prices: (number | null)[];
  /** The same, normalized to sum to 1 (comparable with pool probabilities). */
  normalized: (number | null)[];
  pair?: PairReference;
}

export type EventLookup = (ticker: string) => GeminiEvent | undefined;

const symbolsKey = (symbols: string[]) => [...symbols].sort().join("|");

/** Finds Gemini's combo built from exactly these two legs, if any. */
export function findCombo(combos: GeminiCombo[], symbolA: string, symbolB: string): GeminiCombo | undefined {
  const want = symbolsKey([symbolA, symbolB]);
  return combos.find(
    (c) => c.legs.length === 2 && symbolsKey(c.legs.map((l) => l.contract?.instrumentSymbol ?? "")) === want,
  );
}

export function referenceFor(source: MarketSource, lookup: EventLookup, combos: GeminiCombo[] = []): Reference {
  const norm = (prices: (number | null)[]) => {
    const total = prices.reduce<number>((a, p) => a + (p ?? 0), 0);
    return prices.map((p) => (p === null || total <= 0 ? null : p / total));
  };

  if (source.type === "binary") {
    const yes = midPrice(findContract(lookup(source.eventTicker), source.instrumentSymbol)?.prices);
    const prices = yes === null ? [null, null] : [1 - yes, yes];
    return { prices, normalized: prices };
  }

  if (source.type === "multi") {
    const event = lookup(source.eventTicker);
    const mids = source.contracts.map((s) => midPrice(findContract(event, s)?.prices));
    const known = mids.reduce<number>((a, p) => a + (p ?? 0), 0);
    const prices = source.hasOther ? [...mids, event ? Math.max(0, 1 - known) : null] : mids;
    return { prices, normalized: norm(prices) };
  }

  const [a, b] = source.legs;
  const pA = midPrice(findContract(lookup(a.eventTicker), a.instrumentSymbol)?.prices);
  const pB = midPrice(findContract(lookup(b.eventTicker), b.instrumentSymbol)?.prices);
  const product = pA !== null && pB !== null ? [...pairWeights(pA, pB)] : null;

  let combo: PairReference["combo"] = null;
  const found = findCombo(combos, a.instrumentSymbol, b.instrumentSymbol);
  if (found) {
    const side = (symbol: string) =>
      found.legs.find((l) => l.contract?.instrumentSymbol === symbol)?.requiredOutcome === "Yes" ? 1 : 0;
    const comboEvent = lookup(found.contract.eventTicker);
    combo = {
      instrumentSymbol: found.contract.instrumentSymbol ?? null,
      eventTicker: found.contract.eventTicker,
      outcomeIndex: 2 * side(a.instrumentSymbol) + side(b.instrumentSymbol),
      price: midPrice(comboEvent?.contracts[0]?.prices),
    };
  }
  const prices = product ?? [null, null, null, null];
  return {
    prices,
    normalized: prices,
    pair: {
      legs: [
        { label: a.label, instrumentSymbol: a.instrumentSymbol, yes: pA },
        { label: b.label, instrumentSymbol: b.instrumentSymbol, yes: pB },
      ],
      product,
      combo,
    },
  };
}

// ------------------------------------------------------------------ settlement

export type Decision =
  | { action: "none"; reason: string; warning?: string }
  | { action: "halt" | "unhalt"; reason: string }
  | { action: "resolve"; winner: number; reason: string }
  | { action: "void"; reason: string };

type LegState = "yes" | "no" | "void" | "closed" | "open" | "missing";

/** Where one Gemini contract stands. */
export function contractState(c: GeminiContract | undefined): LegState {
  if (!c) return "missing";
  if (c.status === "settled") return c.resolutionSide === "yes" || c.resolutionSide === "no" ? c.resolutionSide : "void";
  // "invalid" is in Gemini's status enum without a definition; we treat it as a void.
  if (c.status === "invalid") return "void";
  if (c.marketState === "closed" || c.status === "closed" || c.status === "under_review") return "closed";
  return "open";
}

/** Halt when Gemini is not trading, unhalt when it is again; otherwise leave alone. */
function haltOrNothing(geminiTrading: boolean, chain: MarketStatus, why: string): Decision {
  if (!geminiTrading && chain === "open") return { action: "halt", reason: why };
  if (geminiTrading && chain === "halted") return { action: "unhalt", reason: "Gemini is trading again" };
  return { action: "none", reason: geminiTrading ? "open on Gemini" : why };
}

/**
 * What the oracle should do for one market, given Gemini's current data and
 * the market's on-chain status. Once a market is resolved or voided on-chain
 * this always answers "none", so a settlement is posted once.
 */
export function settlementDecision(source: MarketSource, lookup: EventLookup, chain: MarketStatus): Decision {
  if (chain === "resolved" || chain === "voided") return { action: "none", reason: "already settled on-chain" };

  if (source.type === "binary") {
    const event = lookup(source.eventTicker);
    if (!event) return { action: "none", reason: "event not fetched", warning: `no data for ${source.eventTicker}` };
    const s = contractState(findContract(event, source.instrumentSymbol));
    if (s === "yes") return { action: "resolve", winner: 1, reason: `${source.instrumentSymbol} settled YES` };
    if (s === "no") return { action: "resolve", winner: 0, reason: `${source.instrumentSymbol} settled NO` };
    if (s === "void") return { action: "void", reason: `${source.instrumentSymbol} was voided by Gemini` };
    if (s === "missing") {
      return { action: "none", reason: "contract missing", warning: `${source.instrumentSymbol} is not in ${event.ticker}` };
    }
    return haltOrNothing(s === "open", chain, `${source.instrumentSymbol} is closed on Gemini`);
  }

  if (source.type === "multi") {
    const event = lookup(source.eventTicker);
    if (!event) return { action: "none", reason: "event not fetched", warning: `no data for ${source.eventTicker}` };
    if (event.status === "invalid") return { action: "void", reason: `${event.ticker} was voided by Gemini` };
    const states = source.contracts.map((s) => contractState(findContract(event, s)));
    if (states.includes("missing")) {
      return { action: "none", reason: "contract missing", warning: `a mirrored contract is not in ${event.ticker}` };
    }
    const yes = states.flatMap((s, i) => (s === "yes" ? [i] : []));
    if (yes.length > 1) {
      return {
        action: "none",
        reason: "more than one contract settled YES",
        warning: `${event.ticker}: ${yes.length} contracts settled YES; not mutually exclusive, needs a human`,
      };
    }
    if (yes.length === 1) {
      return { action: "resolve", winner: yes[0]!, reason: `${source.contracts[yes[0]!]} settled YES` };
    }
    const unsettled = states.filter((s) => s === "open" || s === "closed");
    if (unsettled.length === 0) {
      if (states.every((s) => s === "void")) return { action: "void", reason: `every contract of ${event.ticker} was voided` };
      return source.hasOther
        ? { action: "resolve", winner: source.contracts.length, reason: "no contract settled YES; Other wins" }
        : { action: "void", reason: "no contract settled YES and there is no Other outcome" };
    }
    const trading = event.status !== "closed" && event.status !== "under_review" && unsettled.some((s) => s === "open");
    return haltOrNothing(trading, chain, `${event.ticker} is closed on Gemini`);
  }

  // pair
  const [a, b] = source.legs;
  const sa = contractState(findContract(lookup(a.eventTicker), a.instrumentSymbol));
  const sb = contractState(findContract(lookup(b.eventTicker), b.instrumentSymbol));
  if (sa === "missing" || sb === "missing") {
    return { action: "none", reason: "leg not fetched", warning: `missing data for a leg of ${a.instrumentSymbol} × ${b.instrumentSymbol}` };
  }
  if (sa === "void" || sb === "void") return { action: "void", reason: "a leg was voided by Gemini" };
  const decided = (s: LegState): s is "yes" | "no" => s === "yes" || s === "no";
  if (decided(sa) && decided(sb)) {
    const winner = 2 * (sa === "yes" ? 1 : 0) + (sb === "yes" ? 1 : 0);
    return { action: "resolve", winner, reason: `legs settled ${sa.toUpperCase()} / ${sb.toUpperCase()}` };
  }
  // One leg settled or closed: Gemini is no longer trading the full pair, so halt.
  return haltOrNothing(sa === "open" && sb === "open", chain, "a leg is settled or closed on Gemini");
}
