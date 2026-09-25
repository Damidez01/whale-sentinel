# THORChain monitoring

Enabled by default. Monitors completed native BTC ↔ Ethereum ETH, WETH, USDT, USDC and DAI swaps. Matches full chain/contract identifiers, excluding synthetic/trade assets and lookalike tokens. Ordinary swaps can qualify; the rule does not prove theft.

Defaults (existing threshold overrides remain supported):

```text
THORCHAIN_ENABLED=true
THORCHAIN_MIN_SWAP_USD=500000
THORCHAIN_BURST_COUNT=3
THORCHAIN_BURST_WINDOW_MIN=30
THORCHAIN_POLL_MS=60000
THORCHAIN_MAX_PAGES=20
THORCHAIN_PENDING_PER_POLL=20
```

No new secret is needed. Uses the public Midgard endpoint in [THORChain's official examples](https://dev.thorchain.org/examples/tutorials.html): `https://gateway.liquify.com/chain/thorchain_midgard/v2`. Optional `THORCHAIN_MIDGARD` and `THORCHAIN_MIDGARD_FALLBACK` override provider order; the working public endpoint is retained as a fallback. URLs should end with `/v2`. Failures back off and log sanitized status, not credentials. Set `THORCHAIN_ENABLED=false` to turn it off.

Large swaps alert individually; starting at the third qualifying swap for the same Ethereum wallet and direction within 30 minutes, the latest swap produces a burst summary instead. Uses Midgard action timestamps, not polling time. Completed streaming swaps count once by input transaction, not once per outbound fragment. Affiliate outputs are excluded. Ethereum-side wallet links and block controls target the sender for ETH→BTC and receiver for BTC→ETH; transaction links use THORChain's explorer.

Midgard coin amounts use 1e8 precision. Use metadata `inPriceUSD` when valid; otherwise use the existing price service with a 15-minute maximum cached quote. There is no $1 fallback. Missing prices, ambiguous multi-recipient swaps and invalid data retain scan progress and log the reason.

The `/data` volume (or `TELEGRAM_DATA_DIR`) stores `thorchain-state.json`: scan cursor, pending swaps, burst windows, dedup and undelivered alerts. Keep one replica. First start examines roughly the last seven minutes; existing old `store.json` THOR cursors are not migrated. Later polls overlap two minutes and catch up in bounded ten-minute slices with token pagination. Up to 20 pages are read per slice; a page-cap failure preserves progress rather than skipping history. Pending swaps are rechecked by input transaction, at most 20 per poll in rotation, even after the scan cursor passes them. Provider indexing delayed beyond the overlap can still be missed if the pending action was never observed. Completed swap dedup is retained for 30 days; burst history is kept for two days. A delivery interruption across two durable writes can still duplicate an alert.

No Alchemy CU is used for THORChain scans. Midgard has its own availability/rate limits. One scan runs per minute; pages and pending lookups add HTTP requests. Settlement/indexing time can delay alerts beyond the polling interval. Look for `[THOR] Scan succeeded`; the startup module list alone does not confirm coverage.
