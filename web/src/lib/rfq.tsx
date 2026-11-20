"use client";

import {
  type RfqClientMsg,
  type RfqDoneStatus,
  type RfqFill,
  type RfqServerMsg,
  type SwapTerms,
  outcomeMintPda,
  rfqHelloMessage,
  rfqQuoterMessage,
  secondaryFee,
  swapTxMatches,
  swapValue,
  treasuryPda,
} from "@pmec/sdk";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useData } from "./data";
import { RFQ_URL } from "./env";

/** The request this wallet sent, as it moves through quoting, deciding, signing and done. */
export interface MyRfq {
  rfqId: string | null;
  marketId: string;
  outcome: number;
  size: bigint;
  phase: "sending" | "quoting" | "deciding" | "signing" | "done";
  quoters: number;
  expiresAt: number | null;
  decideBy: number | null;
  signBy: number | null;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  accepted: { side: "buy" | "sell"; receiver: string | null } | null;
  result: { status: RfqDoneStatus | "refused"; signature?: string; reason?: string } | null;
}

/** A request this wallet was asked to quote. The asker and their direction are unknown. */
export interface IncomingRequest {
  rfqId: string;
  marketId: string;
  outcome: number;
  size: bigint;
  expiresAt: number;
  sent: { bid: bigint | null; ask: bigint | null } | null;
  state: "open" | "sent" | "signing" | "filled" | "closed";
  note?: string;
}

interface RfqContext {
  status: "off" | "connecting" | "ready" | "error";
  error: string | null;
  fillRate: number | null;
  cooldownUntil: number | null;
  minSize: bigint;
  /** Markets (ids) this wallet is quoting. */
  quoting: Set<string>;
  quoterNote: string | null;
  mine: MyRfq | null;
  requests: IncomingRequest[];
  /** Bumps whenever a fill is published, so tapes can reload. */
  fillTick: number;
  lastFill: RfqFill | null;
  join: () => Promise<void>;
  leave: () => void;
  quoterOn: (marketId: string, minFillRate: number) => Promise<void>;
  quoterOff: (marketId: string) => void;
  request: (marketId: string, outcome: number, size: bigint) => void;
  accept: (side: "buy" | "sell", receiver: string | null) => void;
  walk: () => void;
  clearMine: () => void;
  sendQuote: (rfqId: string, bid: bigint | null, ask: bigint | null) => void;
  dismissRequest: (rfqId: string) => void;
}

const Ctx = createContext<RfqContext | null>(null);
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const wsUrl = () => RFQ_URL.replace(/^http/, "ws") + "/ws";

