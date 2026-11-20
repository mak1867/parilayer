"use client";

import Link from "next/link";
import { MarketList } from "@/components/MarketList";
import { useData } from "@/lib/data";
import { GROUP_ORDER, boardGroup } from "@/lib/market";

export default function MarketsPage() {
  const { markets, ready, relayerError } = useData();
  const open = markets.filter((v) => !v.chain || v.chain.status === "open" || v.chain.status === "halted");
  const settled = markets.filter((v) => v.chain && (v.chain.status === "resolved" || v.chain.status === "voided"));
  const groups = [...new Set([...GROUP_ORDER, ...open.map(boardGroup)])]
    .map((g) => ({ name: g, items: open.filter((v) => boardGroup(v) === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <section className="hero-band" aria-labelledby="hero-h">
        <div className="hero-inner">
          <h1 id="hero-h">Your call, locked in.</h1>
          <p>
            Parimutuel wagering markets on Solana, opened at Gemini’s odds. Each market is one shared pot, and whatever money comes in
            after you, a winning share still pays at least 1 USDC. <Link href="/how-it-works">How it works</Link>
          </p>
        </div>
      </section>

      <div className="page board-page">
        {!ready && <p className="msg">Loading markets…</p>}
        {ready && relayerError && (
          <p className="msg msg-error">The market service is not reachable right now, so there is nothing to list. Try again in a minute.</p>
        )}
        {ready && !relayerError && open.length === 0 && <p className="msg">No markets are open right now.</p>}

        {groups.map((g) => (
          <section key={g.name} className="board-group" aria-labelledby={`g-${g.name}`}>
            <div className="board-head">
              <h2 id={`g-${g.name}`}>{g.name}</h2>
              <span className="board-cols" aria-hidden="true">
                <span>Leading</span>
                <span className="r">Pool</span>
                <span className="r">Gemini</span>
                <span className="r">Pot, USDC</span>
              </span>
            </div>
            <MarketList items={g.items} />
          </section>
        ))}

        {settled.length > 0 && (
          <details className="settled">
            <summary>Settled markets ({settled.length})</summary>
            <MarketList items={settled} />
          </details>
        )}
      </div>
    </>
  );
}
