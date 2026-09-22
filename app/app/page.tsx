import DeskView from "@/components/Desk";

/**
 * The shell renders instantly and never touches the chain. An earlier version did
 * the full 24h scan here AND in /api/desk, which meant two heavy functions doing
 * identical work; the page one kept failing in production and fell through to its
 * error state while the API was fine. The data now loads client-side from the one
 * endpoint that does the work.
 */
export default function Page() {
  return (
    <main className="shell">
      <header className="masthead">
        <h1 className="wordmark">The First Bank of Friends</h1>
        <p className="tagline">a desk that is flat until the market pays it</p>
      </header>

      <DeskView />

      <hr className="rule" />

      <footer>
        <p>
          Nothing here is financial advice and nothing here is a forecast. The desk holds no
          third-party funds and has never executed a trade. Backtests cover 8,777 swaps across
          the pool&rsquo;s entire 5.6-day history; that is a short and unusual sample, presented as
          evidence of what has happened, not a claim about what will.
        </p>
        <p>
          Built for the Rare Friends Vibeathon. Source, backtests and the verification harness:{" "}
          <a href="https://github.com/Halldon-Inc/bank-of-friends">github.com/Halldon-Inc/bank-of-friends</a>
        </p>
      </footer>
    </main>
  );
}
