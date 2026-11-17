"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BuySlip } from "@/components/BuySlip";
import { PriceTable, type SecondaryMark } from "@/components/PriceTable";
import { SecondaryPanel } from "@/components/SecondaryPanel";
import { type PoolTrade, getActivity } from "@/lib/api";
import { useData } from "@/lib/data";
import { explorerTx } from "@/lib/env";
import { fmtPct, fmtPrice, fmtShares, fmtUsdc, fmtWhole, shortKey, timeAgo } from "@/lib/format";
import { KIND_LABEL, isThin, leadingOutcome, statusLabel } from "@/lib/market";
import { useRfq, useTape } from "@/lib/rfq";

export default function MarketPage() {
  const { id } = useParams<{ id: string }>();
  const { markets, ready } = useData();
  const view = markets.find((v) => v.meta.idHex === id);
  const [selected, setSelected] = useState<number | null>(null);
  const [tape, setTape] = useState<PoolTrade[]>([]);
  const [tab, setTab] = useState<"pool" | "secondary">("pool");
  const pot = view?.chain?.pot;
  const { fillTick } = useRfq();
  const { tape: fills, available: rfqUp } = useTape(id, fillTick);
  // Last secondary trade per outcome (the tape is newest first).
  const secondary = useMemo(() => {
    const marks = new Map<number, SecondaryMark>();
    for (const f of fills) if (!marks.has(f.outcome)) marks.set(f.outcome, { priceE6: Number(f.priceE6), ts: f.ts });
    return marks;
  }, [fills]);

  useEffect(() => {
    if (!id) return;
    let live = true;
    const load = () =>
      getActivity(id)
        .then((t) => live && setTape(t))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Reload the tape whenever the pot changes: someone just traded.
  }, [id, pot]);

  if (!ready) return <div className="page"><p className="msg">Loading market…</p></div>;
  if (!view) {
    return (
      <div className="page">
        <h1>Market not found</h1>
        <p className="msg">
          There is no market with this id. <Link href="/">See all markets</Link>
        </p>
      </div>
    );
  }

  const m = view.chain;
  const outcome = selected ?? (m ? leadingOutcome(m) : 0);
  const ref = view.meta.reference;

  return (
    <div className="page">
      <p className="crumb">
        <Link href="/">Markets</Link>
      </p>
      <header className="market-head">
        <h1>{view.meta.title}</h1>
        <ul className="facts">
          <li>{KIND_LABEL[view.meta.kind]}</li>
          <li className={m ? `status-${m.status}` : undefined}>{statusLabel(view)}</li>
          {m && (
            <li>
              Pot <span className="num">{fmtWhole(m.pot)}</span> USDC
            </li>
          )}
          {m && m.status === "open" && isThin(m) && (
            <li className="tag tag-thin" title="The pot is under 5 times its seed, so prices move a lot per dollar.">
              Thin market
            </li>
          )}
          {view.meta.expiryDate && <li>Gemini expiry {new Date(view.meta.expiryDate).toLocaleString()}</li>}
        </ul>
        {m?.status === "halted" && <p className="msg msg-warn">Gemini has paused or closed trading on this event, so buying is paused here too.</p>}
        {m?.status === "voided" && (
          <p className="msg msg-warn">Gemini voided this event. Every share can be redeemed at its final pool price from the portfolio page.</p>
        )}
      </header>

      <div className="market-grid">
        <div>
          <PriceTable view={view} selected={outcome} onSelect={setSelected} secondary={secondary} />

          <section aria-labelledby="sec-h" className="sub">
            <h2 id="sec-h">Secondary trades</h2>
            {!rfqUp ? (
              <p className="msg">The secondary market service is not reachable right now.</p>
            ) : fills.length === 0 ? (
              <p className="msg">No shares have changed hands between traders in this market yet.</p>
            ) : (
              <table className="tape">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Outcome</th>
                    <th scope="col" className="r">Price</th>
                    <th scope="col" className="r">Shares</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.slice(0, 10).map((f) => (
                    <tr key={f.signature}>
                      <td>
                        <a href={explorerTx(f.signature)} target="_blank" rel="noreferrer">
                          {timeAgo(f.ts)}
                        </a>
                      </td>
                      <td>{view.meta.outcomes[f.outcome]}</td>
                      <td className="r num">{fmtPrice(Number(f.priceE6))}</td>
                      <td className="r num">{fmtShares(BigInt(f.size))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="table-note">
              Requests and quotes are private. A trade appears here, and on-chain, only after it has settled: price, size and time.
            </p>
          </section>

          <section aria-labelledby="tape-h" className="sub">
            <h2 id="tape-h">Recent pool buys</h2>
            {tape.filter((t) => t.kind === "buy").length === 0 ? (
              <p className="msg">Nobody has bought from this pool yet. The first buy moves the odds the most.</p>
            ) : (
              <table className="tape">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Outcome</th>
                    <th scope="col" className="r">Paid</th>
                    <th scope="col" className="r">Shares</th>
                    <th scope="col" className="r">Odds after</th>
                    <th scope="col">Wallet</th>
                  </tr>
                </thead>
                <tbody>
                  {tape
                    .filter((t) => t.kind === "buy")
                    .slice(0, 12)
                    .map((t) => (
                      <tr key={`${t.signature}`}>
                        <td>
                          <a href={explorerTx(t.signature)} target="_blank" rel="noreferrer">
                            {t.blockTime ? timeAgo(t.blockTime * 1000) : "just now"}
                          </a>
                        </td>
                        <td>{view.meta.outcomes[t.outcome]}</td>
                        <td className="r num">{fmtUsdc(BigInt(t.usdc))}</td>
                        <td className="r num">{fmtShares(BigInt(t.shares))}</td>
                        <td className="r num">{t.probAfter === null ? "–" : fmtPct(t.probAfter / 1e6)}</td>
                        <td>{shortKey(t.wallet)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="about-h" className="sub">
            <h2 id="about-h">Where this market comes from</h2>
            <dl className="about">
              <div>
                <dt>Gemini contract{view.meta.refs.length > 1 ? "s" : ""}</dt>
                <dd>{view.meta.refs.join(", ")}</dd>
              </div>
              <div>
                <dt>Gemini prices as of</dt>
                <dd>{ref?.asOf ? timeAgo(ref.asOf) : "not loaded yet"}</dd>
              </div>
              <div>
                <dt>Seeded by the exchange with</dt>
                <dd>{fmtWhole(BigInt(view.meta.seedUsdc))} USDC at Gemini’s odds</dd>
              </div>
              <div>
                <dt>Market account</dt>
                <dd>
                  <code>{view.meta.address}</code>
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <div className="trade-col">
          <div className="tabs" role="tablist" aria-label="How to trade">
            <button role="tab" aria-selected={tab === "pool"} className={tab === "pool" ? "on" : undefined} onClick={() => setTab("pool")}>
              Buy from the pool
            </button>
            <button role="tab" aria-selected={tab === "secondary"} className={tab === "secondary" ? "on" : undefined} onClick={() => setTab("secondary")}>
              Trade with traders
            </button>
          </div>
          {tab === "pool" ? (
            <BuySlip key={`${view.meta.idHex}:${outcome}`} view={view} outcome={outcome} />
          ) : (
            <SecondaryPanel view={view} outcome={outcome} />
          )}
        </div>
      </div>
    </div>
  );
}
