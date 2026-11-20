"use client";

import { UNIT, payoutRateE12, quoteBuy, redeemValue, seedShares, splitFee } from "@pmec/sdk";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The floor chart: an early buyer's return if their outcome wins, as late money
 * floods that same outcome. Plain parimutuel versus this pool, computed with the
 * same integer math the program runs (crates/pmec-math/examples/simulate.rs
 * prints the identical table).
 */

const SEED = 1_000n * UNIT;
const PROB_A_PPM = 300_000;
const EARLY = 100n * UNIT;
const FEE_BPS = 100;
const STEP = 500n * UNIT;
const STEPS = 40;

interface Row {
  late: number;
  pari: number;
  pool: number;
}

function simulate(): { rows: Row[]; floor: number } {
  const net = (x: bigint) => x - splitFee(x, FEE_BPS)[1];
  const q0 = seedShares([PROB_A_PPM, 1_000_000 - PROB_A_PPM], SEED);
  const early = quoteBuy(q0, SEED, 0, EARLY, FEE_BPS);
  const rows: Row[] = [];
  for (let s = 0; s <= STEPS; s++) {
    const late = BigInt(s) * STEP;
    const lateNet = late > 0n ? net(late) : 0n;
    const onA = 300n * UNIT + net(EARLY) + lateNet;
    const pot = SEED + net(EARLY) + lateNet;
    const pari = (Number(net(EARLY)) * Number(pot)) / Number(onA) / Number(EARLY);
    let q = early.qAfter;
    let poolPot = early.potAfter;
    if (late > 0n) {
      const after = quoteBuy(q, poolPot, 0, late, FEE_BPS);
      q = after.qAfter;
      poolPot = after.potAfter;
    }
    const payout = redeemValue(early.shares, payoutRateE12(poolPot, q[0]!));
    rows.push({ late: Number(late / UNIT), pari, pool: Number(payout) / Number(EARLY) });
  }
  return { rows, floor: Number(early.shares) / Number(EARLY) };
}

// Geometry in CSS pixels: the chart measures its own width, so text stays
// 12px on a phone instead of shrinking with a scaled drawing.
const H = 340;
const Y_MAX = 3;
const X_MAX = STEPS * 500;

function geometry(W: number) {
  const narrow = W < 560;
  const M = { top: 20, right: narrow ? 14 : 150, bottom: 44, left: 40 };
  const PW = W - M.left - M.right;
  const PH = H - M.top - M.bottom;
  const x = (late: number) => M.left + (late / X_MAX) * PW;
  const y = (m: number) => M.top + (1 - m / Y_MAX) * PH;
  const path = (rows: Row[], key: "pari" | "pool") =>
    rows.map((r, i) => `${i ? "L" : "M"}${x(r.late).toFixed(1)},${y(r[key]).toFixed(1)}`).join("");
  const xTicks = narrow ? [0, 10000, 20000] : [0, 5000, 10000, 15000, 20000];
  return { W, narrow, M, PW, PH, x, y, path, xTicks };
}

const fmtX = (n: number) => (n === 0 ? "0" : `${n / 1000}K`);
const mult = (n: number) => `${n.toFixed(2)}×`;

