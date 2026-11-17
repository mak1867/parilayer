/**
 * End-to-end against a real validator: the RFQ service with the real chain
 * adapter, real SPL tokens, real signatures.
 *
 *   ./scripts/local-validator.sh           (terminal 1)
 *   GEMINI_MOCK=1 ./scripts/local-setup.sh (terminal 2)
 *   E2E_RPC_URL=http://127.0.0.1:8899 npm test -w rfq
 *
 * Skipped unless E2E_RPC_URL is set.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type MarketState,
  UNIT,
  ata,
  buyIxs,
  fetchAllMarkets,
  fetchConfig,
  fetchMarket,
  getProgram,
  outcomeMintPda,
  probPpm,
  treasuryPda,
} from "@pmec/sdk";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferInstruction } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SolanaRfqChain } from "../src/chain";
import { type RfqServer, buildRfqServer } from "../src/server";
import { RfqStore } from "../src/store";
import { Trader } from "./fake";
import { Client } from "./wsClient";

const RPC = process.env.E2E_RPC_URL;
const ROOT = resolve(import.meta.dirname, "..", "..");

describe.skipIf(!RPC)("RFQ end to end on a validator", () => {
  const connection = new Connection(RPC ?? "http://127.0.0.1:8899", "confirmed");
  const program = getProgram(connection);
  const admin = RPC ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(ROOT, "keys/admin.json"), "utf8")) as number[])) : Keypair.generate();
  let server: RfqServer;
  let wsUrl: string;
  let usdcMint: PublicKey;
  let market: MarketState;
  let shareMint: PublicKey;
  const OUTCOME = 1;

  const bal = async (owner: PublicKey, mint: PublicKey): Promise<bigint> => {
    const info = await connection.getAccountInfo(ata(mint, owner), "confirmed");
    return info ? info.data.readBigUInt64LE(64) : 0n;
  };
  const treasury = async () => BigInt((await connection.getTokenAccountBalance(treasuryPda(), "confirmed")).value.amount);

  /** A wallet with SOL and mock USDC; optionally holding shares bought from the pool. */
  async function trader(usdc: bigint, buyUsdc = 0n): Promise<Trader> {
    const t = new Trader();
    const dest = ata(usdcMint, t.kp.publicKey);
    await connection.confirmTransaction(await connection.requestAirdrop(t.kp.publicKey, LAMPORTS_PER_SOL), "confirmed");
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, dest, t.kp.publicKey, usdcMint),
        createMintToInstruction(usdcMint, dest, admin.publicKey, usdc),
      ),
      [admin],
    );
    if (buyUsdc > 0n) {
      const ixs = await buyIxs(program, { buyer: t.kp.publicKey, market: market.address, usdcMint, outcome: OUTCOME, usdcIn: buyUsdc, minSharesOut: 0n });
      await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [t.kp]);
    }
    return t;
  }

  async function signIn(t: Trader): Promise<Client> {
    const c = await Client.open(wsUrl);
    c.send(t.hello(Date.now()));
    await c.next("ready");
    return c;
  }

  beforeAll(async () => {
    const cfg = await fetchConfig(program);
    if (!cfg) throw new Error("program not initialized on this validator; run scripts/local-setup.sh");
    usdcMint = cfg.usdcMint;
    const open = (await fetchAllMarkets(program)).find((m) => m.status === "open" && m.kind === "binary");
    if (!open) throw new Error("no open binary market; run scripts/local-setup.sh");
    market = open;
    shareMint = outcomeMintPda(market.address, OUTCOME);
    server = await buildRfqServer(new SolanaRfqChain(connection), new RfqStore(":memory:"), { quoteWindowMs: 1500 });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    wsUrl = `ws://127.0.0.1:${(server.app.server.address() as { port: number }).port}/ws`;
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("two wallets complete a trade in one transaction and the pool's odds do not move", async () => {
    const seller = await trader(300n * UNIT, 200n * UNIT); // buys shares from the pool first
    const buyer = await trader(500n * UNIT);
    const size = 100n * UNIT;
    const price = 800_000n; // 0.80 USDC a share
    expect(await bal(seller.kp.publicKey, shareMint)).toBeGreaterThan(size);

    const before = (await fetchMarket(program, market.address))!;
    const [sellerShares0, sellerUsdc0, buyerUsdc0, treasury0] = await Promise.all([
      bal(seller.kp.publicKey, shareMint),
      bal(seller.kp.publicKey, usdcMint),
      bal(buyer.kp.publicKey, usdcMint),
      treasury(),
    ]);

    const s = await signIn(seller);
    const b = await signIn(buyer);
    const ts = Date.now();
    s.send({ t: "quoter_on", marketId: market.idHex, ts, sig: seller.quoterSig(market.idHex, ts) });
    expect(await s.next("quoter_status")).toMatchObject({ on: true });

    b.send({ t: "rfq", marketId: market.idHex, outcome: OUTCOME, size: size.toString() });
    const open = await b.next("rfq_open");
    const req = await s.next("rfq_request");
    s.send({ t: "quote", rfqId: req.rfqId, ask: price.toString() });
    expect(await b.next("rfq_quotes", 8000)).toMatchObject({ bestAsk: price.toString(), bestBid: null });
    b.send({ t: "accept", rfqId: open.rfqId, side: "buy" });
    const [signB, signS] = await Promise.all([b.next("sign_request", 15_000), s.next("sign_request", 15_000)]);
    b.send({ t: "signed", rfqId: open.rfqId, tx: buyer.signTx(signB.tx) });
    s.send({ t: "signed", rfqId: open.rfqId, tx: seller.signTx(signS.tx) });
    const done = await b.next("rfq_done", 30_000);
    expect(done).toMatchObject({ status: "filled" });

    // Exactly the agreed amounts moved: 100 shares, 80 USDC, and a 0.40 USDC fee from the requester.
    expect(await bal(buyer.kp.publicKey, shareMint)).toBe(size);
    expect(await bal(seller.kp.publicKey, shareMint)).toBe(sellerShares0 - size);
    expect(await bal(seller.kp.publicKey, usdcMint)).toBe(sellerUsdc0 + 80n * UNIT);
    expect(await bal(buyer.kp.publicKey, usdcMint)).toBe(buyerUsdc0 - 80n * UNIT - 400_000n);
    expect(await treasury()).toBe(treasury0 + 400_000n);

    // The pool did not notice: same shares outstanding, same pot, same odds.
    const after = (await fetchMarket(program, market.address))!;
    expect(after.q).toEqual(before.q);
    expect(after.pot).toBe(before.pot);
    expect(probPpm(after.q, OUTCOME)).toBe(probPpm(before.q, OUTCOME));

    // And it is on the chain as one transaction.
    const tx = await connection.getTransaction(done.signature!, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    expect(tx?.meta?.err).toBeNull();
    s.ws.close();
    b.ws.close();
  }, 120_000);

  it("if one transfer fails, the whole swap reverts: no USDC moves and no fee is taken", async () => {
    const seller = await trader(300n * UNIT, 200n * UNIT);
    const buyer = await trader(500n * UNIT);
    const size = 100n * UNIT;

    const s = await signIn(seller);
    const b = await signIn(buyer);
    const ts = Date.now();
    s.send({ t: "quoter_on", marketId: market.idHex, ts, sig: seller.quoterSig(market.idHex, ts) });
    await s.next("quoter_status");
    b.send({ t: "rfq", marketId: market.idHex, outcome: OUTCOME, size: size.toString() });
    const open = await b.next("rfq_open");
    const req = await s.next("rfq_request");
    s.send({ t: "quote", rfqId: req.rfqId, ask: "800000" });
    await b.next("rfq_quotes", 8000);
    b.send({ t: "accept", rfqId: open.rfqId, side: "buy" });
    const [signB, signS] = await Promise.all([b.next("sign_request", 15_000), s.next("sign_request", 15_000)]);

    // After agreeing, the seller moves every share to another wallet. The buyer's
    // USDC transfer on its own would still be valid.
    const elsewhere = Keypair.generate().publicKey;
    const all = await bal(seller.kp.publicKey, shareMint);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(seller.kp.publicKey, ata(shareMint, elsewhere), elsewhere, shareMint),
        createTransferInstruction(ata(shareMint, seller.kp.publicKey), ata(shareMint, elsewhere), seller.kp.publicKey, all),
      ),
      [seller.kp],
    );
    const [buyerUsdc0, sellerUsdc0, treasury0] = await Promise.all([bal(buyer.kp.publicKey, usdcMint), bal(seller.kp.publicKey, usdcMint), treasury()]);

    b.send({ t: "signed", rfqId: open.rfqId, tx: buyer.signTx(signB.tx) });
    s.send({ t: "signed", rfqId: open.rfqId, tx: seller.signTx(signS.tx) });
    const done = await b.next("rfq_done", 30_000);
    expect(done.status).toBe("failed");

    expect(await bal(buyer.kp.publicKey, usdcMint)).toBe(buyerUsdc0);
    expect(await bal(seller.kp.publicKey, usdcMint)).toBe(sellerUsdc0);
    expect(await treasury()).toBe(treasury0);
    expect(await bal(buyer.kp.publicKey, shareMint)).toBe(0n);
    s.ws.close();
    b.ws.close();
  }, 120_000);
});
