import { type SwapTerms, buildSwapTx, swapTxMatches } from "@pmec/sdk";
import { Keypair, Transaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { RfqEngine, RfqError } from "../src/engine";
import { RfqStore } from "../src/store";
import { FakeChain, MARKET, Recorder, Trader, sharesOf, usdcOf } from "./fake";

const HOUR = 60 * 60 * 1000;

function setup() {
  const chain = new FakeChain();
  const store = new RfqStore(":memory:");
  const out = new Recorder();
  const clock = { now: 1_800_000_000_000 };
  const engine = new RfqEngine(chain, store, out, { now: () => clock.now });
  const advance = (ms: number) => {
    clock.now += ms;
    engine.sweep();
  };

  // Alice asks; Bob and Carol hold YES shares (outcome 1) and USDC and quote.
  const alice = new Trader();
  const bob = new Trader();
  const carol = new Trader();
  chain.fund(alice.wallet, chain.usdcMint, usdcOf(1_000));
  chain.fund(alice.wallet, chain.mints[1]!, sharesOf(300));
  for (const q of [bob, carol]) {
    chain.fund(q.wallet, chain.usdcMint, usdcOf(1_000));
    chain.fund(q.wallet, chain.mints[1]!, sharesOf(500));
  }
  const quoterOn = (t: Trader, minFillRate?: number) => engine.quoterOn(t.wallet, MARKET, clock.now, t.quoterSig(MARKET, clock.now), minFillRate);
  return { chain, store, out, clock, engine, advance, alice, bob, carol, quoterOn };
}

type Ctx = ReturnType<typeof setup>;

/** Alice requests `size` shares of YES and Bob quotes bid/ask; returns the RFQ id once the window has closed. */
async function quotedRfq(c: Ctx, size = 100, bid = "600000", ask = "800000"): Promise<string> {
  const id = await c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(size).toString());
  await c.engine.quote(c.bob.wallet, id, bid, ask);
  c.advance(10_000);
  return id;
}

async function expectError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RfqError && e.code === code);
}

