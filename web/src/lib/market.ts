import { type MarketState, PPM, payoutRateE12, priceE6, probPpm } from "@parilayer/sdk";
import type { MarketView } from "./data";

/** Pool implied probability of outcome i, 0..1. */
export const poolProb = (m: MarketState, i: number) => probPpm(m.q, i) / PPM;

/** Pool price of outcome i in base units per share (1e6 = 1 USDC). */
export const poolPrice = (m: MarketState, i: number) => priceE6(m.q, i);

/** USDC a share of outcome i would pay if the market resolved to i right now, scaled 1e12. */
export const payoutNowRate = (m: MarketState, i: number) => payoutRateE12(m.pot, m.q[i]!);

/**
 * Implied probability of a per-share price: the price divided by what a share
 * pays if it wins today (pot / shares outstanding). For the pool price this
 * equals the pool's implied probability, so pool and secondary are comparable.
 */
export function impliedProbOfPrice(m: MarketState, i: number, priceE6PerShare: number): number {
  const payout = Number(m.pot) / Number(m.q[i]!); // USDC per share if it wins now
  return priceE6PerShare / 1e6 / payout;
}

/** Index of the outcome the pool currently favours. */
export function leadingOutcome(m: MarketState): number {
  let best = 0;
  for (let i = 1; i < m.n; i++) if (m.q[i]! > m.q[best]!) best = i;
  return best;
}

/** A market is "thin" while its pot is under 5x its seed: prices still move a lot per dollar. */
export const isThin = (m: MarketState) => m.pot < 5n * m.seedUsdc;

export const KIND_LABEL: Record<string, string> = { binary: "Yes / No", multi: "Multi-outcome", pair: "Pair pool" };

export function statusLabel(v: MarketView): string {
  const c = v.chain;
  if (!c) return "Loading";
  if (c.status === "open") return "Open";
  if (c.status === "halted") return "Halted";
  if (c.status === "voided") return "Voided";
  return c.winner !== null ? `Resolved: ${v.meta.outcomes[c.winner] ?? "?"}` : "Resolved";
}

/** A Gemini-style title split into the event (small) and what is being asked (large). */
export interface TitleParts {
  /** The event, shown small above. Null when there is none to show. */
  event: string | null;
  /** One line per question: one for a market, two (one per leg) for a pair. */
  lines: string[];
}

function splitOne(title: string): { event: string | null; name: string } {
  const i = title.indexOf(": ");
  return i > 0 ? { event: title.slice(0, i), name: title.slice(i + 2) } : { event: null, name: title };
}

/**
 * "Toronto vs Detroit: Toronto" -> event "Toronto vs Detroit", line "Toronto".
 * A pair of legs from the same event keeps the event once; a pair across
 * events shows each leg in full.
 */
export function titleParts(title: string, kind: string): TitleParts {
  if (kind === "pair") {
    const legs = title.split(" × ").map(splitOne);
    if (legs.length === 2 && legs[0]!.event && legs[0]!.event === legs[1]!.event) {
      return { event: legs[0]!.event, lines: legs.map((l) => l.name) };
    }
    return { event: null, lines: title.split(" × ") };
  }
  const { event, name } = splitOne(title);
  return { event, lines: [name] };
}

/** Board sections, in display order. Pairs get their own section. */
export function boardGroup(v: MarketView): string {
  if (v.meta.kind === "pair") return "Pairs";
  return v.meta.category || "Other";
}
export const GROUP_ORDER = ["Crypto", "Sports", "Politics", "Pairs"];
