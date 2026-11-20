"use client";

import { MathError, UNIT, buyIxs, priceE6, quoteBuy, payoutRateE12, redeemValue, type BuyQuote } from "@pmec/sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useMemo, useState } from "react";
import { type MarketView, useData } from "@/lib/data";
import { explorerTx } from "@/lib/env";
import { fmtPct, fmtPrice, fmtShares, fmtUsdc, parseAmount, toNumber } from "@/lib/format";
import { explainError, sendIxs } from "@/lib/tx";
import { SellSlip } from "./SellSlip";

const SLIPPAGE_CHOICES = [0.1, 0.5, 1, 3];

const MATH_MESSAGES: Record<string, string> = {
  ZeroAmount: "That amount is too small to buy a share.",
  PotCapExceeded: "That buy would push the pot over its cap.",
};

/** Buy and Sell tabs for one outcome. */
export function TradeSlip({ view, outcome }: { view: MarketView; outcome: number }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  return (
    <aside className="slip" aria-label="Trade with the pool">
      <div className="seg slip-tabs" role="tablist" aria-label="Buy or sell">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={side === s} className={side === s ? "on" : undefined} onClick={() => setSide(s)}>
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      {side === "buy" ? <BuySlip view={view} outcome={outcome} /> : <SellSlip view={view} outcome={outcome} />}
      <p className="slip-foot">
        Buy new shares from the pool, or sell them back to it at any time while the market is open. A sale returns what your
        shares added to the pool, minus a 2% fee that stays in the pot for the holders who remain.
      </p>
    </aside>
  );
}

