import { PPM, validateProbs } from "@pmec/sdk";
import { describe, expect, it } from "vitest";
import {
  OTHER_LABEL,
  contractState,
  eventTickers,
  findCombo,
  midPrice,
  planMarkets,
  planPair,
  referenceFor,
  settlementDecision,
  type MarketSource,
} from "../src/mapping";
import { combosFixture, fixture, lookupOf, withContracts } from "./helpers";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("midPrice", () => {
  it("is the midpoint of best bid and ask", () => {
    expect(midPrice({ bestBid: "0.36", bestAsk: "0.37", lastTradePrice: "0.32" })).toBeCloseTo(0.365, 12);
  });
  it("with one side missing, uses the last trade but never outside the quoted side", () => {
    // Stale last trade above the only ask: capped at the ask.
    expect(midPrice({ bestAsk: "0.04", lastTradePrice: "0.09" })).toBeCloseTo(0.04, 12);
    expect(midPrice({ bestAsk: "0.04", lastTradePrice: "0.03" })).toBeCloseTo(0.03, 12);
    // Stale last trade below the only bid: raised to the bid.
    expect(midPrice({ bestBid: "0.82", lastTradePrice: "0.5" })).toBeCloseTo(0.82, 12);
  });
  it("with one side and no trade, takes the missing side at its bound", () => {
    expect(midPrice({ bestAsk: "0.04" })).toBeCloseTo(0.02, 12);
    expect(midPrice({ bestBid: "0.82" })).toBeCloseTo(0.91, 12);
  });
  it("falls back to the last trade when the book is empty", () => {
    expect(midPrice({ lastTradePrice: "0.2" })).toBe(0.2);
    expect(midPrice({ bestBid: null, bestAsk: null, lastTradePrice: "0.2" })).toBe(0.2);
  });
  it("returns null with nothing to go on, and ignores garbage", () => {
    expect(midPrice({})).toBeNull();
    expect(midPrice(null)).toBeNull();
    expect(midPrice({ bestBid: "abc", bestAsk: "1.7" })).toBeNull();
  });
});

