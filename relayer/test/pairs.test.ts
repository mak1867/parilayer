import { PPM, UNIT, marketIdFromRefs, probPpm, toHex } from "@pmec/sdk";
import { Keypair, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { GeminiMock } from "../src/gemini/client";
import { midPrice } from "../src/mapping";
import { PairError, PairService, legChoices } from "../src/pairs";
import { Relayer } from "../src/relayer";
import { buildServer } from "../src/server";
import { AuditLog, Store } from "../src/store";
import { FakeChain } from "./fakeChain";
import { FIXTURES, fixture, withContracts } from "./helpers";

const TOR = { event: "NBA-2611180030-NYK-TOR-M", contract: "GEMI-NBA-2611180030-NYK-TOR-M-TOR" };
const POR = { event: "NBA-2611180100-POR-MIN-M", contract: "GEMI-NBA-2611180100-POR-MIN-M-POR" };
const OVER = { event: "NBA-2611180030-NYK-TOR-T", contract: "GEMI-NBA-2611180030-NYK-TOR-T-O216" };
const pairId = toHex(marketIdFromRefs([TOR.contract, POR.contract]));

function setup() {
  const gemini = new GeminiMock(FIXTURES);
  const chain = new FakeChain();
  const store = new Store(":memory:");
  const audit = new AuditLog(null);
  const relayer = new Relayer({ gemini, chain, store, audit, seedUsdc: 500 });
  const clock = { now: Date.now() };
  const pairs = new PairService({ relayer, gemini, chain, store, seedUsdc: 500, now: () => clock.now });
  const buyer = Keypair.generate();
  chain.usdc.set(buyer.publicKey.toBase58(), 1_000n * UNIT);
  const sign = (txBase64: string, kp = buyer) => {
    const tx = Transaction.from(Buffer.from(txBase64, "base64"));
    tx.partialSign(kp);
    return tx.serialize().toString("base64");
  };
  return { gemini, chain, store, audit, relayer, pairs, buyer, sign, clock };
}

const usdc = (n: number) => (BigInt(n) * UNIT).toString();
async function rejects(p: Promise<unknown>, status: number, pattern: RegExp) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof PairError && e.status === status && pattern.test(e.message));
}

