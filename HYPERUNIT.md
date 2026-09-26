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
```

A completed single deposit of at least $50k alerts. Three or more distinct source transactions to the same destination within 15 minutes alert when their combined value reaches $100k. Individual accumulation legs need not reach $50k. BTC and ETH can combine, and original senders can differ. Uses destination receipt time, not source deposit time or polling time. Repeated outputs from the same source transaction to one destination count only once (the first matched credit); values from additional outputs are excluded too.

After the accumulation threshold, each further deposit in the qualifying window updates the summary. That deposit produces a summary instead of an additional single-deposit message. Block wallet targets the receiving Hyperliquid account, removes its active accumulation history, and suppresses its pending alerts. Explorer links target the credited transaction and receiving account on Hyperliquid.

Discovery uses the [published BTC and ETH HyperCore treasuries](https://docs.hyperunit.xyz/developers/key-addresses/mainnet), queried through Hyperliquid's `userNonFundingLedgerUpdates`. Every candidate must match a completed [Unit operation](https://docs.hyperunit.xyz/developers/api/operations) by treasury address and nonce, destination, asset and source chain. The ledger's `usdcValue` supplies the estimated USD value of the credited funds; there is no price-service or Alchemy call. No new API key is needed. Public endpoints still have rate limits and can be unavailable.

Durable state is `hyperunit-state.json` on the existing `/data` volume (or `TELEGRAM_DATA_DIR`). Keep one replica. First start examines the preceding 15 minutes in five-minute slices. Later scans stop 30 seconds behind current time. Full 500-record ledger pages split their time range; a saturated timestamp or page budget failure retains the cursor. Both treasuries must succeed before saving the discovery cursor. Deposits waiting for Unit indexing remain saved separately, with up to 20 receiver lookups per poll in rotation. At 2,000 pending receipts discovery pauses until verification catches up. No pending receipts expire silently.

Unit's live operations endpoint can return only recent history (100 rows observed); it has no documented pagination. An unmatched old receipt remains pending and warns rather than being guessed as a deposit. Unresolved receipts hold later receipts for that destination so accumulation remains chronological; other destinations continue. Long outages or receipts absent from the APIs may prevent complete coverage. Dedup is retained for 30 days. As with the existing monitors, a crash between two durable queue writes can duplicate delivery.

`[UNIT] Scan succeeded` reports discovery position/lag, matched operations, queued alerts and pending verification. It confirms a scan, not Telegram delivery. Pending verification older than 15 minutes or failed operation lookups produces a warning. Confirmation/indexing delays occur before this monitor can alert, in addition to its polling interval.
