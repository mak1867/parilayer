"use client";

import { MathError, outcomeMintPda, priceE6, quoteSell, sellIxs, seedSharesPda, type SellQuote } from "@parilayer/sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { type MarketView, useData } from "@/lib/data";
import { explorerTx } from "@/lib/env";
import { fmtPct, fmtPrice, fmtShares, fmtUsdc, parseAmount } from "@/lib/format";
import { explainError, sendIxs } from "@/lib/tx";

/** Base units as an exact decimal string (no rounding), for the input box. */
const exact = (units: bigint) => {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

const SLIPPAGE_CHOICES = [0.1, 0.5, 1, 3];

const MATH_MESSAGES: Record<string, string> = {
  ZeroAmount: "That many shares is worth less than 0.000001 USDC. Sell more.",
  NotEnoughShares: "The pool does not have that many shares outstanding.",
  BelowSeed: "That would sell into the exchange's seed shares.",
};

/**
 * The sell panel: shares in, USDC out. Selling runs the pool's buy formula in
 * reverse; a 2% fee stays in the pot for the holders who remain.
 */
export function SellSlip({ view, outcome }: { view: MarketView; outcome: number }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { program, usdcMint, config, tokens, refresh, refreshWallet } = useData();
  const [text, setText] = useState("");
  const [slippage, setSlippage] = useState(0.5);
  const [seedFloor, setSeedFloor] = useState<bigint | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: { sig: string; usdc: bigint; shares: bigint } | null }>({
    busy: false,
    error: null,
    done: null,
  });

  const m = view.chain;
  const feeBps = config?.sellFeeBps ?? 200;
  const label = view.meta.outcomes[outcome] ?? `Outcome ${outcome}`;
  const held = m ? (tokens.get(outcomeMintPda(m.address, outcome).toBase58()) ?? 0n) : 0n;
  const shares = text.trim() === "" ? 0n : parseAmount(text);

  // The treasury's seed shares of this outcome: no sell may go below them.
  useEffect(() => {
    if (!m) return;
    let live = true;
    connection
      .getTokenAccountBalance(seedSharesPda(m.address, outcome))
      .then((b) => live && setSeedFloor(BigInt(b.value.amount)))
      .catch(() => live && setSeedFloor(0n));
    return () => {
      live = false;
    };
  }, [connection, m, outcome]);

  const { quote, quoteError } = useMemo((): { quote: SellQuote | null; quoteError: string | null } => {
    if (!m || shares === null || shares === 0n || seedFloor === null) return { quote: null, quoteError: null };
    try {
      return { quote: quoteSell(m.q, m.pot, outcome, shares, feeBps, seedFloor), quoteError: null };
    } catch (e) {
      const code = e instanceof MathError ? e.code : "";
      return { quote: null, quoteError: MATH_MESSAGES[code] ?? "That amount cannot be priced." };
    }
  }, [m, shares, outcome, feeBps, seedFloor]);

  if (!m) return null;

  const open = m.status === "open";
  const priceBefore = priceE6(m.q, outcome);
  const avg = quote && shares ? Number(quote.usdcOut) / Number(shares) : null;
  const impact = quote ? Number(quote.priceAfterE6) / Number(priceBefore) - 1 : null;
  const minOut = quote ? (quote.usdcOut * BigInt(Math.round((100 - slippage) * 1000))) / 100_000n : 0n;
  const tooMany = shares !== null && shares > held;

  const sell = async () => {
    if (!quote || !shares || !wallet.publicKey || !usdcMint) return;
    setState({ busy: true, error: null, done: null });
    try {
      const ixs = await sellIxs(program, {
        seller: wallet.publicKey,
        market: m.address,
        usdcMint,
        outcome,
        shares,
        minUsdcOut: minOut,
      });
      const sig = await sendIxs(connection, wallet, ixs);
      setState({ busy: false, error: null, done: { sig, usdc: quote.usdcOut, shares } });
      setText("");
      await Promise.all([refresh(), refreshWallet()]);
    } catch (e) {
      setState({ busy: false, error: explainError(e), done: null });
    }
  };

  return (
    <div aria-label="Sell back to the pool">
      <div className="slip-head">
        <h2>Sell {label}</h2>
        <p>
          The pool buys your shares back along the same curve, now at {fmtPrice(priceBefore)} USDC a share (
          {fmtPct(Number(priceBefore * priceBefore) / 1e12)} implied), minus a {(feeBps / 100).toFixed(feeBps % 100 ? 2 : 0)}% fee
          that stays in the pot.
        </p>
      </div>

      <label className="field">
        <span>You sell</span>
        <div className="input-row">
          <input
            inputMode="decimal"
            value={text}
            placeholder="0"
            onChange={(e) => {
              setText(e.target.value);
              setState((s) => ({ ...s, error: null, done: null }));
            }}
            aria-invalid={shares === null}
            disabled={!open || held === 0n}
          />
          <span className="unit">shares</span>
        </div>
        <div className="quick">
          {[25, 50, 100].map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => setText(exact((held * BigInt(pct)) / 100n))}
              disabled={!open || held === 0n}
            >
              {pct === 100 ? "All" : `${pct}%`}
            </button>
          ))}
        </div>
        <small>You hold {fmtShares(held)} shares of {label}.</small>
      </label>

      {shares === null && <p className="msg msg-error">Enter a number of shares, like 100 or 12.5.</p>}
      {quoteError && <p className="msg msg-error">{quoteError}</p>}

      {quote && shares && (
        <dl className="slip-lines">
          <div>
            <dt>You get</dt>
            <dd>
              <span className="num">{fmtUsdc(quote.usdcOut)}</span> USDC
            </dd>
          </div>
          <div>
            <dt>Average price, fee included</dt>
            <dd>
              <span className="num">{avg!.toFixed(3)}</span> USDC a share
            </dd>
          </div>
          <div>
            <dt>Sell fee ({(feeBps / 100).toFixed(feeBps % 100 ? 2 : 0)}%, stays in the pot)</dt>
            <dd>
              <span className="num">{fmtUsdc(quote.fee)}</span> USDC
            </dd>
          </div>
          <div>
            <dt>Price impact</dt>
            <dd>
              <span className="num">{(impact! * 100).toFixed(2)}%</span>, to {fmtPrice(quote.priceAfterE6)}
            </dd>
          </div>
        </dl>
      )}

      <div className="field slippage">
        <span id="sell-slip-label">Slippage limit</span>
        <div className="seg" role="radiogroup" aria-labelledby="sell-slip-label">
          {SLIPPAGE_CHOICES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={slippage === s} className={slippage === s ? "on" : undefined} onClick={() => setSlippage(s)}>
              {s}%
            </button>
          ))}
        </div>
        {quote && <small>The sale is cancelled if you would get less than {fmtUsdc(minOut)} USDC.</small>}
      </div>

      {!open ? (
        <p className="msg">Selling is closed: this market is {m.status}. {m.status === "halted" ? "Gemini has paused trading." : ""}</p>
      ) : !wallet.publicKey ? (
        <p className="msg">Connect a wallet to sell.</p>
      ) : held === 0n ? (
        <p className="msg">You hold no shares of {label} yet. Buy some first.</p>
      ) : (
        <button className="btn btn-primary btn-block" onClick={sell} disabled={!quote || state.busy || tooMany}>
          {state.busy ? "Selling…" : tooMany ? "You don't hold that many" : `Sell for ${quote ? fmtUsdc(quote.usdcOut) : ""} USDC`}
        </button>
      )}
      {state.error && <p className="msg msg-error" role="alert">{state.error}</p>}
      {state.done && (
        <p className="msg msg-ok" role="status">
          Sold {fmtShares(state.done.shares)} shares of {label} for {fmtUsdc(state.done.usdc)} USDC.{" "}
          <a href={explorerTx(state.done.sig)} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      )}
    </div>
  );
}
