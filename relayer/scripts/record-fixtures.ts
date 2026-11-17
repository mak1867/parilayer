/**
 * Records real Gemini responses as test fixtures.
 *
 *   npm run record-fixtures -w relayer -- REPNOM2028 DEMNOM2028 ...
 *
 * Each event is saved to fixtures/events/<TICKER>.json exactly as Gemini sent
 * it, minus bulky fields the relayer never reads (rich-text descriptions,
 * images, price history, participants, nested sub-events, an event's related-combos list). The list of removed
 * keys is below so the trimming is reproducible and auditable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_BASE } from "../src/gemini/client";

const DROP = new Set([
  "description",
  "priceHistory",
  "imageUrl",
  "socialImageUrl",
  "featuredImageUrl",
  "participants",
  "template",
  "events",
  "termsLink",
  "termsAndConditionsUrl",
  "color",
  "eventTags",
  "target",
]);

function trim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trim);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !DROP.has(k))
        .map(([k, v]) => [k, trim(v)]),
    );
  }
  return value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = join(import.meta.dirname, "..", "fixtures");
mkdirSync(join(out, "events"), { recursive: true });

async function get(path: string): Promise<unknown> {
  const res = await fetch(GEMINI_BASE + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  await sleep(1100);
  return res.json();
}

const args = process.argv.slice(2);
const wantCombos = args.includes("--combos");
const wantSettled = args.includes("--settled");
const tickers = args.filter((a) => !a.startsWith("--"));

for (const ticker of tickers) {
  const full = (await get(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`)) as Record<string, unknown>;
  delete full.combos; // an event's own list of related combos; recorded separately below
  const ev = trim(full);
  writeFileSync(join(out, "events", `${ticker}.json`), JSON.stringify(ev, null, 1) + "\n");
  console.log(`recorded ${ticker}`);
}
if (wantCombos) {
  const combos = trim(await get(`/v1/prediction-markets/combos?limit=100`));
  writeFileSync(join(out, "combos.json"), JSON.stringify(combos, null, 1) + "\n");
  console.log("recorded combos");
}
if (wantSettled) {
  const settled = trim(await get(`/v1/prediction-markets/events/recently-settled?limit=25`));
  writeFileSync(join(out, "recently-settled.json"), JSON.stringify(settled, null, 1) + "\n");
  console.log("recorded recently-settled");
}
writeFileSync(
  join(out, "RECORDED.md"),
  `# Gemini fixtures\n\nReal responses from ${GEMINI_BASE}, recorded with \`scripts/record-fixtures.ts\`.\n` +
    `Last run: ${new Date().toISOString()}.\n\nKeys removed from every object (never read by the relayer): ${[...DROP].join(", ")}.\n`,
);
