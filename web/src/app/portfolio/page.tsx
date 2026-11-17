"use client";

import { type MarketState, outcomeMintPda, payoutRateE12, redeemIxs, redeemValue } from "@pmec/sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type PositionHistory, getPositionHistory } from "@/lib/api";
import { type MarketView, useData } from "@/lib/data";
import { RFQ_URL, explorerTx } from "@/lib/env";
import { fmtShares, fmtUsdc } from "@/lib/format";
import { explainError, sendIxs } from "@/lib/tx";

interface SecondaryFill {
  marketId: string;
  outcome: number;
  size: string;
  value: string;
  side: "buy" | "sell";
}

interface Position {
  view: MarketView;
  chain: MarketState;
  outcome: number;
  shares: bigint;
  /** Everything this wallet bought of this outcome (pool and secondary) and what it paid. */
  bought: bigint;
  paid: bigint;
}

/** What `shares` of `outcome` can be redeemed for right now, or null if nothing can be redeemed yet. */
function redeemable(m: MarketState, outcome: number, shares: bigint): bigint | null {
  if (m.status === "resolved") return m.winner === outcome ? redeemValue(shares, m.payoutPerShare) : 0n;
  if (m.status === "voided") return redeemValue(shares, m.finalPrices[outcome]!);
  return null;
}