describe("pair pools", () => {
  it("previews 4 joint outcomes seeded at the product of the legs, with Gemini's combo price", async () => {
    const { pairs } = setup();
    const p = await pairs.preview(POR, TOR); // order does not matter
    const pT = midPrice(fixture(TOR.event).contracts.find((c) => c.instrumentSymbol === TOR.contract)!.prices)!;
    const pP = midPrice(fixture(POR.event).contracts.find((c) => c.instrumentSymbol === POR.contract)!.prices)!;
    expect(p.idHex).toBe(pairId);
    expect(p.exists).toBe(false);
    expect(p.outcomes).toEqual(["No / No", "No / Yes", "Yes / No", "Yes / Yes"]);
    expect(p.legs.map((l) => l.instrumentSymbol)).toEqual([TOR.contract, POR.contract]);
    // legRefs follow the pool's leg order, not the order the caller passed, so the UI can rebuild each leg.
    expect(p.legRefs).toEqual([TOR, POR]);
    expect(p.probsPpm[3]! / PPM).toBeCloseTo(pT * pP, 5);
    expect(p.probsPpm.reduce((a, b) => a + b, 0)).toBe(PPM);
    // Gemini's own "Toronto Yes + Portland Yes" combo, read from the combo's event.
    expect(p.combo).toMatchObject({ outcomeIndex: 3, eventTicker: "CMB-261119-88CB599152A4ABCE" });
    expect(p.combo!.price).toBeCloseTo(midPrice(fixture("CMB-261119-88CB599152A4ABCE").contracts[0]!.prices)!, 9);
    // A same-game pair Gemini has no combo for.
    expect((await pairs.preview(TOR, OVER)).combo).toBeNull();
  });

  it("creates the pool only once a signed first buy arrives, then submits that buy", async () => {
    const { pairs, chain, store, buyer, sign, audit } = setup();
    const prep = await pairs.prepare(TOR, POR, buyer.publicKey.toBase58(), 3, usdc(25));
    expect(chain.markets.size).toBe(0); // nothing exists yet
    expect(BigInt(prep.shares)).toBeGreaterThan(25n * UNIT); // priced under 1 USDC a share
    expect(BigInt(prep.minSharesOut)).toBeLessThan(BigInt(prep.shares));

    const out = await pairs.create(prep.prepareId, sign(prep.tx));
    expect(out).toMatchObject({ idHex: pairId, buySignature: expect.any(String), buyError: null });
    const m = chain.markets.get(pairId)!;
    expect(m.kind).toBe("pair");
    expect(m.n).toBe(4);
    expect(m.refs).toEqual([TOR.contract, POR.contract]);
    for (let i = 0; i < 4; i++) expect(Math.abs(probPpm(m.q, i) - prep.probsPpm[i]!)).toBeLessThan(1000);
    expect(chain.treasury).toBe((100_000n - 500n) * UNIT);
    expect(chain.submitted).toHaveLength(1);
    // The transaction submitted is the one the buyer signed: a buy on the new pool.
    const sent = Transaction.from(Buffer.from(chain.submitted[0]!));
    expect(sent.feePayer!.equals(buyer.publicKey)).toBe(true);
    expect(sent.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(m.address)))).toBe(true);

    const meta = store.getMarket(pairId)!;
    expect(meta).toMatchObject({ kind: "pair", creator: buyer.publicKey.toBase58() });
    expect(meta.source).toMatchObject({ type: "pair" });
    expect(store.pairCreationsSince(0)).toBe(1);
    expect(audit.entries.at(-1)).toMatchObject({ action: "create", marketId: pairId });

    // Once it exists it cannot be created again, in either leg order.
    expect((await pairs.preview(TOR, POR)).exists).toBe(true);
    await rejects(pairs.prepare(POR, TOR, buyer.publicKey.toBase58(), 0, usdc(25)), 409, /already has a pool/);
    await rejects(pairs.create(prep.prepareId, sign(prep.tx)), 410, /expired/);
  });

  it("requires a first buy of at least 25 USDC that the wallet can afford", async () => {
    const { pairs, chain, buyer } = setup();
    const b = buyer.publicKey.toBase58();
    await rejects(pairs.prepare(TOR, POR, b, 3, usdc(24)), 400, /at least 25 USDC/);
    chain.usdc.set(b, 10n * UNIT);
    await rejects(pairs.prepare(TOR, POR, b, 3, usdc(25)), 400, /enough USDC/);
    await rejects(pairs.prepare(TOR, POR, "not-a-key", 3, usdc(25)), 400, /Solana address/);
    await rejects(pairs.prepare(TOR, POR, b, 4, usdc(25)), 400, /outcome/);
    await rejects(pairs.prepare(TOR, POR, b, 3, "25.5"), 400, /base units/);
    expect(chain.markets.size).toBe(0);
  });

  it("caps new pairs at 20 a day and frees up again a day later", async () => {
    const { pairs, store, buyer, clock } = setup();
    for (let i = 0; i < 20; i++) store.recordPairCreation(`id${i}`, "someone", clock.now - 60_000 * i);
    await rejects(pairs.prepare(TOR, POR, buyer.publicKey.toBase58(), 3, usdc(25)), 429, /capped at 20/);
    clock.now += 24 * 60 * 60 * 1000;
    await expect(pairs.prepare(TOR, POR, buyer.publicKey.toBase58(), 3, usdc(25))).resolves.toMatchObject({ idHex: pairId });
  });

  it("fails if the treasury cannot cover the seed", async () => {
    const { pairs, chain, buyer } = setup();
    chain.treasury = 499n * UNIT;
    await rejects(pairs.prepare(TOR, POR, buyer.publicKey.toBase58(), 3, usdc(25)), 503, /treasury cannot cover/);
  });

  it("only accepts legs that are different, known and actively trading", async () => {
    const { pairs, gemini, buyer } = setup();
    const b = buyer.publicKey.toBase58();
    await rejects(pairs.preview(TOR, TOR), 400, /two different/);
    await rejects(pairs.preview(TOR, { event: "NOPE", contract: "GEMI-NOPE" }), 404, /does not know/);
    await rejects(pairs.preview(TOR, { event: POR.event, contract: "GEMI-NOPE" }), 404, /not in its event/);
    gemini.settle(POR.event, POR.contract, "yes");
    await rejects(pairs.prepare(TOR, POR, b, 3, usdc(25)), 409, /not an active contract/);
    gemini.override(withContracts(fixture(POR.event), () => ({ marketState: "closed" })));
    await rejects(pairs.preview(TOR, POR), 409, /not an active contract/);
  });

  it("refuses anything but the exact first buy it prepared, signed by the buyer", async () => {
    const { pairs, chain, buyer, sign } = setup();
    const b = buyer.publicKey.toBase58();
    const prep = await pairs.prepare(TOR, POR, b, 3, usdc(25));
    // Unsigned, signed by someone else, or a different transaction.
    await rejects(pairs.create(prep.prepareId, prep.tx), 400, /not the signed first buy/);
    const other = await pairs.prepare(TOR, OVER, b, 0, usdc(40));
    await rejects(pairs.create(prep.prepareId, sign(other.tx)), 400, /not the signed first buy/);
    await rejects(pairs.create(prep.prepareId, "garbage"), 400, /./);
    await rejects(pairs.create("unknown-id", sign(prep.tx)), 410, /expired/);
    expect(chain.markets.size).toBe(0);
    // The right one still works.
    await expect(pairs.create(prep.prepareId, sign(prep.tx))).resolves.toMatchObject({ idHex: pairId });
  });

  it("expires a prepared request after a minute", async () => {
    const { pairs, chain, buyer, sign, clock } = setup();
    const prep = await pairs.prepare(TOR, POR, buyer.publicKey.toBase58(), 3, usdc(25));
    clock.now += 61_000;
    await rejects(pairs.create(prep.prepareId, sign(prep.tx)), 410, /expired/);
    expect(chain.markets.size).toBe(0);
  });

  it("keeps the pool and says so if the first buy does not land", async () => {
    const { pairs, chain, buyer, sign } = setup();
    const prep = await pairs.prepare(TOR, POR, buyer.publicKey.toBase58(), 3, usdc(25));
    const realCreate = chain.createMarket.bind(chain);
    chain.createMarket = async (m) => {
      const r = await realCreate(m);
      chain.failNext = 1; // the buy that follows fails
      return r;
    };
    const out = await pairs.create(prep.prepareId, sign(prep.tx));
    expect(out.buySignature).toBeNull();
    expect(out.buyError).toMatch(/simulated/);
    expect(chain.markets.has(pairId)).toBe(true);
  });

  it("resolves a pair to 2a + b once both legs settle, through the normal watcher", async () => {
    const { pairs, relayer, gemini, chain, buyer, sign } = setup();
    const prep = await pairs.prepare(TOR, POR, buyer.publicKey.toBase58(), 3, usdc(25));
    await pairs.create(prep.prepareId, sign(prep.tx));
    await relayer.refresh();
    expect(relayer.reference(pairId)!.pair!.combo).toMatchObject({ outcomeIndex: 3 });
    expect(await relayer.settleOnce()).toEqual([]);

    gemini.settle(TOR.event, TOR.contract, "yes");
    await relayer.refresh();
    expect((await relayer.settleOnce())[0]!.decision.action).toBe("halt");
    gemini.settle(POR.event, POR.contract, "no");
    await relayer.refresh();
    expect((await relayer.settleOnce())[0]!.decision).toMatchObject({ action: "resolve", winner: 2 }); // Yes / No
    expect(chain.markets.get(pairId)).toMatchObject({ status: "resolved", winner: 2 });
  });
});