describe("planMarkets: recorded Gemini events map to the right market kinds", () => {
  it("a nominee race (mutually exclusive, prices sum to ~1) becomes one multi-outcome market", () => {
    const event = fixture("REPNOM2028");
    const [plan, ...rest] = planMarkets({ kind: "multi", event: "REPNOM2028" }, event);
    expect(rest).toHaveLength(0);
    expect(plan!.kind).toBe("multi");
    expect(plan!.refs).toEqual(["REPNOM2028"]);
    expect(plan!.outcomes).toHaveLength(event.contracts.length);
    expect(plan!.outcomes).toContain("J.D. Vance");
    expect(plan!.outcomes).not.toContain(OTHER_LABEL);
    expect(() => validateProbs(plan!.probsPpm)).not.toThrow();
    expect(plan!.source).toMatchObject({ type: "multi", eventTicker: "REPNOM2028", hasOther: false });
    // Opening probabilities match Gemini's (normalized mids) within 0.5 points.
    plan!.probsPpm.forEach((p, i) => expect(Math.abs(p / PPM - plan!.geminiProbs[i]!)).toBeLessThan(0.005));
    // Vance: bid 0.36, ask 0.37 when recorded.
    const vance = plan!.outcomes.indexOf("J.D. Vance");
    expect(plan!.geminiProbs[vance]).toBeGreaterThan(0.3);
  });

  it("an event whose prices sum well under 1 needs an Other outcome", () => {
    const event = fixture("DEMNOM2028");
    const mids = event.contracts.map((c) => midPrice(c.prices) ?? 0);
    // Whether this recording needs Other depends on its prices; force the case.
    const thin = withContracts(event, (_c, i) => (i === 0 ? { prices: { bestBid: "0.01", bestAsk: "0.02" } } : {}));
    const thinSum = sum(thin.contracts.map((c) => midPrice(c.prices) ?? 0));
    expect(thinSum).toBeLessThan(sum(mids));
    if (thinSum < 0.85) {
      expect(() => planMarkets({ kind: "multi", event: "DEMNOM2028" }, thin)).toThrow(/addOther/);
    }
    const [plan] = planMarkets({ kind: "multi", event: "DEMNOM2028", addOther: true }, thin);
    expect(plan!.outcomes.at(-1)).toBe(OTHER_LABEL);
    expect(plan!.outcomes).toHaveLength(event.contracts.length + 1);
    expect(plan!.geminiProbs.at(-1)).toBeCloseTo(Math.max(0, 1 - thinSum), 9);
    expect(sum(plan!.probsPpm)).toBe(PPM);
    expect(plan!.source).toMatchObject({ hasOther: true });
  });

  it("refuses to treat non-exclusive categorical events as multi-outcome", () => {
    // "Who will leave the administration" (many can) and a BTC price ladder (many strikes settle YES).
    expect(() => planMarkets({ kind: "multi", event: "CABINET-26" }, fixture("CABINET-26"))).toThrow(
      /not mutually exclusive|over the 32 limit|already settled YES/,
    );
    expect(() => planMarkets({ kind: "multi", event: "BTC2611202200" }, fixture("BTC2611202200"))).toThrow(
      /not mutually exclusive/,
    );
  });

  it("refuses a 2-way event as multi and a binary event as multi", () => {
    expect(() => planMarkets({ kind: "multi", event: "SEN26AK" }, fixture("SEN26AK"))).toThrow(/binary market instead/);
    expect(() => planMarkets({ kind: "multi", event: "BTC05M2611170500" }, fixture("BTC05M2611170500"))).toThrow(
      /not categorical/,
    );
  });

  it("one contract becomes a binary market seeded at its mid", () => {
    const event = fixture("NBA-2611180030-NYK-TOR-M");
    const tor = event.contracts.find((c) => c.label === "Toronto")!;
    const [plan] = planMarkets({ kind: "binary", event: event.ticker, contract: tor.instrumentSymbol }, event);
    expect(plan!.kind).toBe("binary");
    expect(plan!.refs).toEqual([tor.instrumentSymbol]);
    expect(plan!.outcomes).toEqual(["No", "Yes"]);
    const yes = midPrice(tor.prices)!;
    expect(plan!.probsPpm[1]! / PPM).toBeCloseTo(yes, 5);
    expect(plan!.probsPpm[0]! + plan!.probsPpm[1]!).toBe(PPM);
    expect(plan!.title).toBe("New York vs Toronto: Toronto");
    expect(plan!.source).toEqual({ type: "binary", eventTicker: event.ticker, instrumentSymbol: tor.instrumentSymbol });
  });

  it("binary-all mirrors each tradable contract of a price ladder separately", () => {
    const event = fixture("BTC2611202200");
    const plans = planMarkets({ kind: "binary-all", event: event.ticker }, event);
    expect(plans.length).toBeGreaterThan(3);
    expect(plans.length).toBeLessThanOrEqual(event.contracts.length);
    for (const p of plans) {
      expect(p.kind).toBe("binary");
      expect(() => validateProbs(p.probsPpm)).not.toThrow();
    }
    expect(new Set(plans.map((p) => p.refs[0])).size).toBe(plans.length);
  });

  it("will not mirror a settled contract or an unknown one", () => {
    const settled = fixture("BTC05M2611170500");
    const symbol = settled.contracts[0]!.instrumentSymbol;
    expect(() => planMarkets({ kind: "binary", event: settled.ticker, contract: symbol }, settled)).toThrow(/not open/);
    expect(planMarkets({ kind: "binary-all", event: settled.ticker }, settled)).toEqual([]);
    expect(() => planMarkets({ kind: "binary", event: settled.ticker, contract: "GEMI-NOPE" }, settled)).toThrow(/no contract/);
    expect(() => planMarkets({ kind: "binary-all", event: "OTHER" }, settled)).toThrow(/expected event/);
  });
});