describe("a full trade between two wallets", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = setup();
    await c.quoterOn(c.bob);
  });

  it("requester buys at the best ask: shares, USDC and the fee all move in one transaction", async () => {
    const { engine, chain, out, alice, bob } = c;
    const id = await engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString());
    expect(out.last(alice.wallet, "rfq_open")).toMatchObject({ rfqId: id, quoters: 1 });
    expect(out.last(bob.wallet, "rfq_request")).toMatchObject({ rfqId: id, outcome: 1, size: sharesOf(100).toString() });

    await engine.quote(bob.wallet, id, "600000", "800000");
    // Nothing is shown while the 10-second window is open.
    expect(out.last(alice.wallet, "rfq_quotes")).toBeUndefined();
    await expectError(engine.accept(alice.wallet, id, "buy"), "too_early");

    c.advance(10_000);
    expect(out.last(alice.wallet, "rfq_quotes")).toMatchObject({ bestBid: "600000", bestAsk: "800000" });

    await engine.accept(alice.wallet, id, "buy");
    const forAlice = out.last(alice.wallet, "sign_request")!;
    const forBob = out.last(bob.wallet, "sign_request")!;
    expect(forAlice.role).toBe("buyer");
    expect(forBob.role).toBe("seller");
    expect(forAlice.tx).toBe(forBob.tx);
    // 100 shares at 0.80 = 80 USDC; the requester pays a 0.5% fee = 0.40 USDC.
    expect(forAlice.terms).toMatchObject({ value: usdcOf(80).toString(), fee: usdcOf(0.4).toString(), buyer: alice.wallet, seller: bob.wallet });
    // Each side can check the transaction is exactly the agreed swap before signing.
    expect(swapTxMatches(Transaction.from(Buffer.from(forAlice.tx, "base64")), forAlice.terms)).toBe(true);

    await engine.signed(alice.wallet, id, alice.signTx(forAlice.tx));
    expect(chain.submitted).toBe(0); // one signature is not enough
    await engine.signed(bob.wallet, id, bob.signTx(forBob.tx));

    expect(chain.submitted).toBe(1);
    expect(await chain.balance(alice.wallet, chain.mints[1]!)).toBe(sharesOf(400));
    expect(await chain.balance(bob.wallet, chain.mints[1]!)).toBe(sharesOf(400));
    expect(await chain.balance(alice.wallet, chain.usdcMint)).toBe(usdcOf(1_000 - 80 - 0.4));
    expect(await chain.balance(bob.wallet, chain.usdcMint)).toBe(usdcOf(1_080));
    expect(chain.treasury).toBe(usdcOf(0.4));

    expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ status: "filled", signature: "sig1" });
    expect(out.last(bob.wallet, "rfq_done")).toMatchObject({ status: "filled" });
    // The fill is published: price, size, time. No wallets.
    expect(out.broadcasts).toHaveLength(1);
    const fill = out.broadcasts[0]!;
    expect(fill).toMatchObject({ t: "fill", fill: { marketId: MARKET, outcome: 1, priceE6: "800000", size: sharesOf(100).toString(), signature: "sig1" } });
    expect(JSON.stringify(fill)).not.toContain(alice.wallet);
    expect(JSON.stringify(fill)).not.toContain(bob.wallet);
    expect(c.store.tape(MARKET)).toHaveLength(1);
    expect(c.store.lastPrices(MARKET)[1]).toMatchObject({ priceE6: "800000" });
    expect(c.store.fillsOf(alice.wallet)[0]).toMatchObject({ side: "buy", value: usdcOf(80).toString() });
    expect(c.store.fillsOf(bob.wallet)[0]).toMatchObject({ side: "sell" });
  });

  it("requester sells at the best bid, and the buying quoter can name a fresh receiving address", async () => {
    const { engine, chain, out, alice, bob } = c;
    const fresh = Keypair.generate().publicKey.toBase58();
    const id = await engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString());
    await engine.quote(bob.wallet, id, "600000", undefined, fresh);
    c.advance(10_000);
    // Nobody offered to sell, so "buy" is not possible; the request stays open for the other side.
    await expectError(engine.accept(alice.wallet, id, "buy"), "no_quote");
    const id2 = id;
    await engine.accept(alice.wallet, id2, "sell");
    const req = out.last(alice.wallet, "sign_request")!;
    expect(req.role).toBe("seller");
    expect(req.terms).toMatchObject({ buyer: bob.wallet, seller: alice.wallet, receiver: fresh, requester: alice.wallet });
    await engine.signed(bob.wallet, id2, bob.signTx(req.tx));
    await engine.signed(alice.wallet, id2, alice.signTx(req.tx));

    // 100 shares at 0.60: Alice receives 60 and pays the 0.30 fee; the shares land at the fresh address.
    expect(await chain.balance(fresh, chain.mints[1]!)).toBe(sharesOf(100));
    expect(await chain.balance(bob.wallet, chain.mints[1]!)).toBe(sharesOf(500));
    expect(await chain.balance(alice.wallet, chain.mints[1]!)).toBe(sharesOf(200));
    expect(await chain.balance(alice.wallet, chain.usdcMint)).toBe(usdcOf(1_000 + 60 - 0.3));
    expect(chain.treasury).toBe(usdcOf(0.3));
    expect(engine.cooldownUntil(alice.wallet)).toBeNull();
  });

  it("a requester buying can name a fresh receiving address too", async () => {
    const { engine, chain, out, alice, bob } = c;
    const fresh = Keypair.generate().publicKey.toBase58();
    const id = await quotedRfq(c);
    await engine.accept(alice.wallet, id, "buy", fresh);
    const req = out.last(alice.wallet, "sign_request")!;
    await engine.signed(alice.wallet, id, alice.signTx(req.tx));
    await engine.signed(bob.wallet, id, bob.signTx(req.tx));
    expect(await chain.balance(fresh, chain.mints[1]!)).toBe(sharesOf(100));
    expect(await chain.balance(alice.wallet, chain.mints[1]!)).toBe(sharesOf(300));
  });
});

