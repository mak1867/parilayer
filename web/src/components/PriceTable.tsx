"use client";

import type { MarketView } from "@/lib/data";
import { fmtPct, fmtPrice } from "@/lib/format";
import { impliedProbOfPrice, poolPrice, poolProb } from "@/lib/market";

export interface SecondaryMark {
  /** Last secondary trade price, base units per share. */
  priceE6: number;
  ts: number;
}

/** A gap this wide between pool and secondary implied probability is worth a look. */
const GAP_POINTS = 0.05;

/**
 * Three prices side by side for every outcome: the pool's (what new shares
 * cost), Gemini's, and the last secondary trade (where existing shares changed hands).
 */
export function PriceTable({
  view,
  selected,
  onSelect,
  secondary,
}: {
  view: MarketView;
  selected: number;
  onSelect: (i: number) => void;
  secondary?: Map<number, SecondaryMark>;
}) {
  const m = view.chain;
  if (!m) return <p className="msg">Reading the market from Solana…</p>;
  const ref = view.meta.reference;
  const settled = m.status === "resolved" || m.status === "voided";

  return (
    <div className="table-wrap">
      <table className="board">
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col" className="r">
              Pool
            </th>
            <th scope="col" className="r">
              Gemini
            </th>
            <th scope="col" className="r">
              Last secondary
            </th>
            <th scope="col" className="track-col">
              <span className="legend">
                <i className="k k-pool" /> pool <i className="k k-gem" /> Gemini <i className="k k-sec" /> secondary
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.meta.outcomes.map((label, i) => {
            const prob = poolProb(m, i);
            const gem = ref?.normalized[i] ?? null;
            const gemRaw = ref?.prices[i] ?? null;
            const sec = secondary?.get(i) ?? null;
            const secProb = sec ? impliedProbOfPrice(m, i, sec.priceE6) : null;
            const gap = secProb !== null && Math.abs(secProb - prob) > GAP_POINTS;
            const won = m.status === "resolved" && m.winner === i;
            return (
              <tr key={i} className={`${selected === i ? "sel" : ""} ${won ? "won" : ""} ${gap ? "gap" : ""}`}>
                <th scope="row">
                  <button type="button" className="row-pick" onClick={() => onSelect(i)} aria-pressed={selected === i}>
                    {label}
                    {won && <span className="tag tag-won">Won</span>}
                  </button>
                </th>
                <td className="r">
                  <span className="num big">{fmtPct(prob)}</span>
                  <small>{fmtPrice(poolPrice(m, i))} a share</small>
                </td>
                <td className="r">
                  <span className="num big">{fmtPct(gem)}</span>
                  <small>{gemRaw === null ? "no quote" : `${(gemRaw * 100).toFixed(1)}¢ on Gemini`}</small>
                </td>
                <td className="r">
                  <span className="num big">{secProb === null ? "–" : fmtPct(secProb)}</span>
                  <small>{sec ? `${fmtPrice(sec.priceE6)} a share` : "no trades yet"}</small>
                  {gap && <span className="tag tag-gap">{`${Math.abs((secProb! - prob) * 100).toFixed(0)} pt gap`}</span>}
                </td>
                <td className="track-col">
                  <div className="track" aria-hidden="true">
                    <span className="fill" style={{ width: `${Math.min(100, prob * 100)}%` }} />
                    {gem !== null && <span className="mark mark-gem" style={{ left: `${Math.min(100, gem * 100)}%` }} />}
                    {secProb !== null && <span className="mark mark-sec" style={{ left: `${Math.min(100, secProb * 100)}%` }} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="table-note">
        Percentages are implied probabilities: the current value of an outcome’s shares divided by the pot, not the share of money
        bet on it. {settled ? "" : "Pick a row to buy that outcome."}
      </p>
    </div>
  );
}
