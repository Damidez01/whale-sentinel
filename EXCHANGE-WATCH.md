# ChangeNOW and FixedFloat wallet watch

This is a separate, explicitly selected wallet monitor. The five addresses in `src/monitors/exchange-wallets.json` were supplied by the user. Their service labels describe the user's watchlist, not independently verified ownership. The monitor detects direct inflows and verified one-hop routes into these hot wallets; it does not infer common ownership or link deposits to exchange payouts.

## One-hop deposits (enabled by default)

For both FixedFloat and ChangeNOW, the watcher starts with a confirmed transfer to the hardcoded hot wallet and looks back through the immediate sender's history. A route is **original wallet → fresh deposit address → watched hot wallet**. Alerts group by original wallet, hot wallet and chain. Separate deposit addresses can therefore contribute to the same accumulation alert. The freshness filter applies to each deposit address, not the original wallet; a busy original wallet is allowed.

Attribution requires complete bounded history of the forwarded asset, exactly one positive incoming funder, earlier funding, and sufficient received units to cover all observed forwards. Gas funding in another asset does not change attribution. Multiple funders of the same asset, incomplete history, same-block Ethereum funding/forwarding, and same-timestamp TRON funding/forwarding are not attributed. A wallet can still qualify for the existing direct-inflow rule when no original source can be established; unrelated immediate senders remain separate. No more than one hop is followed.

The existing thresholds remain: three qualifying transfers/routes, each forward worth at least $50,000, received by the same hot wallet within 15 minutes. The window uses **forwarding time**, not original funding time. Funding must be within `EXCHANGE_FRESH_MAX_HOURS` (48 by default). Split sweeps backed by the same set of funding transactions count as one route; multiple receipts through one deposit address are grouped conservatively. Amounts are counted only on the forwarding leg, never both legs. Quotes still determine USD eligibility, so exactly 50,000 stablecoin units may be below $50,000 if the quote is below $1.

Alerts name the original source, link up to five deposit routes with funding and forwarding transactions, and include all counted original/intermediate/hot addresses for blocking. Blocking any counted address removes the affected window rows and suppresses pending summaries. Verified history and attribution are cached per deposit event and settings and persist across restarts. Failed lookups retain the scan cursor for retry; there is no attribution from missing evidence. Set `EXCHANGE_ONE_HOP=false` to restore immediate-sender grouping for new events.

Asset scope: **Ethereum USDC/USDT/DAI; TRON USDT/native TRX**. Native ETH, wrapped TRX and TRON USDC are not monitored by this exchange module. Other bot modules keep their own asset rules. Upgrading clears old inflow windows and legacy queued exchange summaries that may contain removed assets; cursors, event dedup and blocks remain intact. The 30-minute alert freshness limit still prevents replaying old deposits on deployment.

| Service label | Chain | Watched address |
| --- | --- | --- |
| ChangeNOW | Ethereum | `0x3f3Ee0a9cAC2d01DB44001eca3E8382fbe40207B` |
| ChangeNOW | Ethereum | `0x64cdAA89629fe003eAa31B480d8b63372D109A53` |
| ChangeNOW | TRON | `TSBHPFbPUUntP8d3mZ4KzdCNJnFJDsDGCq` |
| FixedFloat | Ethereum | `0x4E5B2e1dc63F6b91cb6Cd759936495434C7e972F` |
| FixedFloat | TRON | `TDoXUNZ6PajKuiUkcYg3EDSV9bnqGqsbcf` |

## Rules

- Accumulation: **three distinct incoming transactions or verified funded routes from one original source to one watched hot wallet**, with forwards **each >= $50,000**, within **15 minutes**. Updates at 10, 20, 30, etc.; reached milestones stay suppressed until one hour of quiet. Supported assets combine for that source/destination pair on the same chain. Different original sources and watched destinations remain separate. Three token logs from one transaction do not count as three transactions; sub-threshold forwards cannot combine to pass the per-transfer threshold.
- Fan-out: the original `FANOUT_LEG_USD`, `FANOUT_MIN_LEGS`, and `FANOUT_WIN_MIN` settings apply: defaults **$10,000 per qualifying leg, three distinct destinations, 15 minutes**. Updates occur at 10, 20, 30, etc. destinations, with milestones reset after one hour of quiet. The original Ethereum exchange/router destination exclusions and Telegram destination blocks still apply. Supported assets can combine within the existing chain-specific asset scope.
- The dedicated watcher owns accumulation/fan-out for these hot-wallet subjects, avoiding duplicate alerts from the original generic rules. It bypasses built-in exclusions for the explicitly watched source/receiver. Manual Telegram blocks/mutes of the subject still suppress its alerts.
- General accumulation stays at its existing settings (normally $100k x 3 / 15 minutes plus >$50k x 5 / 30 minutes). THORChain is configured independently; see `THORCHAIN.md`.

