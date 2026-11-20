import { PPM, UNIT, marketIdFromRefs, probPpm, toHex } from "@parilayer/sdk";
import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { GeminiMock } from "../src/gemini/client";
import type { MirrorEntry } from "../src/mapping";
import { Relayer } from "../src/relayer";
import { buildServer } from "../src/server";
import { AuditLog, Store, sha256Hex } from "../src/store";
import { FakeChain } from "./fakeChain";
import { FIXTURES, fixture, withContracts } from "./helpers";

const NBA = "NBA-2611180030-NYK-TOR-M";
const TOR = "GEMI-NBA-2611180030-NYK-TOR-M-TOR";
const torId = toHex(marketIdFromRefs([TOR]));

function setup() {
  const gemini = new GeminiMock(FIXTURES);
  const chain = new FakeChain();
  const store = new Store(":memory:");
  const audit = new AuditLog(null);
  const logs: string[] = [];
  const relayer = new Relayer({ gemini, chain, store, audit, seedUsdc: 500, log: (m) => logs.push(m) });
  return { gemini, chain, store, audit, relayer, logs };
}

const demo: MirrorEntry[] = [
  { kind: "multi", event: "REPNOM2028" },
  { kind: "binary", event: NBA, contract: TOR },
  { kind: "binary-all", event: "SEN26AK" },
];

describe("mock mode", () => {
  it("serves recorded events and lists them offline", async () => {
    const gemini = new GeminiMock(FIXTURES);
    expect((await gemini.getEvent("REPNOM2028"))?.event.title).toMatch(/Republican Nominee/);
    expect(await gemini.getEvent("NOPE")).toBeNull();
    const politics = await gemini.listEvents({ status: "active", category: "politics" });
    expect(politics.data.map((e) => e.ticker)).toContain("REPNOM2028");
    expect((await gemini.listCombos()).length).toBeGreaterThan(10);
  });
});

describe("mirror", () => {
  it("creates the right market kinds, seeded within 0.5 points of Gemini", async () => {
    const { relayer, chain, store } = setup();
    const { results, errors } = await relayer.mirror(demo);
    expect(errors).toEqual([]);
    expect(results.map((r) => r.plan.kind)).toEqual(["multi", "binary", "binary", "binary"]);
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect(chain.markets.size).toBe(4);
    expect(chain.treasury).toBe((100_000n - 4n * 500n) * UNIT);

    for (const r of results) {
      const m = chain.markets.get(r.idHex)!;
      const meta = store.getMarket(r.idHex)!;
      expect(meta.outcomes).toHaveLength(m.n);
      expect(meta.address).toBe(m.address.toBase58());
      // Opening pool probabilities must match Gemini within 0.5 points.
      r.plan.geminiProbs.forEach((g, i) => {
        expect(Math.abs(probPpm(m.q, i) / PPM - g)).toBeLessThan(0.005);
      });
    }
  });

  it("is idempotent: mirroring again creates nothing and spends nothing", async () => {
    const { relayer, chain } = setup();
    await relayer.mirror(demo);
    const treasury = chain.treasury;
    const again = await relayer.mirror(demo);
    expect(again.results.every((r) => r.status === "exists")).toBe(true);
    expect(chain.count("create")).toBe(4);
    expect(chain.treasury).toBe(treasury);
  });

  it("re-attaches metadata to a market that exists on-chain but is unknown locally", async () => {
    const { relayer, chain, gemini } = setup();
    await relayer.mirror([demo[1]!]);
    // A fresh local database, same chain.
    const store2 = new Store(":memory:");
    const relayer2 = new Relayer({ gemini, chain, store: store2, audit: new AuditLog(null), seedUsdc: 500 });
    const { results } = await relayer2.mirror([demo[1]!]);
    expect(results[0]!.status).toBe("exists");
    expect(store2.getMarket(torId)?.title).toBe("New York vs Toronto: Toronto");
    expect(chain.count("create")).toBe(1);
  });

  it("fails cleanly when the treasury cannot cover the seed", async () => {
    const { relayer, chain, store } = setup();
    chain.treasury = 499n * UNIT;
    const { results, errors } = await relayer.mirror([demo[1]!]);
    expect(results).toEqual([]);
    expect(errors[0]).toMatch(/cannot cover/);
    expect(chain.markets.size).toBe(0);
    expect(store.listMarkets()).toEqual([]);
  });

  it("reports bad entries without stopping the rest", async () => {
    const { relayer, chain } = setup();
    const { results, errors } = await relayer.mirror([
      { kind: "multi", event: "CABINET-26" },
      { kind: "binary-all", event: "DOES-NOT-EXIST" },
      demo[1]!,
    ]);
    expect(errors).toHaveLength(2);
    expect(results).toHaveLength(1);
    expect(chain.markets.size).toBe(1);
  });
});