describe("planPair", () => {
  const evA = fixture("NBA-2611180030-NYK-TOR-M");
  const evB = fixture("NBA-2611180100-POR-MIN-M");
  const tor = evA.contracts.find((c) => c.label === "Toronto")!;
  const por = evB.contracts.find((c) => c.label === "Portland")!;

  it("seeds 4 joint outcomes from the product of the legs, in 2a + b order", () => {
    const plan = planPair({ event: evA, contract: tor }, { event: evB, contract: por });
    const pA = midPrice(tor.prices)!;
    const pB = midPrice(por.prices)!;
    expect(plan.kind).toBe("pair");
    expect(plan.outcomes).toEqual(["No / No", "No / Yes", "Yes / No", "Yes / Yes"]);
    // Legs are ordered by symbol: ...NYK-TOR-M-TOR sorts before ...POR-MIN-M-POR.
    expect(plan.refs).toEqual([tor.instrumentSymbol, por.instrumentSymbol]);
    expect(plan.geminiProbs[3]).toBeCloseTo(pA * pB, 12);
    expect(plan.geminiProbs[2]).toBeCloseTo(pA * (1 - pB), 12);
    expect(plan.geminiProbs[1]).toBeCloseTo((1 - pA) * pB, 12);
    expect(plan.geminiProbs[0]).toBeCloseTo((1 - pA) * (1 - pB), 12);
    expect(sum(plan.probsPpm)).toBe(PPM);
    expect(eventTickers(plan.source)).toEqual([evA.ticker, evB.ticker]);
  });

  it("gives the same pool whichever leg is named first", () => {
    const ab = planPair({ event: evA, contract: tor }, { event: evB, contract: por });
    const ba = planPair({ event: evB, contract: por }, { event: evA, contract: tor });
    expect(ba).toEqual(ab);
  });

  it("rejects the same contract twice and settled legs", () => {
    expect(() => planPair({ event: evA, contract: tor }, { event: evA, contract: tor })).toThrow(/two different/);
    const settled = fixture("BTC05M2611170500");
    expect(() => planPair({ event: evA, contract: tor }, { event: settled, contract: settled.contracts[0]! })).toThrow(
      /not an active contract/,
    );
  });
});

describe("referenceFor", () => {
  it("binary: [1 - yes, yes]", () => {
    const event = fixture("NBA-2611180030-NYK-TOR-M");
    const tor = event.contracts.find((c) => c.label === "Toronto")!;
    const ref = referenceFor(
      { type: "binary", eventTicker: event.ticker, instrumentSymbol: tor.instrumentSymbol },
      lookupOf(event),
    );
    const yes = midPrice(tor.prices)!;
    expect(ref.prices[1]).toBeCloseTo(yes, 12);
    expect(ref.prices[0]).toBeCloseTo(1 - yes, 12);
  });

  it("multi: raw mids per contract plus a normalized view", () => {
    const event = fixture("REPNOM2028");
    const [plan] = planMarkets({ kind: "multi", event: event.ticker }, event);
    const ref = referenceFor(plan!.source, lookupOf(event));
    expect(ref.prices).toHaveLength(plan!.outcomes.length);
    expect(sum(ref.normalized.map((x) => x ?? 0))).toBeCloseTo(1, 9);
    ref.normalized.forEach((p, i) => expect(p).toBeCloseTo(plan!.geminiProbs[i]!, 9));
  });

  it("returns nulls when Gemini data is missing", () => {
    const ref = referenceFor({ type: "binary", eventTicker: "X", instrumentSymbol: "Y" }, lookupOf());
    expect(ref.prices).toEqual([null, null]);
  });

  it("pair: product of the legs, and Gemini's combo price when a combo exists", () => {
    const evA = fixture("NBA-2611180030-NYK-TOR-M");
    const evB = fixture("NBA-2611180100-POR-MIN-M");
    const comboEvent = fixture("CMB-261119-88CB599152A4ABCE");
    const tor = evA.contracts.find((c) => c.label === "Toronto")!;
    const por = evB.contracts.find((c) => c.label === "Portland")!;
    const plan = planPair({ event: evA, contract: tor }, { event: evB, contract: por });
    const combos = combosFixture().combos;

    const found = findCombo(combos, por.instrumentSymbol, tor.instrumentSymbol);
    expect(found?.contract.eventTicker).toBe("CMB-261119-88CB599152A4ABCE");

    const ref = referenceFor(plan.source, lookupOf(evA, evB, comboEvent), combos);
    expect(ref.pair!.product).toHaveLength(4);
    expect(sum(ref.pair!.product!)).toBeCloseTo(1, 12);
    // Gemini's combo is "Toronto Yes + Portland Yes": joint outcome index 3.
    expect(ref.pair!.combo).toMatchObject({ eventTicker: "CMB-261119-88CB599152A4ABCE", outcomeIndex: 3 });
    expect(ref.pair!.combo!.price).toBeCloseTo(midPrice(comboEvent.contracts[0]!.prices)!, 12);
    // No combo for a pair Gemini has not listed.
    const nyk = evA.contracts.find((c) => c.label === "New York")!;
    const other = planPair({ event: evA, contract: nyk }, { event: evB, contract: por });
    expect(referenceFor(other.source, lookupOf(evA, evB), combos).pair!.combo).toBeNull();
  });
});