export function RfqProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const { markets, config, usdcMint } = useData();
  const me = wallet.publicKey?.toBase58() ?? null;

  const [status, setStatus] = useState<RfqContext["status"]>("off");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ fillRate: number; cooldownUntil: number | null } | null>(null);
  const [minSize, setMinSize] = useState(50_000_000n);
  const [quoting, setQuoting] = useState<Set<string>>(new Set());
  const [quoterNote, setQuoterNote] = useState<string | null>(null);
  const [mine, setMine] = useState<MyRfq | null>(null);
  const [requests, setRequests] = useState<IncomingRequest[]>([]);
  const [fillTick, setFillTick] = useState(0);
  const [lastFill, setLastFill] = useState<RfqFill | null>(null);

  const ws = useRef<WebSocket | null>(null);
  // Handlers read the latest state through refs, since the socket outlives renders.
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const live = useRef({ wallet, markets, config, usdcMint, me });
  live.current = { wallet, markets, config, usdcMint, me };

  const send = useCallback((msg: RfqClientMsg) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  const patchRequest = (rfqId: string, patch: Partial<IncomingRequest>) =>
    setRequests((rs) => rs.map((r) => (r.rfqId === rfqId ? { ...r, ...patch } : r)));

  /**
   * Checks a sign request against what this wallet agreed to, then signs.
   * The transaction must be byte-for-byte the swap rebuilt from the terms, and
   * the terms must be this wallet's own side, size and price.
   */
  const handleSignRequest = useCallback(
    async (msg: Extract<RfqServerMsg, { t: "sign_request" }>) => {
      const { wallet, markets, config, usdcMint, me } = live.current;
      const t: SwapTerms = msg.terms;
      const refuse = (why: string) => {
        if (mineRef.current?.rfqId === msg.rfqId) {
          setMine((m) => (m ? { ...m, phase: "done", result: { status: "refused", reason: why } } : m));
        } else {
          patchRequest(msg.rfqId, { state: "closed", note: why });
        }
      };
      try {
        const my = mineRef.current?.rfqId === msg.rfqId ? mineRef.current : null;
        const incoming = requestsRef.current.find((r) => r.rfqId === msg.rfqId) ?? null;
        const marketId = my?.marketId ?? incoming?.marketId;
        const outcome = my?.outcome ?? incoming?.outcome;
        const size = my?.size ?? incoming?.size;
        const chain = markets.find((v) => v.meta.idHex === marketId)?.chain;
        if (!me || !chain || outcome === undefined || size === undefined || !usdcMint || !wallet.signTransaction) {
          return refuse("Could not check the swap, so nothing was signed.");
        }
        const role = msg.role;
        const price = my
          ? my.accepted?.side === "buy"
            ? my.bestAsk
            : my.bestBid
          : role === "seller"
            ? incoming?.sent?.ask
            : incoming?.sent?.bid;
        const value = price ? swapValue(size, price) : null;
        const checks =
          price !== null &&
          price !== undefined &&
          value !== null &&
          (role === "buyer" ? t.buyer === me : t.seller === me) &&
          (my ? t.requester === me && (my.accepted?.side === "buy") === (role === "buyer") : t.requester !== me) &&
          t.marketId === marketId &&
          t.outcome === outcome &&
          BigInt(t.size) === size &&
          BigInt(t.priceE6) === price &&
          BigInt(t.value) === value &&
          t.shareMint === outcomeMintPda(chain.address, outcome).toBase58() &&
          t.usdcMint === usdcMint.toBase58() &&
          t.treasuryVault === treasuryPda().toBase58() &&
          BigInt(t.fee) <= secondaryFee(value, 50) &&
          // A buying requester gets the shares where they asked; a buying quoter at their own wallet.
          (role !== "buyer" || t.receiver === (my ? (my.accepted?.receiver ?? me) : me));
        const tx = Transaction.from(Uint8Array.from(atob(msg.tx), (c) => c.charCodeAt(0)));
        if (!checks || !swapTxMatches(tx, t)) {
          return refuse("The server asked for a signature on something other than the agreed swap. Nothing was signed.");
        }
        if (my) setMine((m) => (m ? { ...m, phase: "signing", signBy: msg.signBy } : m));
        else patchRequest(msg.rfqId, { state: "signing" });
        const signedTx = await wallet.signTransaction(tx);
        send({ t: "signed", rfqId: msg.rfqId, tx: toB64(signedTx.serialize({ requireAllSignatures: false, verifySignatures: false })) });
      } catch (e) {
        refuse(/reject/i.test((e as Error).message) ? "You declined to sign, so the swap was cancelled." : `Signing failed: ${(e as Error).message}`);
      }
    },
    [send],
  );

  const onMessage = useCallback(
    (msg: RfqServerMsg) => {
      switch (msg.t) {
        case "ready":
          setStatus("ready");
          setError(null);
          setStats({ fillRate: msg.fillRate, cooldownUntil: msg.cooldownUntil });
          setMinSize(BigInt(msg.minSize));
          break;
        case "quoter_status":
          setQuoting((q) => {
            const next = new Set(q);
            if (msg.on) next.add(msg.marketId);
            else next.delete(msg.marketId);
            return next;
          });
          setQuoterNote(null);
          break;
        case "rfq_open":
          setMine((m) => (m ? { ...m, rfqId: msg.rfqId, phase: "quoting", expiresAt: msg.expiresAt, quoters: msg.quoters } : m));
          break;
        case "rfq_quotes":
          setMine((m) =>
            m && m.rfqId === msg.rfqId
              ? { ...m, phase: "deciding", bestBid: msg.bestBid ? BigInt(msg.bestBid) : null, bestAsk: msg.bestAsk ? BigInt(msg.bestAsk) : null, decideBy: msg.decideBy }
              : m,
          );
          break;
        case "rfq_request":
          setRequests((rs) => [
            { rfqId: msg.rfqId, marketId: msg.marketId, outcome: msg.outcome, size: BigInt(msg.size), expiresAt: msg.expiresAt, sent: null, state: "open" as const },
            ...rs.filter((r) => r.rfqId !== msg.rfqId),
          ].slice(0, 20));
          break;
        case "rfq_closed":
          patchRequest(msg.rfqId, { state: "closed" });
          break;
        case "sign_request":
          void handleSignRequest(msg);
          break;
        case "rfq_done":
          if (mineRef.current && (mineRef.current.rfqId === msg.rfqId || mineRef.current.rfqId === null)) {
            setMine((m) =>
              m && m.result?.status !== "refused"
                ? { ...m, rfqId: msg.rfqId, phase: "done", result: { status: msg.status, ...(msg.signature ? { signature: msg.signature } : {}), ...(msg.reason ? { reason: msg.reason } : {}) } }
                : m,
            );
            if (live.current.me) {
              void fetch(`${RFQ_URL}/stats/${live.current.me}`)
                .then((r) => r.json())
                .then((s: { fillRate: number; cooldownUntil: number | null }) => setStats(s))
                .catch(() => undefined);
            }
          } else {
            patchRequest(msg.rfqId, msg.status === "filled" ? { state: "filled", note: msg.signature } : { state: "closed", ...(msg.reason ? { note: msg.reason } : {}) });
          }
          break;
        case "fill":
          setLastFill(msg.fill);
          setFillTick((n) => n + 1);
          break;
        case "error":
          if (mineRef.current && (msg.rfqId === mineRef.current.rfqId || mineRef.current.phase === "sending")) {
            // An error on our own request: show it there. "no_quote" leaves the request open.
            if (msg.code === "no_quote" || msg.code === "too_early") setError(msg.message);
            else setMine((m) => (m ? { ...m, phase: "done", result: { status: "failed", reason: msg.message } } : m));
          } else if (msg.rfqId) {
            patchRequest(msg.rfqId, { state: "open", sent: null, note: msg.message });
          } else if (["not_a_holder", "cooldown", "market_settled", "unknown_market"].includes(msg.code)) {
            setQuoterNote(msg.message);
          } else {
            setError(msg.message);
          }
          break;
      }
    },
    [handleSignRequest],
  );

  const leave = useCallback(() => {
    ws.current?.close();
    ws.current = null;
    setStatus("off");
    setQuoting(new Set());
    setRequests([]);
    setMine(null);
  }, []);

  const join = useCallback(async () => {
    const { wallet, me } = live.current;
    if (!me || !wallet.signMessage) {
      setStatus("error");
      setError("This wallet cannot sign messages, which the secondary market needs to prove who you are.");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      const ts = Date.now();
      const sig = await wallet.signMessage(rfqHelloMessage(me, ts));
      const socket = new WebSocket(wsUrl());
      ws.current = socket;
      socket.onopen = () => socket.send(JSON.stringify({ t: "hello", wallet: me, ts, sig: toB64(sig) } satisfies RfqClientMsg));
      socket.onmessage = (ev) => onMessage(JSON.parse(String(ev.data)) as RfqServerMsg);
      socket.onerror = () => {
        setStatus("error");
        setError("Cannot reach the secondary market service.");
      };
      socket.onclose = () => {
        if (ws.current === socket) {
          ws.current = null;
          setStatus((s) => (s === "error" ? s : "off"));
          setQuoting(new Set());
        }
      };
    } catch (e) {
      setStatus("error");
      setError(/reject/i.test((e as Error).message) ? "You declined to sign in." : (e as Error).message);
    }
  }, [onMessage]);

  // A different wallet means a different identity: drop the old session.
  useEffect(() => leave, [me, leave]);

  const quoterOn = useCallback(
    async (marketId: string, minFillRate: number) => {
      const { wallet, me } = live.current;
      if (!me || !wallet.signMessage) return;
      try {
        const ts = Date.now();
        const sig = await wallet.signMessage(rfqQuoterMessage(marketId, me, ts));
        send({ t: "quoter_on", marketId, ts, sig: toB64(sig), minFillRate });
      } catch (e) {
        setQuoterNote(/reject/i.test((e as Error).message) ? "You declined to sign the opt-in." : (e as Error).message);
      }
    },
    [send],
  );

  const value = useMemo<RfqContext>(
    () => ({
      status,
      error,
      fillRate: stats?.fillRate ?? null,
      cooldownUntil: stats?.cooldownUntil ?? null,
      minSize,
      quoting,
      quoterNote,
      mine,
      requests,
      fillTick,
      lastFill,
      join,
      leave,
      quoterOn,
      quoterOff: (marketId) => send({ t: "quoter_off", marketId }),
      request: (marketId, outcome, size) => {
        setError(null);
        setMine({ rfqId: null, marketId, outcome, size, phase: "sending", quoters: 0, expiresAt: null, decideBy: null, signBy: null, bestBid: null, bestAsk: null, accepted: null, result: null });
        send({ t: "rfq", marketId, outcome, size: size.toString() });
      },
      accept: (side, receiver) => {
        const m = mineRef.current;
        if (!m?.rfqId) return;
        setError(null);
        setMine({ ...m, accepted: { side, receiver } });
        mineRef.current = { ...m, accepted: { side, receiver } };
        send({ t: "accept", rfqId: m.rfqId, side, ...(receiver ? { receiver } : {}) });
      },
      walk: () => {
        const m = mineRef.current;
        if (m?.rfqId) send({ t: "walk", rfqId: m.rfqId });
      },
      clearMine: () => setMine(null),
      sendQuote: (rfqId, bid, ask) => {
        patchRequest(rfqId, { sent: { bid, ask }, state: "sent", note: undefined });
        requestsRef.current = requestsRef.current.map((r) => (r.rfqId === rfqId ? { ...r, sent: { bid, ask }, state: "sent" as const } : r));
        send({ t: "quote", rfqId, ...(bid !== null ? { bid: bid.toString() } : {}), ...(ask !== null ? { ask: ask.toString() } : {}) });
      },
      dismissRequest: (rfqId) => setRequests((rs) => rs.filter((r) => r.rfqId !== rfqId)),
    }),
    [status, error, stats, minSize, quoting, quoterNote, mine, requests, fillTick, lastFill, join, leave, quoterOn, send],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRfq(): RfqContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRfq must be used inside RfqProvider");
  return ctx;
}

/** Public tape for one market: recent fills and the last price per outcome. No sign-in needed. */
export function useTape(marketId: string | undefined, tick: number) {
  const [tape, setTape] = useState<RfqFill[]>([]);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    if (!marketId) return;
    let live = true;
    const load = () =>
      fetch(`${RFQ_URL}/tape?market=${marketId}&limit=50`)
        .then((r) => r.json())
        .then((t: RfqFill[]) => {
          if (live) {
            setTape(t);
            setAvailable(true);
          }
        })
        .catch(() => live && setAvailable(false));
    void load();
    const timer = setInterval(load, 12_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [marketId, tick]);
  return { tape, available };
}
