"use client";

import Link from "next/link";
import { useData } from "@/lib/data";
import { fmtPct, fmtWhole } from "@/lib/format";
import { KIND_LABEL, isThin, leadingOutcome, poolProb, statusLabel } from "@/lib/market";

export default function MarketsPage() {
  const { markets, ready, relayerError } = useData();
  const open = markets.filter((v) => !v.chain || v.chain.status === "open" || v.chain.status === "halted");
  const settled = markets.filter((v) => v.chain && (v.chain.status === "resolved" || v.chain.status === "voided"));

  return (
    <div className="page">
      <section className="hero">
        <h1>
          A share costs at most 1 USDC.
          <br />
          If it wins, it pays at least 1 USDC.
        </h1>
        <p>
          Every market here is one shared pot. Buy an outcome from the pool at its current price; if you are right, no later buyer
          can push your payout under 1 USDC a share. Opening odds and results come from Gemini Predictions.{" "}
          <Link href="/how-it-works">How the floor works</Link>
        </p>
      </section>

      <section aria-labelledby="open-h">
        <h2 id="open-h">Open markets</h2>
        {!ready && <p className="msg">Loading markets…</p>}
        {ready && relayerError && (
          <p className="msg msg-error">
            The relayer is not reachable, so there is nothing to list. Start it with <code>npm run serve -w relayer</code> and this
            page will fill in by itself.
          </p>
        )}
        {ready && !relayerError && open.length === 0 && <p className="msg">No open markets yet. The relayer creates them from its mirror list.</p>}
        <MarketList items={open} />
      </section>

      {settled.length > 0 && (
        <section aria-labelledby="settled-h">
          <h2 id="settled-h">Settled</h2>
          <MarketList items={settled} />
        </section>
      )}
    </div>
  );
}

function MarketList({ items }: { items: ReturnType<typeof useData>["markets"] }) {
  if (items.length === 0) return null;
  return (
    <ul className="market-list">
      {items.map((v) => {
        const m = v.chain;
        const lead = m ? leadingOutcome(m) : 0;
        const gem = v.meta.reference?.normalized[lead] ?? null;
        return (
          <li key={v.meta.idHex}>
            <Link href={`/market/${v.meta.idHex}`} className="market-row">
              <span className="m-title">
                <strong>{v.meta.title}</strong>
                <span className="m-sub">
                  {KIND_LABEL[v.meta.kind]}, {v.meta.outcomes.length} outcomes
                  {m && m.status !== "open" && <span className={`tag tag-${m.status}`}>{statusLabel(v)}</span>}
                  {m && m.status === "open" && isThin(m) && (
                    <span className="tag tag-thin" title="The pot is under 5 times its seed, so prices move a lot per dollar.">
                      Thin market
                    </span>
                  )}
                </span>
              </span>
              <span className="m-lead">
                <span className="m-label">Leading</span>
                <span className="m-value">{v.meta.outcomes[lead]}</span>
              </span>
              <span className="m-num">
                <span className="m-label">Pool</span>
                <span className="num big">{m ? fmtPct(poolProb(m, lead)) : "…"}</span>
              </span>
              <span className="m-num">
                <span className="m-label">Gemini</span>
                <span className="num big">{fmtPct(gem)}</span>
              </span>
              <span className="m-num">
                <span className="m-label">Pot</span>
                <span className="num big">{m ? fmtWhole(m.pot) : "…"}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
