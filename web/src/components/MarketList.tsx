"use client";

import Link from "next/link";
import type { MarketView } from "@/lib/data";
import { fmtPct, fmtWhole } from "@/lib/format";
import { isThin, leadingOutcome, poolProb, statusLabel, titleParts } from "@/lib/market";

/** The board's market rows: title, leading outcome with pool and Gemini on one track, pool, Gemini, pot. */
export function MarketList({ items }: { items: MarketView[] }) {
  return (
    <ul className="market-list">
      {items.map((v) => {
        const m = v.chain;
        const lead = m ? leadingOutcome(m) : 0;
        const prob = m ? poolProb(m, lead) : null;
        const gem = v.meta.reference?.normalized[lead] ?? null;
        const t = titleParts(v.meta.title, v.meta.kind);
        const live = m && m.status === "open";
        const tag =
          m && !live ? (
            <span className={`tag tag-${m.status}`}>{statusLabel(v)}</span>
          ) : live && isThin(m) ? (
            <span className="tag tag-thin" title="The pot is under 5 times its seed, so prices move a lot per dollar.">
              Thin market
            </span>
          ) : null;
        return (
          <li key={v.meta.idHex}>
            <Link href={`/market/${v.meta.idHex}`} className="market-row">
              <span className="m-title">
                {(t.event || tag) && (
                  <span className="m-event">
                    {t.event}
                    {tag}
                  </span>
                )}
                {t.lines.map((l, i) => (
                  <strong key={i} className={t.lines.length > 1 ? "m-leg" : undefined}>
                    {i > 0 && <span aria-hidden="true">× </span>}
                    {l}
                  </strong>
                ))}
              </span>
              <span className="m-lead">
                <span className="m-lead-name">
                  <span className="sr">Leading: </span>
                  {v.meta.outcomes[lead]}
                </span>
                {prob !== null && (
                  <span className="track" aria-hidden="true">
                    <span className="fill" style={{ width: `${Math.min(100, prob * 100)}%` }} />
                    {gem !== null && <span className="mark mark-gem" style={{ left: `${Math.min(100, gem * 100)}%` }} />}
                  </span>
                )}
              </span>
              <span className="m-num">
                <span className="sr">Pool </span>
                <span className="num big">{prob === null ? "…" : fmtPct(prob)}</span>
              </span>
              <span className="m-num m-gem">
                <span className="sr">Gemini </span>
                <span className="num">{fmtPct(gem)}</span>
              </span>
              <span className="m-num m-pot">
                <span className="sr">Pot </span>
                <span className="num">{m ? fmtWhole(m.pot) : "…"}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