describe("what is hidden", () => {
  it("quoters never learn who is asking or which side, and never see each other's quotes", async () => {
    const c = setup();
    const { engine, out, alice, bob, carol } = c;
    await c.quoterOn(bob);
    await c.quoterOn(carol);
    const id = await engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString());
    await engine.quote(bob.wallet, id, "610000", "790000");
    await engine.quote(carol.wallet, id, "650000", "850000");
    c.advance(10_000);

    for (const quoter of [bob, carol]) {
      const seen = JSON.stringify(out.to(quoter.wallet));
      expect(seen).not.toContain(alice.wallet);
      expect(seen).not.toMatch(/"side"|"buy"|"sell"/);
      // No quote prices at all reach a quoter: not their rival's, not the best.
      expect(seen).not.toMatch(/6[15]0000|790000|850000/);
      expect(out.to(quoter.wallet).some((m) => m.t === "rfq_quotes")).toBe(false);
    }
    expect(JSON.stringify(out.to(bob.wallet))).not.toContain(carol.wallet);

    // The requester sees only the best on each side: Carol's bid, Bob's ask. Not who.
    expect(out.last(alice.wallet, "rfq_quotes")).toMatchObject({ bestBid: "650000", bestAsk: "790000" });
    expect(out.to(alice.wallet).filter((m) => m.t === "rfq_quotes")).toHaveLength(1);
    const aliceSaw = JSON.stringify(out.to(alice.wallet));
    expect(aliceSaw).not.toContain(bob.wallet);
    expect(aliceSaw).not.toContain(carol.wallet);
    expect(aliceSaw).not.toMatch(/610000|850000/);

    // Selling hits the best bid (Carol); Bob is told only that the request closed.
    await engine.accept(alice.wallet, id, "sell");
    expect(out.last(carol.wallet, "sign_request")?.role).toBe("buyer");
    expect(out.last(bob.wallet, "rfq_closed")).toMatchObject({ rfqId: id });
    expect(out.to(bob.wallet).some((m) => m.t === "sign_request")).toBe(false);
  });

  it("the earlier quote wins a tie", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    await c.quoterOn(c.carol);
    const id = await c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(100).toString());
    await c.engine.quote(c.carol.wallet, id, undefined, "800000");
    c.clock.now += 1_000;
    await c.engine.quote(c.bob.wallet, id, undefined, "800000");
    c.advance(9_000);
    await c.engine.accept(c.alice.wallet, id, "buy");
    expect(c.out.last(c.carol.wallet, "sign_request")?.role).toBe("seller");
  });
});