describe("settlementDecision", () => {
  it("reads the settled side from recorded settled events", () => {
    const up = fixture("BTC05M2611170500"); // settled YES
    const down = fixture("BTC05M2611170455"); // settled NO
    expect(contractState(up.contracts[0])).toBe("yes");
    expect(contractState(down.contracts[0])).toBe("no");
    const src = (e: typeof up): MarketSource => ({
      type: "binary",
      eventTicker: e.ticker,
      instrumentSymbol: e.contracts[0]!.instrumentSymbol,
    });
    expect(settlementDecision(src(up), lookupOf(up), "open")).toMatchObject({ action: "resolve", winner: 1 });
    expect(settlementDecision(src(down), lookupOf(down), "open")).toMatchObject({ action: "resolve", winner: 0 });
    // A halted market still resolves.
    expect(settlementDecision(src(up), lookupOf(up), "halted")).toMatchObject({ action: "resolve", winner: 1 });
  });

  it("answers 'none' once the market is settled on-chain, so it fires once", () => {
    const up = fixture("BTC05M2611170500");
    const src: MarketSource = { type: "binary", eventTicker: up.ticker, instrumentSymbol: up.contracts[0]!.instrumentSymbol };
    expect(settlementDecision(src, lookupOf(up), "resolved").action).toBe("none");
    expect(settlementDecision(src, lookupOf(up), "voided").action).toBe("none");
  });

  it("does nothing while Gemini is trading, halts when it closes, unhalts when it reopens", () => {
    const event = fixture("NBA-2611180030-NYK-TOR-M");
    const tor = event.contracts.find((c) => c.label === "Toronto")!;
    const src: MarketSource = { type: "binary", eventTicker: event.ticker, instrumentSymbol: tor.instrumentSymbol };
    expect(settlementDecision(src, lookupOf(event), "open").action).toBe("none");
    expect(settlementDecision(src, lookupOf(event), "halted").action).toBe("unhalt");
    const closed = withContracts(event, () => ({ marketState: "closed" }));
    expect(settlementDecision(src, lookupOf(closed), "open").action).toBe("halt");
    expect(settlementDecision(src, lookupOf(closed), "halted").action).toBe("none");
  });

  it("voids on Gemini's 'invalid' status or a settlement with no side", () => {
    const event = fixture("NBA-2611180030-NYK-TOR-M");
    const tor = event.contracts.find((c) => c.label === "Toronto")!;
    const src: MarketSource = { type: "binary", eventTicker: event.ticker, instrumentSymbol: tor.instrumentSymbol };
    const invalid = withContracts(event, () => ({ status: "invalid" }));
    expect(settlementDecision(src, lookupOf(invalid), "open").action).toBe("void");
    const sideless = withContracts(event, () => ({ status: "settled", marketState: "closed", resolutionSide: null }));
    expect(settlementDecision(src, lookupOf(sideless), "open").action).toBe("void");
  });

  it("warns instead of acting when data is missing", () => {
    const src: MarketSource = { type: "binary", eventTicker: "GONE", instrumentSymbol: "GEMI-GONE" };
    const d = settlementDecision(src, lookupOf(), "open");
    expect(d.action).toBe("none");
    expect(d).toHaveProperty("warning");
  });

  describe("multi-outcome", () => {
    const event = fixture("REPNOM2028");
    const [plan] = planMarkets({ kind: "multi", event: event.ticker }, event);
    const src = plan!.source;
    const settleAll = (winner: number | null) =>
      withContracts(event, (_c, i) => ({
        status: "settled",
        marketState: "closed",
        resolutionSide: i === winner ? "yes" : "no",
      }));

    it("the contract that settled YES wins", () => {
      expect(settlementDecision(src, lookupOf(settleAll(4)), "open")).toMatchObject({ action: "resolve", winner: 4 });
      // Even before the others are marked settled.
      const early = withContracts(event, (_c, i) => (i === 2 ? { status: "settled", marketState: "closed", resolutionSide: "yes" } : {}));
      expect(settlementDecision(src, lookupOf(early), "open")).toMatchObject({ action: "resolve", winner: 2 });
    });

    it("an early NO on one candidate does not resolve or halt the market", () => {
      const dropout = withContracts(event, (_c, i) => (i === 5 ? { status: "settled", marketState: "closed", resolutionSide: "no" } : {}));
      expect(settlementDecision(src, lookupOf(dropout), "open").action).toBe("none");
    });

    it("no YES at all: Other wins if there is one, otherwise void", () => {
      expect(settlementDecision(src, lookupOf(settleAll(null)), "open").action).toBe("void");
      const withOther: MarketSource = { ...src, hasOther: true } as MarketSource;
      expect(settlementDecision(withOther, lookupOf(settleAll(null)), "open")).toMatchObject({
        action: "resolve",
        winner: event.contracts.length,
      });
    });

    it("refuses to pick a winner when several contracts settled YES", () => {
      // A recorded BTC ladder: 10 of 12 strikes settled YES.
      const ladder = fixture("BTC2611170500");
      const ladderSrc: MarketSource = {
        type: "multi",
        eventTicker: ladder.ticker,
        contracts: ladder.contracts.map((c) => c.instrumentSymbol),
        hasOther: false,
      };
      const d = settlementDecision(ladderSrc, lookupOf(ladder), "open");
      expect(d.action).toBe("none");
      expect(d).toHaveProperty("warning");
    });

    it("halts when the whole event stops trading", () => {
      const closed = withContracts(event, () => ({ marketState: "closed" }));
      expect(settlementDecision(src, lookupOf(closed), "open").action).toBe("halt");
      expect(settlementDecision(src, lookupOf({ ...event, status: "under_review" }), "open").action).toBe("halt");
      expect(settlementDecision(src, lookupOf({ ...event, status: "invalid" }), "open").action).toBe("void");
    });
  });

  describe("pair", () => {
    const evA = fixture("NBA-2611180030-NYK-TOR-M");
    const evB = fixture("NBA-2611180100-POR-MIN-M");
    const tor = evA.contracts.find((c) => c.label === "Toronto")!;
    const por = evB.contracts.find((c) => c.label === "Portland")!;
    const src = planPair({ event: evA, contract: tor }, { event: evB, contract: por }).source;
    const settle = (event: typeof evA, symbol: string, side: "yes" | "no" | null) =>
      withContracts(event, (c) =>
        c.instrumentSymbol === symbol ? { status: "settled", marketState: "closed", resolutionSide: side } : {},
      );

    it("winner index = 2a + b once both legs settle", () => {
      const cases: ["yes" | "no", "yes" | "no", number][] = [
        ["no", "no", 0],
        ["no", "yes", 1],
        ["yes", "no", 2],
        ["yes", "yes", 3],
      ];
      for (const [a, b, winner] of cases) {
        const lookup = lookupOf(settle(evA, tor.instrumentSymbol, a), settle(evB, por.instrumentSymbol, b));
        expect(settlementDecision(src, lookup, "halted")).toMatchObject({ action: "resolve", winner });
      }
    });

    it("halts while only one leg has settled, and voids if either leg is voided", () => {
      const oneDown = lookupOf(settle(evA, tor.instrumentSymbol, "yes"), evB);
      expect(settlementDecision(src, oneDown, "open").action).toBe("halt");
      expect(settlementDecision(src, oneDown, "halted").action).toBe("none");
      const voided = lookupOf(settle(evA, tor.instrumentSymbol, null), evB);
      expect(settlementDecision(src, voided, "open").action).toBe("void");
      expect(settlementDecision(src, lookupOf(evA, evB), "open").action).toBe("none");
      expect(settlementDecision(src, lookupOf(evA), "open")).toHaveProperty("warning");
    });
  });
});
