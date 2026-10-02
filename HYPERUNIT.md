# Hyperunit deposits

Read-only API smoke check: `node scripts/check-hyperunit.js` (last 15 minutes), or supply a lookback in minutes up to 360. It reports real receipt/operation matches without loading bot credentials, sending messages or changing monitor state. An empty interval is not a successful matching test.

Enabled by default. Watches BTC and ETH credited by Unit to Hyperliquid accounts. BTC remains BTC (UBTC); ETH remains ETH (UETH). A receiver's 0x address is its Hyperliquid account, not evidence of a BTC-to-ETH swap. SOL, withdrawals, trading and unrelated internal transfers are excluded.

Railway variables (optional overrides):

```text
HYPERUNIT_ENABLED=true
HYPERUNIT_MIN_DEPOSIT_USD=50000
HYPERUNIT_ACCUM_MIN_USD=100000
HYPERUNIT_ACCUM_COUNT=3
HYPERUNIT_ACCUM_WIN_MIN=15
HYPERUNIT_POLL_MS=60000
HYPERUNIT_FRESH_ONLY=true
HYPERUNIT_MAX_PRIOR_OPERATIONS=2
HYPERUNIT_MAX_PRIOR_HL_TRANSFERS=10
HYPERUNIT_MAX_PRIOR_HL_TRADES=10
HYPERUNIT_ALERT_COOLDOWN_MIN=60
```

A completed single deposit of at least $50k can alert after the history filters below pass. Three or more distinct source transactions to the same destination within 15 minutes can alert when their combined value reaches $100k. Individual accumulation legs need not reach $50k. BTC and ETH can combine, and original senders can differ. Uses destination receipt time, not source deposit time or polling time. Repeated outputs from the same source transaction to one destination count only once (the first matched credit); values from additional outputs are excluded too.

The first qualifying alert starts a one-hour cooldown per receiver. Another qualifying deposit alerts within that hour only if the tracked total has at least doubled since the last alert. Totals include the first alert's accumulation window plus subsequent eligible, distinct deposits; they persist across restarts. A doubling update shows the tracked total separately from the 15-minute accumulation amount. After an hour, a new qualifying deposit can start another alert period. Block wallet targets the receiving Hyperliquid account, removes its active accumulation history, and suppresses its pending alerts. View on Explorer opens the receiving account on explorer.hyperunit.xyz/addresses/; Account on Hypurrscan opens that same account on hypurrscan.io/address/.

## Low-activity receiver filter

Enabled by default. All three limits must pass: at most two prior completed Unit operations, ten prior Hyperliquid non-funding ledger transactions, and ten prior executed trade orders. Unit history counts distinct operation IDs for both deposits and withdrawals across every returned asset, not just the BTC/ETH assets being monitored. Ledger entries are deduplicated by timestamp/hash; this includes other non-funding activity as well as transfers, deposits and withdrawals. Trade fills for the same coin/order are counted once, including spot and perpetual trades returned by `userFills`.

History is measured before the earliest known Unit operation creation time in a deposit burst. The result is held steady for 15 minutes from its first receipt, survives restarts, and is checked again for later bursts. This prevents the monitored deposits from turning an initially low-activity account into an excluded account during the same burst. Receipt time still controls accumulation and alert freshness. Alerts show the observed prior counts. These filters identify investigation leads; they do not establish theft, wallet age, or a wallet's activity on other chains.

The monitor uses the [Unit operations API](https://docs.hyperunit.xyz/developers/api/operations), receiver-specific `userNonFundingLedgerUpdates` from time zero to the history boundary, and aggregated `userFills` from the [Hyperliquid info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint). Failed or malformed responses never imply zero activity. At 100 Unit rows, 500 ledger rows, or 2,000 fills, a response that does not already prove excessive prior activity is treated as potentially truncated and deferred. Latest fills include post-boundary trades so a full page of new trades cannot make missing older trades look like zero. API retention/indexing limits still apply; these are observed counts, not a cross-chain lifetime-history guarantee.

Unknown histories are retried within the existing 30-minute freshness limit, then expire. No extra API key is needed. The receiver lookups share the existing 20-wallet-per-poll budget, stop on rate limits, and reuse a saved history assessment within the burst. Upgrade discards old Unit alerts lacking history verification from monitor and Telegram queues, and excludes unverified accumulation rows; blocked wallets and delivered-deposit dedup remain saved. `HYPERUNIT_FRESH_ONLY=false` disables the history filter, while the cooldown remains active. Prior-count settings accept nonnegative integers, including zero for first-use-only filtering.

Discovery uses the [published BTC and ETH HyperCore treasuries](https://docs.hyperunit.xyz/developers/key-addresses/mainnet), queried through Hyperliquid's `userNonFundingLedgerUpdates`. Every candidate must match a completed [Unit operation](https://docs.hyperunit.xyz/developers/api/operations) by treasury address and nonce, destination, asset and source chain. The ledger's `usdcValue` supplies the estimated USD value of the credited funds; there is no price-service or Alchemy call. No new API key is needed. Public endpoints still have rate limits and can be unavailable.

Durable state is `hyperunit-state.json` on the existing `/data` volume (or `TELEGRAM_DATA_DIR`). Keep one replica. First start examines the preceding 15 minutes in five-minute slices. Later scans stop 30 seconds behind current time and skip history older than `ALERT_MAX_AGE_MIN` (30 by default). Full 500-record treasury ledger pages split their time range; a saturated timestamp or page budget failure retains the cursor. Both treasuries must succeed before saving the discovery cursor. Deposits waiting for Unit indexing or history checks remain saved separately, with up to 20 receiver lookups per poll in rotation. At 2,000 pending receipts discovery pauses until verification catches up. Receipts expire when they exceed the freshness limit.

Unit's live operations endpoint can return only recent history (100 rows observed); it has no documented pagination. An unmatched receipt remains pending until it expires rather than being guessed as a deposit. Unresolved receipts hold later receipts for that destination so accumulation remains chronological; other destinations continue. Long outages or receipts absent from the APIs may prevent complete coverage. Dedup is retained for 30 days. As with the existing monitors, a crash between two durable queue writes can duplicate delivery.

`[UNIT] Scan succeeded` reports discovery position/lag, matched operations, queued alerts, pending verification, `filtered` receipts rejected by prior activity, and `historyErrors` for deferred history checks. It confirms a scan, not Telegram delivery. Pending verification older than 15 minutes, failed operation lookups or failed history checks produces a warning. Confirmation/indexing delays occur before this monitor can alert, in addition to its polling interval.