describe("reference prices", () => {
  it("serves Gemini's price per outcome after a refresh", async () => {
    const { relayer } = setup();
    await relayer.mirror([demo[1]!]);
    await relayer.refresh();
    const ref = relayer.reference(torId)!;
    // Toronto: bid 0.42, ask 0.43 when recorded.
    expect(ref.prices[1]).toBeCloseTo(0.425, 9);
    expect(ref.prices[0]).toBeCloseTo(0.575, 9);
    expect(ref.asOf).toBeGreaterThan(0);
    expect(relayer.reference("00".repeat(32))).toBeNull();
  });

  it("follows Gemini when the price moves", async () => {
    const { relayer, gemini } = setup();
    await relayer.mirror([demo[1]!]);
    gemini.override(withContracts(fixture(NBA), (c) => (c.instrumentSymbol === TOR ? { prices: { bestBid: "0.60", bestAsk: "0.62" } } : {})));
    await relayer.refresh();
    expect(relayer.reference(torId)!.prices[1]).toBeCloseTo(0.61, 9);
  });
});

describe("settlement watcher", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await ctx.relayer.mirror([demo[1]!]);
    await ctx.relayer.refresh();
  });

  it("does nothing while Gemini is trading", async () => {
    expect(await ctx.relayer.settleOnce()).toEqual([]);
    expect(ctx.chain.count("resolve")).toBe(0);
  });

  it("fires exactly once when Gemini settles, and logs the response with its hash", async () => {
    const { relayer, gemini, chain, audit } = ctx;
    gemini.settle(NBA, TOR, "yes");
    await relayer.refresh();

    const first = await relayer.settleOnce();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ idHex: torId, decision: { action: "resolve", winner: 1 } });
    expect(chain.markets.get(torId)!.status).toBe("resolved");

    // Polling again (and again) posts nothing more.
    await relayer.refresh();
    expect(await relayer.settleOnce()).toEqual([]);
    expect(await relayer.settleOnce()).toEqual([]);
    expect(chain.count("resolve")).toBe(1);

    // Audit: the Gemini body that justified it, and its SHA-256.
    const entry = audit.entries.find((e) => e.action === "resolve")!;
    expect(entry).toMatchObject({ marketId: torId, winner: 1 });
    expect(entry.tx).toHaveLength(1);
    expect(entry.gemini[0]!.ticker).toBe(NBA);
    expect(entry.gemini[0]!.sha256).toBe(sha256Hex(entry.gemini[0]!.body));
    expect(JSON.parse(entry.gemini[0]!.body).contracts.find((c: { instrumentSymbol: string }) => c.instrumentSymbol === TOR).resolutionSide).toBe("yes");

    // The treasury's winning seed shares were redeemed, once.
    expect(chain.calls.filter((c) => c.action === "redeemSeed")).toEqual([{ action: "redeemSeed", market: torId, outcome: 1 }]);
  });

  it("does not re-post after a restart with a fresh process but the same store", async () => {
    const { relayer, gemini, chain, store } = ctx;
    gemini.settle(NBA, TOR, "no");
    await relayer.refresh();
    await relayer.settleOnce();
    const restarted = new Relayer({ gemini, chain, store, audit: new AuditLog(null), seedUsdc: 500 });
    await restarted.refresh();
    expect(await restarted.settleOnce()).toEqual([]);
    expect(chain.count("resolve")).toBe(1);
    expect(chain.markets.get(torId)!.winner).toBe(0);
  });

  it("retries after a failed transaction and still posts only once", async () => {
    const { relayer, gemini, chain } = ctx;
    gemini.settle(NBA, TOR, "yes");
    await relayer.refresh();
    chain.failNext = 1;
    const failed = await relayer.settleOnce();
    expect(failed[0]!.error).toMatch(/simulated/);
    expect(chain.markets.get(torId)!.status).toBe("open");
    const retried = await relayer.settleOnce();
    expect(retried[0]!.tx).toBeDefined();
    expect(await relayer.settleOnce()).toEqual([]);
    expect(chain.count("resolve")).toBe(1);
  });

  it("notices a market someone else already settled on-chain", async () => {
    const { relayer, gemini, chain } = ctx;
    chain.markets.get(torId)!.status = "resolved";
    chain.markets.get(torId)!.winner = 1;
    gemini.settle(NBA, TOR, "yes");
    await relayer.refresh();
    expect(await relayer.settleOnce()).toEqual([]);
    expect(chain.count("resolve")).toBe(0);
    expect(chain.count("redeemSeed")).toBe(1);
  });

  it("mirrors a Gemini halt and its lifting", async () => {
    const { relayer, gemini, chain } = ctx;
    gemini.override(withContracts(fixture(NBA), () => ({ marketState: "closed" })));
    await relayer.refresh();
    expect((await relayer.settleOnce())[0]!.decision.action).toBe("halt");
    expect(chain.markets.get(torId)!.status).toBe("halted");
    expect(await relayer.settleOnce()).toEqual([]);
    gemini.override(fixture(NBA));
    await relayer.refresh();
    expect((await relayer.settleOnce())[0]!.decision.action).toBe("unhalt");
    expect(chain.markets.get(torId)!.status).toBe("open");
  });

  it("voids when Gemini voids, and redeems every outcome's seed shares", async () => {
    const { relayer, gemini, chain } = ctx;
    gemini.override(withContracts(fixture(NBA), () => ({ status: "invalid" })));
    await relayer.refresh();
    expect((await relayer.settleOnce())[0]!.decision.action).toBe("void");
    expect(chain.markets.get(torId)!.status).toBe("voided");
    expect(chain.count("redeemSeed")).toBe(2);
    expect(await relayer.settleOnce()).toEqual([]);
    expect(chain.count("void")).toBe(1);
  });
});

