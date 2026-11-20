"use client";

import type { MarketView } from "@/lib/data";
import { fmtPct, fmtPrice } from "@/lib/format";
import { poolPrice, poolProb } from "@/lib/market";

/** A gap this wide between the pool's odds and Gemini's is worth a look. */
const GAP_POINTS = 0.05;

/**
 * The pool's price and Gemini's side by side for every outcome. A gap of more
 * than 5 points is highlighted: the pool only moves when someone trades it,
 * so a gap is an invitation to buy or sell here.
 */
export function PriceTable({
  view,
  selected,
  onSelect,
}: {
  view: MarketView;
  selected: number;
  onSelect: (i: number) => void;
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
            <th scope="col" className="track-col">
              <span className="legend">
                <i className="k k-pool" /> pool <i className="k k-gem" /> Gemini
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.meta.outcomes.map((label, i) => {
            const prob = poolProb(m, i);
            const gem = ref?.normalized[i] ?? null;
            const gemRaw = ref?.prices[i] ?? null;
            const gap = !settled && gem !== null && Math.abs(gem - prob) > GAP_POINTS;
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
                  {gap && (
                    <span className="tag tag-gap" title="The pool and Gemini disagree by more than 5 points.">
                      {`${Math.abs((gem! - prob) * 100).toFixed(0)} pt gap`}
                    </span>
                  )}
                </td>
                <td className="track-col">
                  <div className="track" aria-hidden="true">
                    <span className="fill" style={{ width: `${Math.min(100, prob * 100)}%` }} />
                    {gem !== null && <span className="mark mark-gem" style={{ left: `${Math.min(100, gem * 100)}%` }} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="table-note">
        Percentages are implied probabilities: the current value of an outcome’s shares divided by the pot, not the share of money
        bet on it. Gemini’s prices are normalized to sum to 100%. {settled ? "" : "Pick a row to buy or sell that outcome."}
      </p>
    </div>
  );
}