/** The buy panel: USDC in, shares out, and the guaranteed minimum those shares pay if the outcome wins. */
export function BuySlip({ view, outcome }: { view: MarketView; outcome: number }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { program, usdcMint, config, usdc, refresh, refreshWallet } = useData();
  const [text, setText] = useState("100");
  const [slippage, setSlippage] = useState(0.5);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: { sig: string; shares: bigint } | null }>({
    busy: false,
    error: null,
    done: null,
  });

  const m = view.chain;
  const feeBps = config?.poolFeeBps ?? 100;
  const usdcIn = parseAmount(text);
  const label = view.meta.outcomes[outcome] ?? `Outcome ${outcome}`;

  const { quote, quoteError } = useMemo((): { quote: BuyQuote | null; quoteError: string | null } => {
    if (!m || usdcIn === null || usdcIn === 0n) return { quote: null, quoteError: null };
    try {
      return { quote: quoteBuy(m.q, m.pot, outcome, usdcIn, feeBps), quoteError: null };
    } catch (e) {
      const code = e instanceof MathError ? e.code : "";
      return { quote: null, quoteError: MATH_MESSAGES[code] ?? "That amount cannot be priced." };
    }
  }, [m, usdcIn, outcome, feeBps]);

  if (!m) return null;

  const open = m.status === "open";
  const priceBefore = priceE6(m.q, outcome);
  const floor = quote ? quote.shares : 0n; // 1 USDC per share, so the floor in USDC equals the share count
  const payoutNow = quote ? redeemValue(quote.shares, payoutRateE12(quote.potAfter, quote.qAfter[outcome]!)) : 0n;
  const avgAllIn = quote && usdcIn ? Number(usdcIn) / Number(quote.shares) : null;
  const impact = quote ? Number(quote.priceAfterE6) / Number(priceBefore) - 1 : null;
  const minShares = quote ? (quote.shares * BigInt(Math.round((100 - slippage) * 1000))) / 100_000n : 0n;
  // With the fee on top, the all-in cost can exceed 1 USDC a share when the pool price is above ~0.99.
  const aboveFloor = quote !== null && usdcIn !== null && usdcIn > quote.shares;
  const notEnough = usdc !== null && usdcIn !== null && usdcIn > usdc;

  const scale = quote && usdcIn ? Math.max(toNumber(usdcIn), toNumber(payoutNow), toNumber(floor)) : 1;
  const width = (units: bigint) => `${Math.max(2, (toNumber(units) / scale) * 100)}%`;

  const buy = async () => {
    if (!quote || !usdcIn || !wallet.publicKey || !usdcMint) return;
    setState({ busy: true, error: null, done: null });
    try {
      const ixs = await buyIxs(program, {
        buyer: wallet.publicKey,
        market: m.address,
        usdcMint,
        outcome,
        usdcIn,
        minSharesOut: minShares,
      });
      const sig = await sendIxs(connection, wallet, ixs);
      setState({ busy: false, error: null, done: { sig, shares: quote.shares } });
      await Promise.all([refresh(), refreshWallet()]);
    } catch (e) {
      setState({ busy: false, error: explainError(e), done: null });
    }
  };

  return (
    <div aria-label="Buy from the pool">
      <div className="slip-head">
        <h2>Buy {label}</h2>
        <p>
          New shares from the pool at {fmtPrice(priceBefore)} USDC each ({fmtPct(Number(priceBefore * priceBefore) / 1e12)} implied).
        </p>
      </div>

      <label className="field">
        <span>You spend</span>
        <div className="input-row">
          <input
            inputMode="decimal"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setState((s) => ({ ...s, error: null, done: null }));
            }}
            aria-invalid={usdcIn === null}
            disabled={!open}
          />
          <span className="unit">USDC</span>
        </div>
        <div className="quick">
          {[25, 100, 500, 2500].map((v) => (
            <button key={v} type="button" onClick={() => setText(String(v))} disabled={!open}>
              {v.toLocaleString()}
            </button>
          ))}
        </div>
      </label>

      {usdcIn === null && <p className="msg msg-error">Enter an amount in USDC, like 100 or 12.50.</p>}
      {quoteError && <p className="msg msg-error">{quoteError}</p>}

      {quote && usdcIn !== null && (
        <>
          <dl className="slip-lines">
            <div>
              <dt>You get</dt>
              <dd>
                <span className="num">{fmtShares(quote.shares)}</span> shares
              </dd>
            </div>
            <div>
              <dt>Average price, fee included</dt>
              <dd>
                <span className="num">{avgAllIn!.toFixed(3)}</span> USDC a share
              </dd>
            </div>
            <div>
              <dt>Pool fee ({(feeBps / 100).toFixed(feeBps % 100 ? 2 : 0)}%)</dt>
              <dd>
                <span className="num">{fmtUsdc(quote.fee)}</span> USDC
              </dd>
            </div>
            <div>
              <dt>Price impact</dt>
              <dd>
                <span className="num">+{(impact! * 100).toFixed(2)}%</span>, to {fmtPrice(quote.priceAfterE6)}
              </dd>
            </div>
          </dl>

          <div className="floor" role="group" aria-label="What this pays if it wins">
            <p className="floor-title">If {label} wins</p>
            <div className="floor-row">
              <span className="floor-label">You pay</span>
              <span className="floor-bar bar-cost" style={{ width: width(usdcIn) }} />
              <span className="num">{fmtUsdc(usdcIn)}</span>
            </div>
            <div className="floor-row floor-guarantee">
              <span className="floor-label">Pays at least</span>
              <span className="floor-bar bar-floor" style={{ width: width(floor) }} />
              <span className="num">{fmtUsdc(floor)}</span>
            </div>
            <div className="floor-row">
              <span className="floor-label">Pays today</span>
              <span className="floor-bar bar-now" style={{ width: width(payoutNow) }} />
              <span className="num">{fmtUsdc(payoutNow)}</span>
            </div>
            <p className="floor-note">
              Every winning share pays at least 1 USDC, whatever anyone buys after you. “Pays today” is the payout if the market
              resolved right now; later buying can lower it, but never below the guaranteed line.
            </p>
          </div>

          {aboveFloor && (
            <p className="msg msg-warn">
              At this price the 1% fee takes your all-in cost to {avgAllIn!.toFixed(4)} USDC a share, just above the 1 USDC a share
              guarantee. You could get back slightly less than you pay even if {label} wins.
            </p>
          )}
        </>
      )}

      <div className="field slippage">
        <span id="slip-label">Slippage limit</span>
        <div className="seg" role="radiogroup" aria-labelledby="slip-label">
          {SLIPPAGE_CHOICES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={slippage === s} className={slippage === s ? "on" : undefined} onClick={() => setSlippage(s)}>
              {s}%
            </button>
          ))}
        </div>
        {quote && <small>The buy is cancelled if you would get fewer than {fmtShares(minShares)} shares.</small>}
      </div>

      {!open ? (
        <p className="msg">Buying is closed: this market is {m.status}.</p>
      ) : !wallet.publicKey ? (
        <p className="msg">Connect a wallet to buy. The burner wallet works without installing anything.</p>
      ) : (
        <button className="btn btn-primary btn-block" onClick={buy} disabled={!quote || state.busy || notEnough}>
          {state.busy ? "Buying…" : notEnough ? "Not enough USDC" : `Buy ${quote ? fmtShares(quote.shares) : ""} shares`}
        </button>
      )}
      {notEnough && wallet.publicKey && <p className="msg">Use “Get test USDC” in the wallet menu to top up.</p>}
      {state.error && <p className="msg msg-error" role="alert">{state.error}</p>}
      {state.done && (
        <p className="msg msg-ok" role="status">
          Bought {fmtShares(state.done.shares)} shares of {label}. They pay at least {fmtUsdc(state.done.shares)} USDC if it wins.{" "}
          <a href={explorerTx(state.done.sig)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      )}
    </div>
  );
}

/** Kept here so the page can show the same floor wording elsewhere. */
export const FLOOR_PER_SHARE = UNIT;