describe("HTTP API", () => {
  async function server() {
    const ctx = setup();
    await ctx.relayer.mirror(demo);
    await ctx.relayer.refresh();
    const drips: string[] = [];
    const app = await buildServer({
      relayer: ctx.relayer,
      store: ctx.store,
      chain: ctx.chain,
      rpcUrl: "http://127.0.0.1:8899",
      seedUsdc: 500,
      faucet: {
        usdc: 1000,
        cooldownMs: 60_000,
        drip: async (w) => {
          drips.push(w.toBase58());
          return { signature: "faucetsig", sol: 0 };
        },
      },
      mock: ctx.gemini,
    });
    return { ...ctx, app, drips };
  }

  it("GET /health, /config, /markets", async () => {
    const { app } = await server();
    expect((await app.inject("/health")).json()).toMatchObject({ ok: true, mock: true, markets: 4 });
    expect((await app.inject("/config")).json()).toMatchObject({ poolFeeBps: 100, sellFeeBps: 50, seedUsdc: 500 });
    const markets = (await app.inject("/markets")).json() as { title: string; reference: { prices: number[] } }[];
    expect(markets).toHaveLength(4);
    // Markets created in the same millisecond have no fixed order; look it up.
    const nominee = markets.find((m) => /Republican Nominee/.test(m.title));
    expect(nominee).toBeDefined();
    expect(nominee!.reference.prices.length).toBeGreaterThan(3);
  });

  it("GET /reference/:id returns Gemini's price per outcome", async () => {
    const { app } = await server();
    const res = await app.inject(`/reference/${torId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcomes: { label: string; gemini: number }[] };
    expect(body.outcomes.map((o) => o.label)).toEqual(["No", "Yes"]);
    expect(body.outcomes[1]!.gemini).toBeCloseTo(0.425, 9);
    expect((await app.inject(`/reference/${"ab".repeat(32)}`)).statusCode).toBe(404);
    expect((await app.inject("/reference/not-hex")).statusCode).toBe(404);
    expect((await app.inject(`/markets/${torId}`)).json()).toMatchObject({ kind: "binary" });
  });

  it("POST /faucet validates the wallet and enforces the cooldown", async () => {
    const { app, drips } = await server();
    const wallet = Keypair.generate().publicKey.toBase58();
    expect((await app.inject({ method: "POST", url: "/faucet", payload: { wallet: "nope" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/faucet", payload: { wallet } });
    expect(ok.json()).toMatchObject({ signature: "faucetsig", usdc: 1000 });
    expect((await app.inject({ method: "POST", url: "/faucet", payload: { wallet } })).statusCode).toBe(429);
    expect(drips).toEqual([wallet]);
  });

  it("POST /mock/settle simulates a Gemini settlement end to end", async () => {
    const { app, chain } = await server();
    const res = await app.inject({ method: "POST", url: "/mock/settle", payload: { ticker: NBA, instrumentSymbol: TOR, side: "yes" } });
    expect(res.statusCode).toBe(200);
    expect(chain.markets.get(torId)!.status).toBe("resolved");
    expect((await app.inject({ method: "POST", url: "/mock/settle", payload: { ticker: NBA } })).statusCode).toBe(400);
  });
});
