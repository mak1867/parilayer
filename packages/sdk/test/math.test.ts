import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MathError,
  RATE_SCALE,
  isqrt,
  payoutRateE12,
  priceE6,
  probPpm,
  quoteBuy,
  quoteSell,
  seedShares,
  voidRatesE12,
} from "../src";

interface Step {
  kind?: "sell";
  outcome: number;
  usdcIn?: string;
  shares?: string;
  seedFloor?: string;
  usdcOut?: string;
  gross?: string;
  feeBps: number;
  ok: boolean;
  net?: string;
  fee?: string;
  priceAfter?: string;
  probAfter?: number;
  pot?: string;
  error?: string;
}
interface Case {
  probs: number[];
  seed: string;
  q0: string[];
  steps: Step[];
  qEnd: string[];
  potEnd: string;
  payoutRates: string[];
  voidRates: string[];
  prices: string[];
  probsEnd: number[];
}
const vectors: { isqrt: [string, string][]; cases: Case[] } = JSON.parse(
  readFileSync(new URL("./vectors.json", import.meta.url), "utf8"),
);

describe("BigInt math matches the Rust crate (golden vectors)", () => {
  it("isqrt", () => {
    for (const [n, root] of vectors.isqrt) expect(isqrt(BigInt(n))).toBe(BigInt(root));
  });

  it("has enough vectors to mean something", () => {
    const steps = vectors.cases.flatMap((c) => c.steps);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(10);
    expect(steps.length).toBeGreaterThanOrEqual(400);
    expect(steps.some((s) => !s.ok)).toBe(true);
  });

  vectors.cases.forEach((c, idx) => {
    it(`case ${idx}: ${c.probs.length} outcomes, seed ${c.seed}`, () => {
      let q = seedShares(c.probs, BigInt(c.seed));
      expect(q.map(String)).toEqual(c.q0);
      let pot = BigInt(c.seed);
      for (const s of c.steps) {
        if (s.kind === "sell") {
          const run = () =>
            quoteSell(q, pot, s.outcome, BigInt(s.shares!), s.feeBps, BigInt(s.seedFloor!));
          if (s.ok) {
            const quote = run();
            expect(String(quote.usdcOut)).toBe(s.usdcOut);
            expect(String(quote.gross)).toBe(s.gross);
            expect(String(quote.fee)).toBe(s.fee);
            expect(String(quote.priceAfterE6)).toBe(s.priceAfter);
            expect(quote.probAfterPpm).toBe(s.probAfter);
            expect(String(quote.potAfter)).toBe(s.pot);
            q = quote.qAfter;
            pot = quote.potAfter;
          } else {
            let code: string | undefined;
            try {
              run();
            } catch (e) {
              code = (e as MathError).code;
            }
            expect(code).toBe(s.error);
          }
          continue;
        }
        if (s.ok) {
          const quote = quoteBuy(q, pot, s.outcome, BigInt(s.usdcIn!), s.feeBps);
          expect(String(quote.shares)).toBe(s.shares);
          expect(String(quote.net)).toBe(s.net);
          expect(String(quote.fee)).toBe(s.fee);
          expect(String(quote.priceAfterE6)).toBe(s.priceAfter);
          expect(quote.probAfterPpm).toBe(s.probAfter);
          expect(String(quote.potAfter)).toBe(s.pot);
          q = quote.qAfter;
          pot = quote.potAfter;
        } else {
          let code: string | undefined;
          try {
            quoteBuy(q, pot, s.outcome, BigInt(s.usdcIn!), s.feeBps);
          } catch (e) {
            code = (e as MathError).code;
          }
          expect(code).toBe(s.error);
        }
      }
      expect(q.map(String)).toEqual(c.qEnd);
      expect(String(pot)).toBe(c.potEnd);
      expect(q.map((qi) => String(payoutRateE12(pot, qi)))).toEqual(c.payoutRates);
      expect(voidRatesE12(q).map(String)).toEqual(c.voidRates);
      expect(q.map((_, i) => String(priceE6(q, i)))).toEqual(c.prices);
      expect(q.map((_, i) => probPpm(q, i))).toEqual(c.probsEnd);
      // The floor: whichever outcome wins, a share pays at least 1 USDC.
      for (const rate of c.payoutRates) expect(BigInt(rate) >= RATE_SCALE).toBe(true);
    });
  });
});
