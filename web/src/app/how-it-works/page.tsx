import type { Metadata } from "next";
import Link from "next/link";
import { FloorChart } from "@/components/FloorChart";

const PENNOCK_URL = "https://courses.cs.duke.edu/spring07/cps296.3/pennock-ec-2004-dynamic-parimutuel.pdf";

export const metadata: Metadata = {
  title: "How it works",
  description: "A share costs at most 1 USDC and a winning share pays at least 1 USDC. How the pool prices, pays and buys back.",
};

export default function HowItWorks() {
  return (
    <div className="page prose-page">
      <header className="how-head">
        <h1>How PariLayer works</h1>
        <p className="lead">
          A share costs at most 1 USDC, and a winning share pays at least 1 USDC, whatever anyone does after you buy. If you are
          right, the worst case is getting back what you paid per share; usually you get more.
        </p>
      </header>

      <section className="sub" aria-labelledby="pot-h">
        <h2 id="pot-h">One pot per market</h2>
        <p>
          Every market is a single pot of USDC. Buying an outcome adds your USDC to the pot and mints new shares of that outcome.
          When the market resolves, the whole pot is split among the winning shares. Losing shares pay nothing.
        </p>
        <p>
          The pool prices shares with the dynamic parimutuel market maker David Pennock introduced in{" "}
          <a href={PENNOCK_URL} target="_blank" rel="noreferrer">
            <cite>A Dynamic Pari-Mutuel Market for Hedging, Wagering, and Information Aggregation</cite>
          </a>{" "}
          (ACM Conference on Electronic Commerce, 2004). It keeps the parimutuel idea of one shared pot but lets prices move with
          every trade, so being early is rewarded. The cost of the pool is the length of the vector
          of shares outstanding, C(q) = √(q₁² + q₂² + …). The price of one more share of outcome i is qᵢ / C(q), which is at most
          1 USDC, because no single qᵢ can be longer than the whole vector.
        </p>
        <p>
          The percentage shown for each outcome is its implied probability: the current value of that outcome’s shares divided by
          the pot. It is not the share of money bet on it.
        </p>
      </section>

      <section className="sub" aria-labelledby="floor-h">
        <h2 id="floor-h">Why a winning share pays at least 1 USDC</h2>
        <p>
          The pot always holds at least C(q). If outcome i wins, each of its shares gets pot ÷ qᵢ, and since the pot is at least
          C(q) and C(q) is at least qᵢ, that is at least 1 USDC. Every trade, every rounding and every fee keeps the pot at or
          above C(q); the program checks it after every instruction.
        </p>
        <p>
          Your floor is fixed the moment you buy: shares × 1 USDC. Buying at 30% implied costs about 0.55 USDC a share, so the
          floor is about 1.8 times your money, before the 1% pool fee.
        </p>
      </section>

      <section className="sub" aria-labelledby="chart-h">
        <h2 id="chart-h">What late money does to an early buyer</h2>
        <p>
          In a plain parimutuel pot, every dollar that arrives after you on your side dilutes your share of the winnings, all the
          way down to break-even and below it once the fee is counted. In this pool, late buyers pay a higher price for their
          shares, so your payout per share falls toward your floor and stops there.
        </p>
        <FloorChart />
        <p className="table-note">
          If nobody buys after you, the parimutuel pot pays slightly more (2.73× against 2.54× here). The pool gives up a little
          of that best case in exchange for a floor that holds whatever comes in later. The same rows come out of{" "}
          <code>cargo run -p parilayer-math --example simulate</code>, from the integer math the Solana program runs.
        </p>
      </section>

      <section className="sub" aria-labelledby="sell-h">
        <h2 id="sell-h">Selling back to the pool</h2>
        <p>
          While a market is open you can sell shares back to the pool. Selling runs the buy formula in reverse: you get what your
          shares added to the cost, R = C(q) − C(q without them), minus a 2% fee. Buying and immediately selling costs exactly the
          two fees.
        </p>
        <p>
          The 2% fee stays in the pot, so the holders who remain are paid for your leaving, and the pot still holds at least C(q):
          every winning share still pays at least 1 USDC. Selling stops when Gemini halts trading or the market resolves, so
          nobody can race a known result. The exchange’s seed shares can never be sold.
        </p>
      </section>

      <section className="sub" aria-labelledby="gemini-h">
        <h2 id="gemini-h">Where the prices and results come from</h2>
        <p>
          Every market mirrors a Gemini Predictions contract. The exchange seeds each pot with 500 USDC at Gemini’s odds, so a new
          market opens at Gemini’s prices, then moves only when people trade it. The market page shows both side by side and
          flags a gap of more than 5 points.
        </p>
        <p>
          When Gemini settles the contract, the relayer posts the result on Solana and keeps the Gemini response and its hash in
          an audit log. The relayer is a trusted oracle: it can create markets and post results, but it cannot move anyone’s
          funds. Every dollar sits in accounts owned by the program.
        </p>
        <p>
          <Link href="/pairs">Pair pools</Link> apply the same math to two contracts at once: four outcomes (Yes/Yes, Yes/No,
          No/Yes, No/No), seeded at the product of the legs and compared with Gemini’s own combo price when it has one.
        </p>
      </section>

      <section className="sub" aria-labelledby="refs-h">
        <h2 id="refs-h">Further reading</h2>
        <ul className="refs">
          <li>
            David M. Pennock.{" "}
            <a href={PENNOCK_URL} target="_blank" rel="noreferrer">
              A Dynamic Pari-Mutuel Market for Hedging, Wagering, and Information Aggregation
            </a>
            . Proceedings of the 5th ACM Conference on Electronic Commerce (EC 2004). The mechanism PariLayer implements, with the
            cost function C(q) = ‖q‖.
          </li>
          <li>
            Hoda Heidari, Sébastien Lahaie, David M. Pennock and Jennifer Wortman Vaughan.{" "}
            <a href="https://www.jennwv.com/papers/orderbook.pdf" target="_blank" rel="noreferrer">
              Integrating Market Makers, Limit Orders, and Continuous Trade in Prediction Markets
            </a>
            . On combining a market maker with orders between traders, the direction of PariLayer’s roadmap.
          </li>
        </ul>
      </section>

      <div className="how-end">
        <Link href="/" className="btn btn-primary">
          See the markets
        </Link>
      </div>
    </div>
  );
}