describe("anti-fishing rules", () => {
  it("rejects requests under 50 shares", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    await expectError(c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(49.999999).toString()), "too_small");
    await expect(c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(50).toString())).resolves.toBeTypeOf("string");
  });

  it("only holders can quote, and only with a fresh signature of their own", async () => {
    const c = setup();
    const stranger = new Trader();
    const ts = c.clock.now;
    await expectError(c.engine.quoterOn(stranger.wallet, MARKET, ts, stranger.quoterSig(MARKET, ts)), "not_a_holder");
    // Bob's signature does not work for Carol, nor for another market, nor when stale.
    await expectError(c.engine.quoterOn(c.carol.wallet, MARKET, ts, c.bob.quoterSig(MARKET, ts)), "bad_signature");
    await expectError(c.engine.quoterOn(c.bob.wallet, MARKET, ts, c.bob.quoterSig("cd".repeat(32), ts)), "bad_signature");
    await expectError(c.engine.quoterOn(c.bob.wallet, MARKET, ts - 10 * 60_000, c.bob.quoterSig(MARKET, ts - 10 * 60_000)), "stale_signature");
    await expectError(c.engine.quoterOn(c.bob.wallet, "cd".repeat(32), ts, c.bob.quoterSig("cd".repeat(32), ts)), "unknown_market");
    expect(c.engine.quoterCount(MARKET)).toBe(0);
    await c.quoterOn(c.bob);
    expect(c.engine.quoterCount(MARKET)).toBe(1);
    expect(() => c.engine.verifyHello(c.bob.wallet, ts, c.bob.hello(ts).sig)).not.toThrow();
    expect(() => c.engine.verifyHello(c.carol.wallet, ts, c.bob.hello(ts).sig)).toThrow(RfqError);
  });

  it("a quote must be coverable: shares for an ask, USDC for a bid", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    const id = await c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(600).toString());
    await expectError(c.engine.quote(c.bob.wallet, id, undefined, "800000"), "insufficient"); // holds 500 shares
    await expectError(c.engine.quote(c.bob.wallet, id, "1700000"), "insufficient"); // 600 x 1.70 = 1,020 USDC > 1,000
    await expectError(c.engine.quote(c.bob.wallet, id, "800000", "700000"), "bad_request"); // crossed
    await expectError(c.engine.quote(c.bob.wallet, id), "bad_request");
    await expectError(c.engine.quote(c.carol.wallet, id, "500000"), "closed"); // not invited
    await expect(c.engine.quote(c.bob.wallet, id, "700000")).resolves.toBeUndefined();
    c.advance(10_000);
    await expectError(c.engine.quote(c.bob.wallet, id, "710000"), "closed"); // window over
  });

  it("accepting and not signing within 30 s is a failure; 3 in an hour means a 1-hour cooldown", async () => {
    const c = setup();
    const { engine, out, alice, bob, store } = c;
    await c.quoterOn(bob);

    for (let k = 1; k <= 3; k++) {
      const id = await quotedRfq(c);
      await engine.accept(alice.wallet, id, "buy");
      // Bob signs promptly; Alice never does.
      await engine.signed(bob.wallet, id, bob.signTx(out.last(bob.wallet, "sign_request")!.tx));
      c.advance(30_001);
      expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ rfqId: id, status: "failed" });
      expect(store.failureTimes(alice.wallet, 0)).toHaveLength(k);
      expect(engine.cooldownUntil(alice.wallet) !== null).toBe(k === 3);
      c.clock.now += 5 * 60_000;
    }
    // The quoter who did sign is not penalized, and nothing settled.
    expect(store.failureTimes(bob.wallet, 0)).toHaveLength(0);
    expect(c.chain.submitted).toBe(0);

    await expectError(engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString()), "cooldown");
    await expectError(c.quoterOn(alice), "cooldown");
    expect(engine.stats(alice.wallet).cooldownUntil).toBeGreaterThan(c.clock.now);

    // Still locked out just under an hour after the third failure, free again after it.
    c.clock.now += 54 * 60_000;
    await expectError(engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString()), "cooldown");
    c.clock.now += 2 * 60_000;
    expect(engine.cooldownUntil(alice.wallet)).toBeNull();
    await expect(engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString())).resolves.toBeTypeOf("string");
  });

  it("three failures spread over more than an hour do not trigger a cooldown", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    for (let k = 0; k < 3; k++) {
      const id = await quotedRfq(c);
      await c.engine.accept(c.alice.wallet, id, "buy");
      c.advance(30_001);
      c.clock.now += 40 * 60_000;
    }
    // Both parties failed to sign each time; neither has 3 inside one hour.
    expect(c.store.failureTimes(c.alice.wallet, 0)).toHaveLength(3);
    expect(c.engine.cooldownUntil(c.alice.wallet)).toBeNull();
    expect(c.engine.cooldownUntil(c.bob.wallet)).toBeNull();
  });

  it("a quoter who does not sign is the one who gets the failure, and stops receiving requests in cooldown", async () => {
    const c = setup();
    const { engine, out, alice, bob } = c;
    await c.quoterOn(bob);
    for (let k = 0; k < 3; k++) {
      const id = await quotedRfq(c);
      await engine.accept(alice.wallet, id, "buy");
      await engine.signed(alice.wallet, id, alice.signTx(out.last(alice.wallet, "sign_request")!.tx));
      c.advance(30_001);
    }
    expect(c.store.failureTimes(bob.wallet, 0)).toHaveLength(3);
    expect(c.store.failureTimes(alice.wallet, 0)).toHaveLength(0);
    expect(engine.cooldownUntil(bob.wallet)).not.toBeNull();
    await engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString());
    expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ status: "no_quoters" });
  });

  it("tracks the requester's fill rate, and quoters can refuse low fill rates", async () => {
    const c = setup();
    const { engine, out, alice, bob, carol, store } = c;
    await c.quoterOn(bob);
    expect(store.fillRate(alice.wallet)).toBe(1); // no history

    // Alice gets quotes and walks away twice, then lets one expire.
    for (let k = 0; k < 2; k++) {
      const id = await quotedRfq(c);
      engine.walk(alice.wallet, id);
      expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ status: "walked" });
    }
    const id = await quotedRfq(c);
    c.advance(20_000);
    expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ rfqId: id, status: "expired" });
    expect(store.fillRate(alice.wallet)).toBe(0);

    // One real fill: 1 of 4.
    const id2 = await quotedRfq(c);
    await engine.accept(alice.wallet, id2, "buy");
    const req = out.last(alice.wallet, "sign_request")!;
    await engine.signed(alice.wallet, id2, alice.signTx(req.tx));
    await engine.signed(bob.wallet, id2, bob.signTx(req.tx));
    expect(store.fillRate(alice.wallet)).toBe(0.25);
    expect(engine.stats(alice.wallet).fillRate).toBe(0.25);

    // An RFQ nobody quoted does not count against her.
    const id3 = await engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString());
    c.advance(10_000);
    expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ rfqId: id3, status: "expired" });
    expect(store.fillRate(alice.wallet)).toBe(0.25);

    // Carol only answers requesters who fill at least half the time: she is not asked.
    await c.quoterOn(carol, 0.5);
    const before = out.to(carol.wallet).filter((m) => m.t === "rfq_request").length;
    await engine.createRfq(alice.wallet, MARKET, 1, sharesOf(100).toString());
    expect(out.to(carol.wallet).filter((m) => m.t === "rfq_request").length).toBe(before);
    expect(out.to(bob.wallet).filter((m) => m.t === "rfq_request").length).toBeGreaterThan(0);
    await expectError(c.quoterOn(carol, 1.5), "bad_request");
  });
});

