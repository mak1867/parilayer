import { describe, expect, it } from "vitest";
import type { GeminiSource } from "../src/gemini/client";
import { CachedGemini } from "../src/gemini/cached";

function counting(fail = false) {
  const calls: string[] = [];
  const src: GeminiSource = {
    getEvent: async (t) => {
      calls.push(t);
      if (fail) throw new Error("down");
      return { event: { ticker: t } } as never;
    },
    listEvents: async () => ({ data: [], pagination: { total: 0 } }) as never,
    listCombos: async () => {
      calls.push("combos");
      return [];
    },
  };
  return { src, calls };
}

describe("CachedGemini", () => {
  it("shares one fetch per ticker and expires after the TTL", async () => {
    let now = 0;
    const { src, calls } = counting();
    const c = new CachedGemini(src, 60_000, () => now);
    await Promise.all([c.getEvent("A"), c.getEvent("A"), c.getEvent("B")]);
    expect(calls).toEqual(["A", "B"]);
    now = 59_000;
    await c.getEvent("A");
    expect(calls).toEqual(["A", "B"]);
    now = 61_000;
    await c.getEvent("A");
    expect(calls).toEqual(["A", "B", "A"]);
  });

  it("does not cache failures", async () => {
    const { src, calls } = counting(true);
    const c = new CachedGemini(src, 60_000, () => 0);
    await expect(c.getEvent("A")).rejects.toThrow();
    await expect(c.getEvent("A")).rejects.toThrow();
    expect(calls).toEqual(["A", "A"]);
  });
});
