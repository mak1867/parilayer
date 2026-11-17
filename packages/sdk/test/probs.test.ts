import { describe, expect, it } from "vitest";
import { MAX_PROB_PPM, MIN_PROB_PPM, PPM, clampNormalize, fromHex, marketIdFromRefs, pairWeights, toHex, validateProbs } from "../src";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("clampNormalize", () => {
  it("keeps an already-normal binary price", () => {
    expect(clampNormalize([0.38, 0.62])).toEqual([380_000, 620_000]);
  });

  it("normalizes mids that do not sum to 1", () => {
    const p = clampNormalize([0.3, 0.3, 0.3]);
    expect(sum(p)).toBe(PPM);
    expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1);
  });

  it("clamps extremes to 0.5% / 99.5%", () => {
    expect(clampNormalize([0.999, 0.001])).toEqual([MAX_PROB_PPM, MIN_PROB_PPM]);
    expect(clampNormalize([0, 1])).toEqual([MIN_PROB_PPM, MAX_PROB_PPM]);
  });

  it("falls back to uniform with no information", () => {
    expect(clampNormalize([0, 0, 0, 0])).toEqual([250_000, 250_000, 250_000, 250_000]);
  });

  it("water-fills a long tail without breaking the floor", () => {
    // One favourite and many near-zero outcomes, like a nominee race.
    const weights = [0.365, 0.165, 0.155, 0.045, 0.02, 0.015, 0.015, 0.01, 0.01, 0.01, 0.015, 0.015, 0.01, 0.001, 0.0005];
    const p = clampNormalize(weights);
    expect(sum(p)).toBe(PPM);
    expect(() => validateProbs(p)).not.toThrow();
    expect(p[13]).toBe(MIN_PROB_PPM);
    expect(p[14]).toBe(MIN_PROB_PPM);
    // The favourite stays within 0.5 points of its normalized Gemini probability.
    const normalized = weights[0]! / sum(weights);
    expect(Math.abs(p[0]! / PPM - normalized)).toBeLessThan(0.005);
  });

  it("always returns valid probabilities", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let t = 0; t < 2000; t++) {
      const n = 2 + Math.floor(rand() * 31);
      const w = Array.from({ length: n }, () => (rand() < 0.3 ? 0 : rand() ** 4));
      const p = clampNormalize(w);
      expect(sum(p)).toBe(PPM);
      expect(() => validateProbs(p)).not.toThrow();
    }
  });

  it("rejects bad input", () => {
    expect(() => clampNormalize([1])).toThrow();
    expect(() => clampNormalize([0.5, -0.1])).toThrow();
    expect(() => clampNormalize([0.5, Number.NaN])).toThrow();
    expect(() => clampNormalize(new Array(33).fill(1))).toThrow();
  });
});

describe("pairWeights", () => {
  it("orders outcomes as 2a + b: NN, NY, YN, YY", () => {
    const w = pairWeights(0.6, 0.3);
    expect(w.map((x) => Math.round(x * 100))).toEqual([28, 12, 42, 18]);
    expect(sum(w)).toBeCloseTo(1, 12);
  });
});

describe("marketIdFromRefs", () => {
  it("does not depend on leg order", () => {
    const a = marketIdFromRefs(["GEMI-A", "GEMI-B"]);
    const b = marketIdFromRefs(["GEMI-B", "GEMI-A"]);
    expect(toHex(a)).toBe(toHex(b));
    expect(a.length).toBe(32);
  });

  it("differs for different refs and is a real sha256", () => {
    expect(toHex(marketIdFromRefs(["GEMI-A"]))).not.toBe(toHex(marketIdFromRefs(["GEMI-B"])));
    // sha256("abc")
    expect(toHex(marketIdFromRefs(["abc"]))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("round-trips hex and rejects bad refs", () => {
    const id = marketIdFromRefs(["GEMI-A"]);
    expect(fromHex(toHex(id))).toEqual(id);
    expect(() => marketIdFromRefs([])).toThrow();
    expect(() => marketIdFromRefs(["a|b"])).toThrow();
  });
});