describe("settlement safety", () => {
  it("rejects a signature over anything but the agreed transaction", async () => {
    const c = setup();
    const { engine, out, alice, bob, chain } = c;
    await c.quoterOn(bob);
    const id = await quotedRfq(c);
    await engine.accept(alice.wallet, id, "buy");
    const req = out.last(bob.wallet, "sign_request")!;

    // Bob signs a doctored swap that pays him 10x. His signature does not fit the real one.
    const doctored: SwapTerms = { ...req.terms, value: (BigInt(req.terms.value) * 10n).toString() };
    const fake = buildSwapTx(doctored);
    fake.partialSign(bob.kp);
    await expectError(engine.signed(bob.wallet, id, fake.serialize({ requireAllSignatures: false }).toString("base64")), "bad_signature");
    // Someone else's signature, garbage, and outsiders are rejected too.
    await expectError(engine.signed(bob.wallet, id, alice.signTx(req.tx)), "bad_signature");
    await expectError(engine.signed(bob.wallet, id, "not-a-transaction"), "bad_signature");
    await expectError(engine.signed(c.carol.wallet, id, req.tx), "closed");
    expect(chain.submitted).toBe(0);

    // The honest signatures still settle it.
    await engine.signed(bob.wallet, id, bob.signTx(req.tx));
    await engine.signed(alice.wallet, id, alice.signTx(req.tx));
    expect(chain.submitted).toBe(1);
  });

  it("if one transfer fails, the whole swap reverts and nothing moves", async () => {
    const c = setup();
    const { engine, out, alice, bob, chain } = c;
    await c.quoterOn(bob);
    const id = await quotedRfq(c);
    await engine.accept(alice.wallet, id, "buy");
    const req = out.last(alice.wallet, "sign_request")!;
    const snapshot = new Map(chain.accounts);

    // After agreeing, Bob moves his shares away. Alice's USDC leg alone would still succeed.
    chain.drain(bob.wallet, chain.mints[1]!);
    snapshot.set([...snapshot.keys()].find((k) => chain.accounts.get(k) === 0n && snapshot.get(k) === sharesOf(500))!, 0n);
    await engine.signed(alice.wallet, id, alice.signTx(req.tx));
    await engine.signed(bob.wallet, id, bob.signTx(req.tx));

    expect(chain.submitted).toBe(0);
    expect(new Map(chain.accounts)).toEqual(snapshot); // no USDC moved, no fee taken
    expect(await chain.balance(alice.wallet, chain.usdcMint)).toBe(usdcOf(1_000));
    expect(chain.treasury).toBe(0n);
    expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ status: "failed" });
    expect(out.broadcasts).toHaveLength(0);
    expect(c.store.tape(MARKET)).toHaveLength(0);
    // A failed settlement is nobody's signing failure.
    expect(c.store.failureTimes(alice.wallet, 0)).toHaveLength(0);
    expect(c.store.failureTimes(bob.wallet, 0)).toHaveLength(0);
  });

  it("does not ask anyone to sign a swap that could not settle", async () => {
    const c = setup();
    const { engine, out, alice, bob, chain } = c;
    await c.quoterOn(bob);
    const id = await quotedRfq(c);
    chain.drain(bob.wallet, chain.mints[1]!); // gone before Alice accepts
    await engine.accept(alice.wallet, id, "buy");
    expect(out.to(alice.wallet).some((m) => m.t === "sign_request")).toBe(false);
    expect(out.last(alice.wallet, "rfq_done")).toMatchObject({ status: "failed" });
    expect(c.store.failureTimes(alice.wallet, 0)).toHaveLength(0);
  });

  it("signing after the 30 seconds is refused", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    const id = await quotedRfq(c);
    await c.engine.accept(c.alice.wallet, id, "buy");
    const req = c.out.last(c.alice.wallet, "sign_request")!;
    c.clock.now += 30_001;
    await expectError(c.engine.signed(c.alice.wallet, id, c.alice.signTx(req.tx)), "too_late");
  });
});

