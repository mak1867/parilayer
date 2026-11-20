"use client";

import { UNIT, outcomeMintPda, priceE6, secondaryFee, swapValue } from "@parilayer/sdk";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { type MarketView, useData } from "@/lib/data";
import { RFQ_URL, explorerTx } from "@/lib/env";
import { fmtPrice, fmtShares, fmtUsdc, parseAmount } from "@/lib/format";
import { type IncomingRequest, useRfq } from "@/lib/rfq";

/** Seconds left until `deadline` (ms), ticking. */
function useCountdown(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [deadline]);
  return deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** "0.790" typed by a person -> base units per share, or null. */
const parsePrice = (text: string) => parseAmount(text);

function isAddress(text: string): boolean {
  try {
    new PublicKey(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trade existing shares with other traders: a private request for quotes,
 * settled as one transaction both sides sign. Nobody sees the request but the
 * quoters, and the pool's odds do not move.
 */
export function SecondaryPanel({ view, outcome }: { view: MarketView; outcome: number }) {
  const wallet = useWallet();
  const { config, tokens, refresh, refreshWallet } = useData();
  const rfq = useRfq();
  const m = view.chain;
  const marketId = view.meta.idHex;
  const label = view.meta.outcomes[outcome] ?? `Outcome ${outcome}`;
  const [sizeText, setSizeText] = useState("100");
  const [fresh, setFresh] = useState(false);
  const [receiver, setReceiver] = useState("");
  const [online, setOnline] = useState<number | null>(null);
  const [minFill, setMinFill] = useState(0);

  const mine = rfq.mine && rfq.mine.marketId === marketId ? rfq.mine : null;
  const quoteLeft = useCountdown(mine?.phase === "quoting" ? mine.expiresAt : null);
  const decideLeft = useCountdown(mine?.phase === "deciding" ? mine.decideBy : null);
  const signLeft = useCountdown(mine?.phase === "signing" ? mine.signBy : null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`${RFQ_URL}/quoters?market=${marketId}`)
        .then((r) => r.json())
        .then((d: { online: number }) => live && setOnline(d.online))
        .catch(() => live && setOnline(null));
    void load();
    const t = setInterval(load, 8_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [marketId, rfq.quoting]);

  // After a fill of ours, balances changed.
  const filledSig = mine?.result?.status === "filled" ? mine.result.signature : undefined;
  useEffect(() => {
    if (filledSig) void Promise.all([refresh(), refreshWallet()]);
  }, [filledSig, refresh, refreshWallet]);

  if (!m) return null;
  const tradable = m.status === "open" || m.status === "halted";
  const size = parseAmount(sizeText);
  const sizeOk = size !== null && size >= rfq.minSize;
  const feeBps = 50;
  const myShares = tokens.get(outcomeMintPda(m.address, outcome).toBase58()) ?? 0n;
  const holdsAny = Array.from({ length: m.n }, (_, i) => tokens.get(outcomeMintPda(m.address, i).toBase58()) ?? 0n).some((b) => b > 0n);
  const isQuoting = rfq.quoting.has(marketId);
  const incoming = rfq.requests.filter((r) => r.marketId === marketId);
  const inCooldown = rfq.cooldownUntil !== null && rfq.cooldownUntil > Date.now();

  return (
    <aside className="slip" aria-label="Trade with other traders">
      <div className="slip-head">
        <h2>Trade {label} with traders</h2>
        <p>
          Existing shares change hands here. Your request goes privately to quoters; the pool’s odds do not move, and the trade is
          only public once it has settled.
        </p>
      </div>

      {!tradable && <p className="msg">This market is {m.status}; its shares no longer trade.</p>}

      {tradable && !wallet.publicKey && <p className="msg">Connect a wallet to request quotes or to quote.</p>}

      {tradable && wallet.publicKey && rfq.status !== "ready" && (
        <>
          <button className="btn btn-primary btn-block" onClick={() => void rfq.join()} disabled={rfq.status === "connecting"}>
            {rfq.status === "connecting" ? "Signing in…" : "Sign in to the secondary market"}
          </button>
          <p className="floor-note">Signing in means signing a short message with your wallet. It costs nothing and moves nothing.</p>
          {rfq.error && <p className="msg msg-error" role="alert">{rfq.error}</p>}
        </>
      )}

      {tradable && wallet.publicKey && rfq.status === "ready" && (
        <>
          {inCooldown && (
            <p className="msg msg-warn">
              This wallet is in a cooldown after 3 unsigned trades in an hour. It ends in{" "}
              {Math.ceil((rfq.cooldownUntil! - Date.now()) / 60000)} minutes.
            </p>
          )}

          {/* ---------------- requester ---------------- */}
          {(!mine || mine.phase === "done") && (
            <>
              <label className="field">
                <span>Shares of {label}</span>
                <div className="input-row">
                  <input inputMode="decimal" value={sizeText} onChange={(e) => setSizeText(e.target.value)} aria-invalid={!sizeOk} />
                  <span className="unit">shares</span>
                </div>
              </label>
              {!sizeOk && <p className="msg msg-error">The smallest request is {fmtShares(rfq.minSize)} shares.</p>}
              <button
                className="btn btn-primary btn-block"
                disabled={!sizeOk || inCooldown}
                onClick={() => size !== null && rfq.request(marketId, outcome, size)}
              >
                Request quotes
              </button>
              <p className="floor-note">
                Quoters see the outcome and the size. They do not see who is asking or whether you want to buy or sell.{" "}
                {online === null ? "" : online === 0 ? "No quoters are online for this market right now." : `${online} quoter${online === 1 ? "" : "s"} online.`}{" "}
                You hold {fmtShares(myShares)} shares of {label}.
              </p>
            </>
          )}

          {mine && mine.phase === "sending" && <p className="msg">Sending your request…</p>}

          {mine && mine.phase === "quoting" && (
            <div className="rfq-box" role="status">
              <p className="rfq-count">
                <span className="num">{quoteLeft}</span> s
              </p>
              <p>
                Collecting quotes for {fmtShares(mine.size)} shares of {view.meta.outcomes[mine.outcome]} from {mine.quoters} quoter
                {mine.quoters === 1 ? "" : "s"}. You will see the best bid and the best ask when the time is up.
              </p>
              <button className="btn btn-quiet" onClick={rfq.walk}>
                Cancel request
              </button>
            </div>
          )}

          {mine && mine.phase === "deciding" && (
            <div className="rfq-box">
              <p className="rfq-title">
                Best quotes for {fmtShares(mine.size)} shares of {view.meta.outcomes[mine.outcome]}
              </p>
              <Side
                kind="buy"
                price={mine.bestAsk}
                size={mine.size}
                feeBps={feeBps}
                onPick={() => rfq.accept("buy", fresh && isAddress(receiver) ? receiver : null)}
                disabled={fresh && !isAddress(receiver)}
              />
              <Side kind="sell" price={mine.bestBid} size={mine.size} feeBps={feeBps} onPick={() => rfq.accept("sell", null)} disabled={myShares < mine.size} />
              {mine.bestBid !== null && myShares < mine.size && (
                <p className="floor-note">You hold {fmtShares(myShares)} shares, fewer than this request, so you cannot sell here.</p>
              )}

              {mine.bestAsk !== null && (
                <div className="field">
                  <label className="check">
                    <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> Send bought shares to a
                    different address
                  </label>
                  {fresh && (
                    <>
                      <input
                        className="text-input"
                        placeholder="Solana address that should receive the shares"
                        value={receiver}
                        onChange={(e) => setReceiver(e.target.value.trim())}
                        aria-invalid={receiver !== "" && !isAddress(receiver)}
                      />
                      <small>Use a fresh address if you do not want this purchase tied to your main wallet’s balance.</small>
                    </>
                  )}
                </div>
              )}

              {rfq.error && <p className="msg msg-error" role="alert">{rfq.error}</p>}
              <p className="floor-note">
                <span className="num">{decideLeft}</span> s to choose. Picking a side and then not signing within 30 seconds counts
                against this wallet.
              </p>
              <button className="btn btn-quiet" onClick={rfq.walk}>
                Walk away
              </button>
            </div>
          )}

          {mine && mine.phase === "signing" && (
            <div className="rfq-box" role="status">
              <p className="rfq-title">Sign the swap in your wallet</p>
              <p>
                The transaction was checked against what you agreed: {mine.accepted?.side === "buy" ? "buy" : "sell"}{" "}
                {fmtShares(mine.size)} shares at {fmtPrice(mine.accepted?.side === "buy" ? mine.bestAsk : mine.bestBid)} USDC. It
                settles when both sides have signed, all at once or not at all. <span className="num">{signLeft}</span> s left.
              </p>
            </div>
          )}

          {mine && mine.phase === "done" && mine.result && (
            <Result mine={mine} label={view.meta.outcomes[mine.outcome] ?? ""} onClear={rfq.clearMine} />
          )}

          {/* ---------------- quoter ---------------- */}
          <div className="quoter">
            <label className="check">
              <input
                type="checkbox"
                checked={isQuoting}
                onChange={(e) => (e.target.checked ? void rfq.quoterOn(marketId, minFill) : rfq.quoterOff(marketId))}
                disabled={!holdsAny && !isQuoting}
              />{" "}
              Quote this market
            </label>
            <small>
              {holdsAny
                ? "Holders can answer other traders’ requests with a bid, an ask, or both. Opting in means signing a message; your share balance is checked on-chain."
                : "Only holders can quote. Buy shares in this market first."}
            </small>
            {!isQuoting && holdsAny && (
              <label className="field inline">
                <span>Only answer requesters who complete at least</span>
                <select value={minFill} onChange={(e) => setMinFill(Number(e.target.value))}>
                  <option value={0}>any share of their requests</option>
                  <option value={0.5}>half of their requests</option>
                  <option value={0.8}>80% of their requests</option>
                </select>
              </label>
            )}
            {rfq.quoterNote && <p className="msg msg-error">{rfq.quoterNote}</p>}
            {isQuoting && incoming.length === 0 && <p className="msg">Quoting is on. Requests appear here and give you 10 seconds to answer.</p>}
            {incoming.map((r) => (
              <QuoteCard key={r.rfqId} r={r} view={view} />
            ))}
          </div>

          <p className="slip-foot">
            Your fill rate: {rfq.fillRate === null ? "–" : `${Math.round(rfq.fillRate * 100)}%`} of quoted requests completed.
            Quoters can choose not to answer wallets that rarely complete.
          </p>
        </>
      )}
    </aside>
  );
}

/** One side of the decision: the price, what it costs or pays, and the floor it implies. */
function Side({
  kind,
  price,
  size,
  feeBps,
  onPick,
  disabled,
}: {
  kind: "buy" | "sell";
  price: bigint | null;
  size: bigint;
  feeBps: number;
  onPick: () => void;
  disabled?: boolean;
}) {
  if (price === null) {
    return <p className="side side-empty">{kind === "buy" ? "Nobody offered to sell." : "Nobody bid to buy."}</p>;
  }
  const value = swapValue(size, price);
  const fee = secondaryFee(value, feeBps);
  const aboveFloor = kind === "buy" && price > UNIT;
  return (
    <div className="side">
      <div className="side-head">
        <span>{kind === "buy" ? "Best ask: you can buy at" : "Best bid: you can sell at"}</span>
        <span className="num big">{fmtPrice(price)}</span>
      </div>
      <p className="side-lines">
        {kind === "buy" ? (
          <>
            You pay {fmtUsdc(value + fee)} USDC ({fmtUsdc(value)} plus a {fmtUsdc(fee)} fee). If it wins these shares pay at least{" "}
            <span className="floor-num num">{fmtUsdc(size)}</span> USDC
            {!aboveFloor && <>, {(Number(UNIT) / Number(price)).toFixed(2)} times the price</>}.
          </>
        ) : (
          <>
            You receive {fmtUsdc(value - fee)} USDC ({fmtUsdc(value)} minus a {fmtUsdc(fee)} fee).
          </>
        )}
      </p>
      {aboveFloor && (
        <p className="msg msg-warn">
          This ask is above 1 USDC a share. A winning share is only guaranteed to pay 1 USDC, so at this price you can lose money
          even if you are right. It only pays off if the pot stays large enough.
        </p>
      )}
      <button className="btn btn-primary btn-block" onClick={onPick} disabled={disabled}>
        {kind === "buy" ? `Buy ${fmtShares(size)} at ${fmtPrice(price)}` : `Sell ${fmtShares(size)} at ${fmtPrice(price)}`}
      </button>
    </div>
  );
}

function Result({ mine, label, onClear }: { mine: NonNullable<ReturnType<typeof useRfq>["mine"]>; label: string; onClear: () => void }) {
  const r = mine.result!;
  const side = mine.accepted?.side;
  const price = side === "buy" ? mine.bestAsk : mine.bestBid;
  if (r.status === "filled") {
    return (
      <p className="msg msg-ok" role="status">
        {side === "buy" ? "Bought" : "Sold"} {fmtShares(mine.size)} shares of {label} at {fmtPrice(price)} USDC.{" "}
        {r.signature && (
          <a href={explorerTx(r.signature)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        )}{" "}
        <button className="link" onClick={onClear}>
          Dismiss
        </button>
      </p>
    );
  }
  const text: Record<string, string> = {
    no_quoters: "No quoters are online for this market right now. Try again later, or buy from the pool.",
    expired: r.reason ?? "The request expired.",
    walked: "You walked away. Nothing was traded.",
    failed: r.reason ?? "The swap did not settle. Nothing moved.",
    refused: r.reason ?? "Nothing was signed.",
  };
  return (
    <p className={`msg ${r.status === "walked" || r.status === "no_quoters" ? "" : "msg-error"}`} role="status">
      {text[r.status]}{" "}
      <button className="link" onClick={onClear}>
        Dismiss
      </button>
    </p>
  );
}

/** A request this wallet may quote: bid, ask or both, within the countdown. */
function QuoteCard({ r, view }: { r: IncomingRequest; view: MarketView }) {
  const rfq = useRfq();
  const { tokens, usdc } = useData();
  const m = view.chain!;
  const pool = priceE6(m.q, r.outcome);
  const [bid, setBid] = useState(() => (Number((pool * 97n) / 100n) / 1e6).toFixed(3));
  const [ask, setAsk] = useState(() => (Number(pool) / 1e6).toFixed(3));
  const left = useCountdown(r.state === "open" ? r.expiresAt : null);
  const label = view.meta.outcomes[r.outcome];
  const shares = tokens.get(outcomeMintPda(m.address, r.outcome).toBase58()) ?? 0n;

  const bidP = bid.trim() === "" ? null : parsePrice(bid);
  const askP = ask.trim() === "" ? null : parsePrice(ask);
  const canAsk = shares >= r.size;
  const canBid = bidP !== null && usdc !== null && usdc >= swapValue(r.size, bidP);
  const crossed = bidP !== null && askP !== null && canAsk && bidP >= askP;

  if (r.state !== "open") {
    return (
      <div className="quote-card done">
        <p>
          {fmtShares(r.size)} shares of {label}:{" "}
          {r.state === "sent" && `quote sent (bid ${fmtPrice(r.sent?.bid)}, ask ${fmtPrice(r.sent?.ask)}). Waiting for the requester.`}
          {r.state === "signing" && "your quote was taken. Sign the swap in your wallet."}
          {r.state === "filled" && "filled."}
          {r.state === "closed" && (r.note ?? "closed without trading with you.")}{" "}
          {r.state === "filled" && r.note && (
            <a href={explorerTx(r.note)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}{" "}
          {(r.state === "filled" || r.state === "closed") && (
            <button className="link" onClick={() => rfq.dismissRequest(r.rfqId)}>
              Dismiss
            </button>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="quote-card">
      <p className="rfq-title">
        Someone wants a quote: {fmtShares(r.size)} shares of {label}. <span className="num">{left}</span> s left
      </p>
      <div className="quote-inputs">
        <label>
          <span>Your bid (you buy at)</span>
          <input inputMode="decimal" value={bid} onChange={(e) => setBid(e.target.value)} />
        </label>
        <label>
          <span>Your ask (you sell at)</span>
          <input inputMode="decimal" value={ask} onChange={(e) => setAsk(e.target.value)} disabled={!canAsk} />
        </label>
      </div>
      <small>
        Pool price is {fmtPrice(pool)}. {canAsk ? "" : `You hold ${fmtShares(shares)} shares, so you can only bid. `}
        {r.note ?? ""}
      </small>
      {crossed && <p className="msg msg-error">Your bid must be below your ask.</p>}
      <button
        className="btn btn-primary btn-block"
        disabled={left === 0 || crossed || ((!canBid || bidP === null) && (!canAsk || askP === null))}
        onClick={() => rfq.sendQuote(r.rfqId, canBid ? bidP : null, canAsk ? askP : null)}
      >
        Send quote
      </button>
    </div>
  );
}