export default function PortfolioPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { markets, tokens, usdc, usdcMint, program, refresh, refreshWallet } = useData();
  const [history, setHistory] = useState<PositionHistory[]>([]);
  const [secondary, setSecondary] = useState<SecondaryFill[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string; sig?: string } | null>(null);
  const owner = wallet.publicKey?.toBase58();

  useEffect(() => {
    if (!owner) return setHistory([]);
    let live = true;
    getPositionHistory(owner)
      .then((h) => live && setHistory(h))
      .catch(() => undefined);
    fetch(`${RFQ_URL}/fills/${owner}`)
      .then((r) => r.json())
      .then((f: SecondaryFill[]) => live && setSecondary(f))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [owner, tokens]);

  const positions = useMemo(() => {
    const out: Position[] = [];
    for (const view of markets) {
      const chain = view.chain;
      if (!chain) continue;
      for (let i = 0; i < chain.n; i++) {
        const shares = tokens.get(outcomeMintPda(chain.address, i).toBase58()) ?? 0n;
        if (shares === 0n) continue;
        // Cost basis: pool buys from on-chain history plus secondary buys from the trade tape.
        const h = history.find((x) => x.market === view.meta.address && x.outcome === i);
        let bought = h ? BigInt(h.boughtShares) : 0n;
        let paid = h ? BigInt(h.boughtUsdc) : 0n;
        for (const f of secondary) {
          if (f.marketId === view.meta.idHex && f.outcome === i && f.side === "buy") {
            bought += BigInt(f.size);
            paid += BigInt(f.value);
          }
        }
        out.push({ view, chain, outcome: i, shares, bought, paid });
      }
    }
    return out;
  }, [markets, tokens, history, secondary]);

  const redeem = async (p: Position) => {
    if (!wallet.publicKey || !usdcMint) return;
    const key = `${p.view.meta.idHex}:${p.outcome}`;
    setBusy(key);
    setNote(null);
    try {
      const pay = redeemable(p.chain, p.outcome, p.shares) ?? 0n;
      const ixs = await redeemIxs(program, {
        holder: wallet.publicKey,
        market: p.chain.address,
        usdcMint,
        outcome: p.outcome,
        amount: p.shares,
      });
      const sig = await sendIxs(connection, wallet, ixs);
      setNote({ kind: "ok", text: `Redeemed ${fmtShares(p.shares)} shares for ${fmtUsdc(pay)} USDC.`, sig });
      await Promise.all([refresh(), refreshWallet()]);
    } catch (e) {
      setNote({ kind: "error", text: explainError(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!wallet.publicKey) {
    return (
      <div className="page">
        <h1>Portfolio</h1>
        <p className="msg">Connect a wallet to see your positions, what they cost, and the least they pay if they win.</p>
      </div>
    );
  }

  const totalFloor = positions.filter((p) => p.chain.status === "open" || p.chain.status === "halted").reduce((a, p) => a + p.shares, 0n);

  return (
    <div className="page">
      <h1>Portfolio</h1>
      <ul className="facts">
        <li>
          Cash <span className="num">{usdc === null ? "…" : fmtUsdc(usdc)}</span> USDC
        </li>
        <li>
          {positions.length} position{positions.length === 1 ? "" : "s"}
        </li>
        {totalFloor > 0n && (
          <li>
            Open positions pay at least <span className="num">{fmtUsdc(totalFloor)}</span> USDC in total if every one wins
          </li>
        )}
      </ul>

      {note && (
        <p className={`msg ${note.kind === "ok" ? "msg-ok" : "msg-error"}`} role={note.kind === "ok" ? "status" : "alert"}>
          {note.text}{" "}
          {note.sig && (
            <a href={explorerTx(note.sig)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </p>
      )}

      {positions.length === 0 ? (
        <p className="msg">
          No shares in this wallet yet. <Link href="/">Pick a market</Link> and buy an outcome to open your first position.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="board positions">
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col" className="r">Shares</th>
                <th scope="col" className="r">Cost</th>
                <th scope="col" className="r">Pays at least</th>
                <th scope="col" className="r">Pays today</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const key = `${p.view.meta.idHex}:${p.outcome}`;
                const m = p.chain;
                const live = m.status === "open" || m.status === "halted";
                const now = redeemValue(p.shares, payoutRateE12(m.pot, m.q[p.outcome]!));
                const claim = redeemable(m, p.outcome, p.shares);
                // Average cost of this wallet's buys, applied to the shares it still holds.
                const bought = p.bought;
                const covered = p.shares < bought ? p.shares : bought;
                const cost = bought > 0n ? (p.paid * covered) / bought : null;
                const partial = bought > 0n && p.shares > bought;
                return (
                  <tr key={key}>
                    <th scope="row">
                      <Link href={`/market/${p.view.meta.idHex}`}>{p.view.meta.title}</Link>
                      <small>{p.view.meta.outcomes[p.outcome]}</small>
                    </th>
                    <td className="r num">{fmtShares(p.shares)}</td>
                    <td className="r">
                      <span className="num">{cost === null ? "–" : fmtUsdc(cost)}</span>
                      <small>
                        {cost === null
                          ? "no buys on record for this wallet"
                          : `${(Number(cost) / Number(covered)).toFixed(3)} a share${partial ? ", for the part bought here" : ""}`}
                      </small>
                    </td>
                    <td className="r">
                      {live ? (
                        <>
                          <span className="num floor-num">{fmtUsdc(p.shares)}</span>
                          <small>if {p.view.meta.outcomes[p.outcome]} wins</small>
                        </>
                      ) : (
                        <span className="num">–</span>
                      )}
                    </td>
                    <td className="r">
                      {live ? (
                        <>
                          <span className="num">{fmtUsdc(now)}</span>
                          <small>if it resolved now</small>
                        </>
                      ) : (
                        <span className="num">{claim === null ? "–" : fmtUsdc(claim)}</span>
                      )}
                    </td>
                    <td>
                      {live && <span>{m.status === "halted" ? "Halted" : "Open"}</span>}
                      {!live && claim !== null && claim > 0n && (
                        <button className="btn btn-primary" onClick={() => redeem(p)} disabled={busy !== null}>
                          {busy === key ? "Redeeming…" : `Redeem ${fmtUsdc(claim)} USDC`}
                        </button>
                      )}
                      {!live && claim === 0n && <span>Lost. These shares pay nothing.</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="table-note">
            “Pays at least” is the guarantee: 1 USDC for every share if that outcome wins. Cost is the average this wallet paid,
            from its on-chain pool buys (fee included) and its secondary trades.
          </p>
        </div>
      )}
    </div>
  );
}
