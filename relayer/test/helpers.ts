import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeminiCombosPage, GeminiEvent } from "../src/gemini/types";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** A recorded GET /events/{ticker} response. */
export function fixture(ticker: string): GeminiEvent {
  return JSON.parse(readFileSync(join(FIXTURES, "events", `${ticker}.json`), "utf8")) as GeminiEvent;
}

export function combosFixture(): GeminiCombosPage {
  return JSON.parse(readFileSync(join(FIXTURES, "combos.json"), "utf8")) as GeminiCombosPage;
}

export function lookupOf(...events: GeminiEvent[]) {
  const map = new Map(events.map((e) => [e.ticker, e]));
  return (ticker: string) => map.get(ticker);
}

/** A deep copy with some contracts changed, to simulate Gemini moving on. */
export function withContracts(event: GeminiEvent, patch: (c: GeminiEvent["contracts"][number], i: number) => object): GeminiEvent {
  const copy = structuredClone(event);
  copy.contracts = copy.contracts.map((c, i) => ({ ...c, ...patch(c, i) }));
  return copy;
}
