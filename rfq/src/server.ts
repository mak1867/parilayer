import cors from "@fastify/cors";
import type { RfqClientMsg, RfqServerMsg } from "@pmec/sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { type WebSocket, WebSocketServer } from "ws";
import { RfqEngine, RfqError, type Outbox, type RfqChain, type EngineOptions } from "./engine";
import type { RfqStore } from "./store";

const HEX64 = /^[0-9a-f]{64}$/;

/** WebSocket connections, grouped by the wallet each one proved it owns. */
class Sockets implements Outbox {
  readonly byWallet = new Map<string, Set<WebSocket>>();
  readonly all = new Set<WebSocket>();

  send(wallet: string, msg: RfqServerMsg): void {
    const text = JSON.stringify(msg);
    for (const ws of this.byWallet.get(wallet) ?? []) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  broadcast(msg: RfqServerMsg): void {
    const text = JSON.stringify(msg);
    for (const ws of this.all) if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

export interface RfqServer {
  app: FastifyInstance;
  engine: RfqEngine;
  close(): Promise<void>;
}

/**
 * HTTP + WebSocket front of the RFQ engine.
 *
 *   WS   /ws                 authenticated trading channel (see RfqClientMsg / RfqServerMsg)
 *   GET  /tape?market=       public trade tape: price, size, time
 *   GET  /last?market=       last secondary price per outcome
 *   GET  /quoters?market=    how many quoters are online (a count, never who)
 *   GET  /stats/:wallet      a wallet's fill rate and cooldown
 *   GET  /fills/:wallet      a wallet's own secondary trades
 */
export async function buildRfqServer(chain: RfqChain, store: RfqStore, options: EngineOptions = {}): Promise<RfqServer> {
  const sockets = new Sockets();
  const engine = new RfqEngine(chain, store, sockets, options);
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true, connections: sockets.all.size }));

  app.get<{ Querystring: { market?: string; limit?: string } }>("/tape", async (req, reply) => {
    const market = req.query.market;
    if (market !== undefined && !HEX64.test(market)) return reply.code(400).send({ error: "market must be a 64-character hex id" });
    return store.tape(market, Math.max(1, Math.min(Number(req.query.limit) || 50, 500)));
  });

  app.get<{ Querystring: { market?: string } }>("/last", async (req, reply) => {
    if (!req.query.market || !HEX64.test(req.query.market)) return reply.code(400).send({ error: "market must be a 64-character hex id" });
    return store.lastPrices(req.query.market);
  });

  app.get<{ Querystring: { market?: string } }>("/quoters", async (req, reply) => {
    if (!req.query.market || !HEX64.test(req.query.market)) return reply.code(400).send({ error: "market must be a 64-character hex id" });
    return { market: req.query.market, online: engine.quoterCount(req.query.market) };
  });

  app.get<{ Params: { wallet: string } }>("/stats/:wallet", async (req) => engine.stats(req.params.wallet));
  app.get<{ Params: { wallet: string } }>("/fills/:wallet", async (req) => store.fillsOf(req.params.wallet));

  const wss = new WebSocketServer({ server: app.server, path: "/ws", maxPayload: 64 * 1024 });
  wss.on("connection", (ws) => {
    let wallet: string | null = null;
    sockets.all.add(ws);
    const reply = (msg: RfqServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

    ws.on("message", (data) => {
      void (async () => {
        let msg: RfqClientMsg;
        try {
          msg = JSON.parse(String(data)) as RfqClientMsg;
        } catch {
          return reply({ t: "error", code: "bad_request", message: "Messages must be JSON." });
        }
        const rfqId = "rfqId" in msg ? msg.rfqId : undefined;
        try {
          if (msg.t === "hello") {
            engine.verifyHello(msg.wallet, msg.ts, msg.sig);
            if (wallet && wallet !== msg.wallet) sockets.byWallet.get(wallet)?.delete(ws);
            wallet = msg.wallet;
            let set = sockets.byWallet.get(wallet);
            if (!set) sockets.byWallet.set(wallet, (set = new Set()));
            set.add(ws);
            return reply({ t: "ready", wallet, ...engine.stats(wallet), minSize: engine.minSize.toString() });
          }
          if (!wallet) throw new RfqError("not_authenticated", "Say hello with a signed message first.");
          switch (msg.t) {
            case "quoter_on":
              return await engine.quoterOn(wallet, msg.marketId, msg.ts, msg.sig, msg.minFillRate);
            case "quoter_off":
              return engine.quoterOff(wallet, msg.marketId);
            case "rfq":
              await engine.createRfq(wallet, msg.marketId, msg.outcome, msg.size);
              return;
            case "quote":
              return await engine.quote(wallet, msg.rfqId, msg.bid, msg.ask, msg.receiver);
            case "accept":
              return await engine.accept(wallet, msg.rfqId, msg.side, msg.receiver);
            case "walk":
              return engine.walk(wallet, msg.rfqId);
            case "signed":
              return await engine.signed(wallet, msg.rfqId, msg.tx);
            default:
              throw new RfqError("bad_request", "Unknown message type.");
          }
        } catch (e) {
          if (e instanceof RfqError) return reply({ t: "error", code: e.code, message: e.message, ...(rfqId ? { rfqId } : {}) });
          console.error("rfq:", e);
          reply({ t: "error", code: "internal", message: "Something went wrong on the RFQ server.", ...(rfqId ? { rfqId } : {}) });
        }
      })();
    });

    ws.on("close", () => {
      sockets.all.delete(ws);
      if (!wallet) return;
      const set = sockets.byWallet.get(wallet);
      set?.delete(ws);
      if (set && set.size === 0) {
        sockets.byWallet.delete(wallet);
        engine.walletOffline(wallet);
      }
    });
    ws.on("error", () => ws.close());
  });

  const timer = setInterval(() => engine.sweep(), 250);
  return {
    app,
    engine,
    close: async () => {
      clearInterval(timer);
      for (const ws of sockets.all) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await app.close();
    },
  };
}