describe("lifecycle edges", () => {
  it("one open request per wallet; walking away frees it", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    const id = await c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(100).toString());
    await expectError(c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(100).toString()), "busy");
    c.engine.walk(c.alice.wallet, id);
    expect(c.out.last(c.bob.wallet, "rfq_closed")).toMatchObject({ rfqId: id });
    await expect(c.engine.createRfq(c.alice.wallet, MARKET, 0, sharesOf(100).toString())).resolves.toBeTypeOf("string");
  });

  it("says so when nobody is quoting, and never invites the requester to quote themselves", async () => {
    const c = setup();
    await c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(100).toString());
    expect(c.out.last(c.alice.wallet, "rfq_done")).toMatchObject({ status: "no_quoters" });
    await c.quoterOn(c.alice);
    await c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(100).toString());
    expect(c.out.last(c.alice.wallet, "rfq_done")).toMatchObject({ status: "no_quoters" });
    expect(c.out.to(c.alice.wallet).some((m) => m.t === "rfq_request")).toBe(false);
  });

  it("a quoter going offline or opting out stops receiving requests", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    await c.quoterOn(c.carol);
    c.engine.walletOffline(c.bob.wallet);
    c.engine.quoterOff(c.carol.wallet, MARKET);
    expect(c.engine.quoterCount(MARKET)).toBe(0);
  });

  it("rejects unknown markets, bad outcomes and settled markets", async () => {
    const c = setup();
    await c.quoterOn(c.bob);
    await expectError(c.engine.createRfq(c.alice.wallet, "cd".repeat(32), 1, sharesOf(100).toString()), "unknown_market");
    await expectError(c.engine.createRfq(c.alice.wallet, MARKET, 7, sharesOf(100).toString()), "bad_request");
    await expectError(c.engine.createRfq(c.alice.wallet, MARKET, 1, "12.5"), "bad_request");
    c.chain.tradable = false;
    await expectError(c.engine.createRfq(c.alice.wallet, MARKET, 1, sharesOf(100).toString()), "market_settled");
  });
});