describe("pair HTTP API", () => {
  async function server() {
    const ctx = setup();
    await ctx.relayer.mirror([{ kind: "binary", event: TOR.event, contract: TOR.contract }]);
    const app = await buildServer({
      relayer: ctx.relayer,
      store: ctx.store,
      chain: ctx.chain,
      rpcUrl: "http://127.0.0.1:8899",
      seedUsdc: 500,
      pairs: { service: ctx.pairs, curated: [{ a: TOR, b: POR, note: "same night" }, { a: TOR, b: { event: "GONE", contract: "GEMI-GONE" } }], gemini: ctx.gemini },
    });
    return { ...ctx, app };
  }

  it("lists curated pairs and leg choices, previews, prepares and creates", async () => {
    const { app, buyer, sign, chain } = await server();
    const curated = (await app.inject("/pairs/curated")).json() as { idHex: string; note: string; combo: unknown }[];
    expect(curated).toHaveLength(1); // the pair with a missing leg is dropped
    expect(curated[0]).toMatchObject({ idHex: pairId, note: "same night" });

    const legs = (await app.inject("/pairs/legs")).json() as { contract: string; label: string }[];
    expect(legs.map((l) => l.contract)).toContain(TOR.contract);
    expect(legs.find((l) => l.contract === TOR.contract)!.label).toBe("New York vs Toronto: Toronto");

    const preview = await app.inject({ method: "POST", url: "/pairs/preview", payload: { a: TOR, b: POR } });
    expect(preview.json()).toMatchObject({ exists: false, minFirstBuyUsdc: 25 });
    expect((await app.inject({ method: "POST", url: "/pairs/preview", payload: { a: TOR } })).statusCode).toBe(400);

    const tooSmall = await app.inject({ method: "POST", url: "/pairs/prepare", payload: { a: TOR, b: POR, buyer: buyer.publicKey.toBase58(), outcome: 3, usdcIn: usdc(5) } });
    expect(tooSmall.statusCode).toBe(400);
    const prep = (await app.inject({ method: "POST", url: "/pairs/prepare", payload: { a: TOR, b: POR, buyer: buyer.publicKey.toBase58(), outcome: 3, usdcIn: usdc(50) } })).json() as { prepareId: string; tx: string };
    const created = await app.inject({ method: "POST", url: "/pairs", payload: { prepareId: prep.prepareId, tx: sign(prep.tx) } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ idHex: pairId });
    expect(chain.markets.get(pairId)!.kind).toBe("pair");
    // It now shows up with the other markets, with its pair reference.
    const market = (await app.inject(`/reference/${pairId}`)).json() as { pair: { product: number[] }; outcomes: unknown[] };
    expect(market.outcomes).toHaveLength(4);
    expect(market.pair.product).toHaveLength(4);
  });
});

describe("legChoices", () => {
  it("offers every tradable contract of the given events", async () => {
    const legs = await legChoices(new GeminiMock(FIXTURES), [TOR.event, TOR.event, "BTC05M2611170500"]);
    expect(legs.map((l) => l.contract).sort()).toEqual(["GEMI-NBA-2611180030-NYK-TOR-M-NYK", TOR.contract].sort());
  });
});