export function FloorChart() {
  const { rows, floor } = useMemo(simulate, []);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(720);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(300, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { W, narrow, M, PW, PH, x, y, path, xTicks } = geometry(width);
  const last = rows[rows.length - 1]!;
  const h = hover === null ? null : rows[hover]!;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(STEPS, Math.round(frac * STEPS))));
  };

  return (
    <figure className="floor-chart">
      <figcaption>
        <strong>An early buyer’s return if they are right</strong>
        <span>
          100 USDC on an outcome at 30%, in a market seeded with 1,000 USDC. Then other people pour more money into the same
          outcome. Both systems take a 1% fee.
        </span>
      </figcaption>
      <ul className="chart-legend" aria-label="Legend">
        <li>
          <i className="key key-pool" /> This pool
        </li>
        <li>
          <i className="key key-pari" /> Plain parimutuel pot
        </li>
        <li>
          <i className="key key-floor" /> Guaranteed floor, fixed when you buy
        </li>
      </ul>
      <div className="chart-box" ref={boxRef}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Return multiple against late money. This pool falls from ${mult(rows[0]!.pool)} toward its floor of ${mult(floor)}; a plain parimutuel pot falls from ${mult(rows[0]!.pari)} toward 1×.`}>
          {[0, 1, 2, 3].map((t) => (
            <g key={t}>
              <line className="grid" x1={M.left} x2={M.left + PW} y1={y(t)} y2={y(t)} />
              <text className="tick" x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {t}×
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="tick" x={x(t)} y={M.top + PH + 18} textAnchor="middle">
              {fmtX(t)}
            </text>
          ))}
          <text className="axis-title" x={M.left + PW / 2} y={H - 6} textAnchor="middle">
            Late money on the same outcome (USDC)
          </text>
          <text className="tick" x={M.left + 6} y={y(1) + 15}>
            break-even
          </text>

          {/* The guarantee: a reference line, not a series. */}
          <line className="floor-line" x1={M.left} x2={M.left + PW} y1={y(floor)} y2={y(floor)} />
          <text className="chart-label" x={x(narrow ? 3000 : 2500)} y={y(floor) + 16}>
            {narrow ? `Floor ${mult(floor)}` : `Floor ${mult(floor)}: 1 USDC a share, whatever happens next`}
          </text>

          <path className="line line-pari" d={path(rows, "pari")} />
          <path className="line line-pool" d={path(rows, "pool")} />

          <circle className="end end-pool" cx={x(last.late)} cy={y(last.pool)} r={4} />
          <circle className="end end-pari" cx={x(last.late)} cy={y(last.pari)} r={4} />
          {!narrow && (
            <>
              <text className="chart-label strong" x={M.left + PW + 10} y={y(last.pool)} dy="0.32em">
                This pool {mult(last.pool)}
              </text>
              <text className="chart-label strong" x={M.left + PW + 10} y={y(last.pari)} dy="0.32em">
                Parimutuel {mult(last.pari)}
              </text>
            </>
          )}

          {h && (
            <g aria-hidden="true">
              <line className="crosshair" x1={x(h.late)} x2={x(h.late)} y1={M.top} y2={M.top + PH} />
              <circle className="end end-pool" cx={x(h.late)} cy={y(h.pool)} r={4} />
              <circle className="end end-pari" cx={x(h.late)} cy={y(h.pari)} r={4} />
            </g>
          )}
          <rect
            className="hit"
            x={M.left}
            y={M.top}
            width={PW}
            height={PH}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {h && (
          <div className="chart-tip" style={{
              left: `${(x(h.late) / W) * 100}%`,
              top: `${(M.top / H) * 100}%`,
              transform: x(h.late) / W > 0.6 ? "translate(calc(-100% - 12px), 0)" : undefined,
            }} role="status">
            <div className="tip-head">{h.late.toLocaleString()} USDC of late money</div>
            <div>
              <i className="key key-pool" /> <b>{mult(h.pool)}</b> this pool
            </div>
            <div>
              <i className="key key-pari" /> <b>{mult(h.pari)}</b> parimutuel
            </div>
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>Show the numbers</summary>
        <table className="tape">
          <thead>
            <tr>
              <th scope="col" className="r">
                Late money (USDC)
              </th>
              <th scope="col" className="r">
                This pool
              </th>
              <th scope="col" className="r">
                Parimutuel
              </th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((_, i) => i % 4 === 0)
              .map((r) => (
                <tr key={r.late}>
                  <td className="r num">{r.late.toLocaleString()}</td>
                  <td className="r num">{mult(r.pool)}</td>
                  <td className="r num">{mult(r.pari)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
