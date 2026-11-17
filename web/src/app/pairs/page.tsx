"use client";

import { PPM, UNIT, buyIxs, fromHex, marketPda } from "@pmec/sdk";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { type LegChoice, type LegRef, type PairPreview, createPair, getCuratedPairs, getPairLegs, preparePair, previewPair } from "@/lib/api";
import { useData } from "@/lib/data";
import { fmtPct, fmtWhole, parseAmount } from "@/lib/format";
import { poolProb } from "@/lib/market";
import { explainError } from "@/lib/tx";

const sameLeg = (a: LegRef, b: LegRef) => a.event === b.event && a.contract === b.contract;
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The 4 joint outcomes of a pair: seed odds from the legs, the pool's odds if it exists, and Gemini's combo. */
function JointTable({ p, pool, pick, onPick }: { p: PairPreview; pool: number[] | null; pick?: number; onPick?: (i: number) => void }) {
  const [a, b] = p.legs;
  return (
    <div className="table-wrap">
      <table className="board joint">
        <thead>
          <tr>
            <th scope="col">Joint outcome</th>
            <th scope="col" className="r">Product of the legs</th>
            <th scope="col" className="r">{pool ? "Pool" : "Opens at"}</th>
            <th scope="col" className="r">Gemini combo</th>
          </tr>
        </thead>
        <tbody>
          {p.outcomes.map((label, i) => {
            const yesA = (i & 2) !== 0;
            const yesB = (i & 1) !== 0;
            const product = a?.yes !== null && a?.yes !== undefined && b?.yes !== null && b?.yes !== undefined ? (yesA ? a.yes : 1 - a.yes) * (yesB ? b.yes : 1 - b.yes) : null;
            const combo = p.combo && p.combo.outcomeIndex === i ? p.combo.price : null;
            return (
              <tr key={i} className={pick === i ? "sel" : undefined}>
                <th scope="row">
                  {onPick ? (
                    <button type="button" className="row-pick" onClick={() => onPick(i)} aria-pressed={pick === i}>
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                  <small>
                    {a?.label} {yesA ? "yes" : "no"}, {b?.label} {yesB ? "yes" : "no"}
                  </small>
                </th>
                <td className="r num">{fmtPct(product)}</td>
                <td className="r num big">{fmtPct(pool ? pool[i] : p.probsPpm[i]! / PPM)}</td>
                <td className="r">
                  <span className="num">{combo === null ? "–" : `${(combo * 100).toFixed(1)}¢`}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="table-note">
        The product assumes the two legs are independent. Related legs are not, which is the point of trading them as a pair.{" "}
        {p.combo
          ? "Gemini lists its own combo on these legs; its price is shown on the matching row."
          : "Gemini has no combo instrument on these two legs."}
      </p>
    </div>
  );
}

export default function PairsPage() {
  const router = useRouter();
  const wallet = useWallet();
  const { markets, program, usdcMint, usdc, refresh, refreshWallet } = useData();
  const [curated, setCurated] = useState<PairPreview[] | null>(null);
  const [legs, setLegs] = useState<LegChoice[]>([]);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [preview, setPreview] = useState<PairPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState(3);
  const [amount, setAmount] = useState("25");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  useEffect(() => {
    getCuratedPairs().then(setCurated).catch(() => setCurated([]));
    getPairLegs().then(setLegs).catch(() => setLegs([]));
  }, []);

  const legA = legs.find((l) => l.contract === a) ?? null;
  const legB = legs.find((l) => l.contract === b) ?? null;

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!legA || !legB) return;
    if (sameLeg(legA, legB)) return setPreviewError("Pick two different contracts.");
    let live = true;
    previewPair(legA, legB)
      .then((p) => live && setPreview(p))
      .catch((e: Error) => live && setPreviewError(e.message));
    return () => {
      live = false;
    };
  }, [legA, legB]);

  const pairPools = markets.filter((v) => v.meta.kind === "pair");
  const existing = useMemo(() => (preview ? markets.find((v) => v.meta.idHex === preview.idHex) : undefined), [preview, markets]);
  const usdcIn = parseAmount(amount);
  const min = BigInt(preview?.minFirstBuyUsdc ?? 25) * UNIT;
  const amountOk = usdcIn !== null && usdcIn >= min;
  const notEnough = usdc !== null && usdcIn !== null && usdcIn > usdc;

  const choose = (p: PairPreview) => {
    // Curated legs may not be in the pick lists; add them so the selects can show them.
    const add = p.legs.map((l, i) => ({ event: p.legRefs[i]?.event ?? "", contract: l.instrumentSymbol, label: l.label, yes: l.yes }));
    setLegs((ls) => [...ls, ...add.filter((x) => x.event && !ls.some((l) => l.contract === x.contract))]);
    setA(p.legs[0]!.instrumentSymbol);
    setB(p.legs[1]!.instrumentSymbol);
    document.getElementById("build-h")?.scrollIntoView({ behavior: "smooth" });
  };

  const create = async () => {
    if (!legA || !legB || !preview || !usdcIn || !wallet.publicKey || !wallet.signTransaction || !usdcMint) return;
    setState({ busy: true, error: null });
    try {
      const prep = await preparePair(legA, legB, wallet.publicKey.toBase58(), outcome, usdcIn);
      // Check the transaction is exactly a buy on this pool before signing it.
      const tx = Transaction.from(Uint8Array.from(atob(prep.tx), (c) => c.charCodeAt(0)));
      const ixs = await buyIxs(program, {
        buyer: wallet.publicKey,
        market: marketPda(fromHex(prep.idHex)),
        usdcMint,
        outcome,
        usdcIn,
        minSharesOut: BigInt(prep.minSharesOut),
      });
      const want = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: tx.recentBlockhash! }).add(...ixs).serializeMessage();
      const got = tx.serializeMessage();
      if (prep.idHex !== preview.idHex || want.length !== got.length || !want.every((x, i) => x === got[i])) {
        throw new Error("The relayer returned a transaction that is not this first buy. Nothing was signed.");
      }
      const signed = await wallet.signTransaction(tx);
      const out = await createPair(prep.prepareId, toB64(signed.serialize()));
      await Promise.all([refresh(), refreshWallet()]);
      if (out.buyError) {
        setState({ busy: false, error: `The pool was created, but your first buy did not land (${out.buyError}). You can buy from its market page.` });
      }
      router.push(`/market/${out.idHex}`);
    } catch (e) {
      setState({ busy: false, error: explainError(e) });
    }
  };

  return (
    <div className="page">
      <h1>Pair builder</h1>
      <p className="lede">
        A pair pool is one pot over two yes/no questions at once, with four outcomes: both yes, both no, or one of each. It opens at
        the product of the two Gemini prices and moves from there as people buy. The usual guarantee holds: a share costs at most 1
        USDC before the fee, and a winning share pays at least 1 USDC.
      </p>

      <section aria-labelledby="curated-h">
        <h2 id="curated-h">Pairs worth a look</h2>
        {curated === null && <p className="msg">Loading pairs…</p>}
        {curated !== null && curated.length === 0 && <p className="msg">No curated pairs are open right now. Build your own below.</p>}
        <ul className="pair-list">
          {(curated ?? []).map((p) => (
            <li key={p.idHex}>
              <div className="pair-head">
                <div>
                  <h3>{p.title}</h3>
                  {p.note && <p>{p.note}</p>}
                </div>
                {p.exists ? (
                  <Link className="btn btn-primary" href={`/market/${p.idHex}`}>
                    Open pool
                  </Link>
                ) : (
                  <button className="btn btn-primary" onClick={() => choose(p)}>
                    Set up this pair
                  </button>
                )}
              </div>
              <JointTable p={p} pool={poolOdds(markets, p.idHex)} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="build-h">
        <h2 id="build-h">Build a pair</h2>
        {legs.length < 2 ? (
          <p className="msg">Pairs are built from the yes/no markets listed on the exchange, and there are fewer than two contracts available right now.</p>
        ) : (
          <div className="pair-pick">
            <label className="field">
              <span>First question</span>
              <select value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">Choose a contract</option>
                {legs.map((l) => (
                  <option key={l.contract} value={l.contract}>
                    {l.label} ({fmtPct(l.yes)} yes)
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Second question</span>
              <select value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">Choose a contract</option>
                {legs
                  .filter((l) => l.contract !== a)
                  .map((l) => (
                    <option key={l.contract} value={l.contract}>
                      {l.label} ({fmtPct(l.yes)} yes)
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        {previewError && <p className="msg msg-error">{previewError}</p>}
        {legA && legB && !preview && !previewError && <p className="msg">Pricing this pair from Gemini…</p>}

        {preview && (
          <div className="pair-build">
            <h3>{preview.title}</h3>
            <JointTable p={preview} pool={poolOdds(markets, preview.idHex)} pick={preview.exists ? undefined : outcome} onPick={preview.exists ? undefined : setOutcome} />
            {preview.exists || existing ? (
              <p className="msg msg-ok">
                This pair already has a pool. <Link href={`/market/${preview.idHex}`}>Trade it on its market page</Link>
              </p>
            ) : (
              <div className="first-buy">
                <p>
                  This pool does not exist yet. It is created by its first buy: the exchange seeds it with{" "}
                  {fmtWhole(BigInt(preview.seedUsdc) * UNIT)} USDC at the odds above, and your buy goes in right after. Because the
                  exchange pays the seed, the first buy must be at least {preview.minFirstBuyUsdc} USDC.
                </p>
                <label className="field">
                  <span>
                    First buy of “{preview.outcomes[outcome]}” (pick another row above to change)
                  </span>
                  <div className="input-row">
                    <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!amountOk} />
                    <span className="unit">USDC</span>
                  </div>
                </label>
                {!amountOk && <p className="msg msg-error">Enter at least {preview.minFirstBuyUsdc} USDC.</p>}
                {!wallet.publicKey ? (
                  <p className="msg">Connect a wallet to create this pool.</p>
                ) : (
                  <button className="btn btn-primary" onClick={create} disabled={!amountOk || notEnough || state.busy}>
                    {state.busy ? "Creating the pool…" : notEnough ? "Not enough USDC" : "Create pool and buy"}
                  </button>
                )}
                {state.error && <p className="msg msg-error" role="alert">{state.error}</p>}
              </div>
            )}
          </div>
        )}
      </section>

      {pairPools.length > 0 && (
        <section aria-labelledby="pools-h">
          <h2 id="pools-h">Pair pools already open</h2>
          <ul className="market-list">
            {pairPools.map((v) => (
              <li key={v.meta.idHex}>
                <Link href={`/market/${v.meta.idHex}`} className="market-row pair-row">
                  <span className="m-title">
                    <strong>{v.meta.title}</strong>
                    <span className="m-sub">{v.chain ? `Pot ${fmtWhole(v.chain.pot)} USDC, ${v.chain.status}` : "Loading"}</span>
                  </span>
                  {v.meta.outcomes.map((o, i) => (
                    <span className="m-num" key={i}>
                      <span className="m-label">{o}</span>
                      <span className="num big">{v.chain ? fmtPct(poolProb(v.chain, i)) : "…"}</span>
                    </span>
                  ))}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="table-note">Pair pools settle when both Gemini contracts have settled. If one leg settles first, buying pauses until the other does.</p>
    </div>
  );
}

/** Live pool odds for a pair that already exists, or null. */
function poolOdds(markets: ReturnType<typeof useData>["markets"], idHex: string): number[] | null {
  const chain = markets.find((v) => v.meta.idHex === idHex)?.chain;
  return chain ? Array.from({ length: chain.n }, (_, i) => poolProb(chain, i)) : null;
}
