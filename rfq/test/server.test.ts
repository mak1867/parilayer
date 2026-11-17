import type { RfqFill } from "@pmec/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type RfqServer, buildRfqServer } from "../src/server";
import { RfqStore } from "../src/store";
import { FakeChain, MARKET, Trader, sharesOf, usdcOf } from "./fake";
import { Client } from "./wsClient";

let server: RfqServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start() {
  const chain = new FakeChain();
  const store = new RfqStore(":memory:");
  server = await buildRfqServer(chain, store, { quoteWindowMs: 250, decideWindowMs: 3000, signWindowMs: 3000 });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.app.server.address() as { port: number };
  return { chain, store, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
}

describe("RFQ service over WebSocket", () => {
  it("settles a full trade between two wallets and publishes it on the tape", async () => {
    const { chain, http, ws } = await start();
    const alice = new Trader();
    const bob = new Trader();
    chain.fund(alice.wallet, chain.usdcMint, usdcOf(500));
    chain.fund(bob.wallet, chain.mints[1]!, sharesOf(200));

    const a = await Client.open(ws);
    const b = await Client.open(ws);
    const watcher = await Client.open(ws); // not signed in: sees only the public tape

    // Nothing works before a signed hello.
    a.send({ t: "rfq", marketId: MARKET, outcome: 1, size: sharesOf(100).toString() });
    expect((await a.next("error")).code).toBe("not_authenticated");

    const now = Date.now();
    a.send(alice.hello(now));
    b.send(bob.hello(now));
    expect(await a.next("ready")).toMatchObject({ wallet: alice.wallet, fillRate: 1, cooldownUntil: null });
    await b.next("ready");

    b.send({ t: "quoter_on", marketId: MARKET, ts: now, sig: bob.quoterSig(MARKET, now) });
    expect(await b.next("quoter_status")).toMatchObject({ on: true });
    expect(await (await fetch(`${http}/quoters?market=${MARKET}`)).json()).toMatchObject({ online: 1 });

    a.send({ t: "rfq", marketId: MARKET, outcome: 1, size: sharesOf(100).toString() });
    const open = await a.next("rfq_open");
    const request = await b.next("rfq_request");
    expect(request.rfqId).toBe(open.rfqId);
    b.send({ t: "quote", rfqId: request.rfqId, ask: "750000" });

    const quotes = await a.next("rfq_quotes");
    expect(quotes).toMatchObject({ bestBid: null, bestAsk: "750000" });
    a.send({ t: "accept", rfqId: open.rfqId, side: "buy" });
    const [signA, signB] = await Promise.all([a.next("sign_request"), b.next("sign_request")]);
    a.send({ t: "signed", rfqId: open.rfqId, tx: alice.signTx(signA.tx) });
    b.send({ t: "signed", rfqId: open.rfqId, tx: bob.signTx(signB.tx) });

    const [doneA, doneB, fill] = await Promise.all([a.next("rfq_done"), b.next("rfq_done"), watcher.next("fill")]);
    expect(doneA).toMatchObject({ status: "filled" });
    expect(doneB).toMatchObject({ status: "filled" });
    expect(fill.fill).toMatchObject({ priceE6: "750000", size: sharesOf(100).toString(), outcome: 1 });

    expect(await chain.balance(alice.wallet, chain.mints[1]!)).toBe(sharesOf(100));
    expect(await chain.balance(bob.wallet, chain.usdcMint)).toBe(usdcOf(75));

    // The public HTTP tape and last-price endpoints.
    const tape = (await (await fetch(`${http}/tape?market=${MARKET}`)).json()) as RfqFill[];
    expect(tape).toHaveLength(1);
    expect(JSON.stringify(tape)).not.toContain(alice.wallet);
    expect(await (await fetch(`${http}/last?market=${MARKET}`)).json()).toMatchObject({ "1": { priceE6: "750000" } });
    expect(await (await fetch(`${http}/stats/${alice.wallet}`)).json()).toMatchObject({ fillRate: 1, cooldownUntil: null });
    expect(((await (await fetch(`${http}/fills/${bob.wallet}`)).json()) as { side: string }[])[0]).toMatchObject({ side: "sell" });
    expect((await fetch(`${http}/tape?market=nope`)).status).toBe(400);
  });

  it("drops a quoter when their connection closes, and rejects a forged hello", async () => {
    const { chain, http, ws } = await start();
    const bob = new Trader();
    const mallory = new Trader();
    chain.fund(bob.wallet, chain.mints[0]!, sharesOf(60));
    const b = await Client.open(ws);
    const now = Date.now();
    b.send(bob.hello(now));
    await b.next("ready");
    b.send({ t: "quoter_on", marketId: MARKET, ts: now, sig: bob.quoterSig(MARKET, now) });
    await b.next("quoter_status");

    const m = await Client.open(ws);
    m.send({ ...mallory.hello(now), wallet: bob.wallet }); // claims to be Bob with her own signature
    expect((await m.next("error")).code).toBe("bad_signature");
    m.send({ t: "quote", rfqId: "x", bid: "1" });
    expect((await m.next("error")).code).toBe("not_authenticated");

    b.ws.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(await (await fetch(`${http}/quoters?market=${MARKET}`)).json()).toMatchObject({ online: 0 });
  });
});