On upgrade, old exchange-wide incoming windows and unsent incoming summaries are discarded because they may combine unrelated senders. This includes the Telegram delivery queue. Saved cursors, delivered-event dedup, wallet blocks and optional outgoing fan-out remain intact. New source-specific windows and counters survive restarts. Alerts name the sending wallet and watched exchange destination, and count only that pair's transfers.
- Windows use blockchain timestamps, persist across restarts, and remain separate per wallet/chain. Notifications describe exchange activity, not proof of theft.

## Assets and providers

Ethereum: **USDC, USDT and DAI** only. The Ethereum block feed already used by the original bot is shared with this monitor. The dedicated monitor waits for 12 confirmations by default. Token queries filter by the exact three official token contracts and watched sender/recipient addresses before results reach the bot. The old broad token subscription remains disabled. Native ETH does not generate exchange events or receipt/price lookups.

TRON: **TRX** and official **USDT (TRC-20)**, with confirmed account-history requests to TronGrid for the two watched addresses. TRON addresses are checksum-validated and preserve case. Telegram blocking/buttons/reply controls now support TRON too.

Only top-level native TRX transfers are covered; internal TRX contract transfers are not. Base, Arbitrum and other chains are not added. Price quotes are USD estimates, with cached quotes limited to 15 minutes. Missing prices pause that feed's cursor rather than assuming $1 for every asset.

## Railway

Keep the existing Ethereum and Telegram settings and `/data` volume. Add the following to enable TRON (never commit the actual key):

```text
TRONGRID_API_KEY=your_key
```

Without this key, Ethereum watch starts and TRON stays disabled with a clear log message. Get the key from [TronGrid](https://www.trongrid.io/). Keep one replica. Persistent state is `/data/exchange-watch.json`, or under `TELEGRAM_DATA_DIR` if explicitly configured. Keep the volume on redeploy.

Optional variables, already defaulted in code:

```text
EXCHANGE_WATCH_ENABLED=true
EXCHANGE_FANOUT_ENABLED=false
EXCHANGE_ACCUM_MIN_USD=50000
EXCHANGE_ACCUM_COUNT=3
EXCHANGE_ACCUM_WIN_MIN=15
EXCHANGE_POLL_MS=120000
EXCHANGE_ETH_CONFIRMATIONS=12
EXCHANGE_ETH_MAX_BLOCKS=25
EXCHANGE_TRON_MAX_PAGES=20
EXCHANGE_FRESH_ONLY=true
EXCHANGE_ONE_HOP=true
EXCHANGE_FRESH_MAX_TX=10
EXCHANGE_FRESH_MAX_HOURS=48
```

Use the existing `FANOUT_*` variables to adjust fan-out. Setting `EXCHANGE_WATCH_ENABLED=false` disables this dedicated module and restores the original generic accumulation/fan-out behavior for these addresses (including its built-in exclusions).

Exchange inflows require short observed history on the immediate deposit sender: at most 10 distinct observed transactions and earliest observed activity no more than 48 hours before forwarding. Original funders need not be fresh. This identifies deposit-like wallets, not theft or exchange ownership. Small gas payments count toward the transaction allowance but not qualifying deposits. `EXCHANGE_FRESH_ONLY=false` disables freshness eligibility; one-hop evidence requirements and bounded history still apply.

Checks run only for qualifying inflows. Ethereum checks sender code and outgoing nonce, plus bounded oldest-first incoming/outgoing asset-transfer history through the deposit block. TRON checks bounded native/account and token history through the deposit timestamp. Ethereum transfer history is not every possible transaction (for example, incoming zero-value contract calls may not be indexed); TRON internal transfers are not included. The age is first observed activity, not address generation time. Paginated/incomplete histories are not assumed fresh: pagination rejects the candidate conservatively; missing deposit indexing or unavailable providers retain the scan cursor for retry. No extra history queries are made for fan-out alone. New incoming windows start with verified deposits; old unchecked incoming windows are cleared on upgrade.

Results are cached per deposit event and configuration for two days, capped at 10,000 entries. Each uncached Ethereum candidate needs up to two ordinary RPC reads and four Alchemy Transfers API calls (two for freshness, two for same-token attribution). TRON needs up to three account-history calls. This adds usage according to deposit volume and is not covered by routine polling estimates below. Alchemy Transfers API support is required for Ethereum freshness and tracing.

Telegram blocks/mutes now exclude both endpoints from exchange inflow and fan-out counting. Active windows are pruned before the next rule evaluation/flush; queued exchange summaries involving any blocked counted wallet are discarded, including summaries that highlight a different wallet. Blocking does not retract Telegram messages already delivered. Unblocking does not replay pruned historical transfers. Other modules retain their existing behavior.

## Cost, timing and limits

Exchange fan-out is disabled by default. Only exchange inflows alert; the original general-wallet fan-out rule remains active. Pending exchange fan-out messages and windows are discarded on deployment. Ethereum omits the outgoing token-log query and TRON requests incoming history only. Set `EXCHANGE_FANOUT_ENABLED=true` only to explicitly restore exchange fan-out. The two-log-query baseline below applies when fan-out is enabled; with it disabled, there is one routine token-log query per Ethereum scan (before range splitting and retries).

At a two-minute polling interval, two filtered Ethereum `eth_getLogs` calls per scan are about **2.592M Alchemy CU per 30 days** at 60 CU per call. A canonical cursor block check per scan adds roughly **432k CU/month** at 20 CU each. History/attribution queries, uncached catch-up blocks, retries and failover add more. These figures are baseline estimates, not a monthly cap or live measurement. Original ETH scanning continues to consume its existing allowance. Increase `EXCHANGE_POLL_MS` for fewer routine queries and more delay.

The normal TRON baseline is four account-history requests per scan (two addresses x USDT/native), approximately **2,880 requests/day** at two-minute intervals, plus pagination. TronGrid quota is separate from Alchemy. Requests are serialized, and 429/errors retain progress until a later scan; the bot does not bypass provider rate limits.

Ethereum alerts can lag roughly 12 blocks plus one polling interval. It starts from the current confirmed target on first use and resumes its saved block cursor thereafter. Missing blocks after a disconnect are fetched in bounded batches; the original monitor itself is not rewritten. A detected reorganization stops the dedicated Ethereum cursor for inspection instead of silently accepting conflicting history.

TRON begins with a short recent window, uses a two-minute overlap for indexer delay, and processes bounded five-minute catch-up ranges with pagination. If the page cap is hit, progress is retained and an error is logged; increasing `EXCHANGE_TRON_MAX_PAGES` may be necessary for very busy periods. Indexer records delayed beyond the overlap can be missed. When TronGrid omits an event index, identical same-transaction/from/to/value USDT records are deduplicated together; this can undercount totals for identical multiple transfers within one transaction, but they still represent only one accumulation transaction.

Pending alerts are persisted before handoff to the existing durable Telegram queue. Duplicate delivery remains possible if a process crashes between two durable acknowledgements. Native-feed readiness and ongoing failures are logged as `[Exchange:ETH]` / `[Exchange:TRON]`; inspect these rather than treating a startup module list as proof of successful scanning.

## Verification

`node scripts/capture-exchange-hop-example.js` reads public Blockscout history for three deposit addresses funded by `0x0a30aF43267b8C63B0Fa6580Dc3c29C8fb231345` and refreshes `test/fixtures/fixedfloat-hop.json`. It does not load credentials or send alerts. The regression test replays that history at its historical event time through the actual freshness, attribution and grouping code. On October 17, 2026 the three 50,000 USDT forwards reached FixedFloat at 17:51:59, 17:54:23 and 17:59:47 UTC, yielding one 150,000 USDT group. The replay uses $1 solely as a test valuation; it does not validate historical production prices or Railway configuration. Synthetic tests cover ChangeNOW, both TRON assets, mixed origins, duplicate sweeps, blocking, provider failure and restart recovery.

Price recovery: CoinGecko is tried first, followed by Coinbase's public USD spot endpoint when available for that asset. Failed sources back off for at least 60 seconds (or their Retry-After), concurrent requests for the same asset share one lookup, and exchange scans accept cached quotes for at most 15 minutes. No stablecoin is silently valued at $1. `[Prices]` warnings identify the failed source and HTTP status without printing credentials. If both sources fail and no recent quote exists, scanning still pauses safely.

Ethereum RPC warnings identify the provider number, failing method and HTTP/RPC error code. Explicit log-range/result-size rejections are retried in smaller ranges; this may add RPC calls. Quota and authentication failures are not treated as range failures. These still require checking provider allowance or Railway credentials. Saved progress is retained until the entire scan succeeds.

`npm test` checks threshold boundaries, distinct transactions/destinations, asset aggregation, exclusions, restart recovery, filtered requests, duplicate logs, failed receipts, pagination failure, TRX conversion, and TRON command handling without contacting providers or sending Telegram messages. Actual credentialed provider throughput and deployment still need observation after rollout.

Sources: [Alchemy log filters](https://www.alchemy.com/docs/reference/logs), [Alchemy costs](https://www.alchemy.com/docs/reference/compute-unit-costs), [TronGrid token history](https://developers.tron.network/reference/get-trc20-transaction-info-by-account-address), [TronGrid native history](https://developers.tron.network/reference/get-transaction-info-by-account-address), [TronGrid rate limits](https://developers.tron.network/reference/rate-limits), [Tether supported protocols](https://tether.to/es/supported-protocols/).

### Value-doubling updates

Fan-out and accumulation also send an update when the rolling USD total reaches twice the total at the last alert, provided the initial count threshold still holds. Count milestones and value doubling are alternative triggers; one event produces one update. Each update resets the value baseline. Window dips do not reset reached milestones. Tornado remains count-only at 3, 10, 20, 30, etc.
