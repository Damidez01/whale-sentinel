# Original ChainHound: Telegram controls and extra accumulation

These changes apply to the original bot in this repository, not `sentinel-next`. No token monitor, extra chain, new receipt fetch, or wallet enrichment call is enabled.

## Deploy settings

Keep your existing RPC and Telegram variables. Your private-chat `TELEGRAM_CHAT_ID` also identifies the authorized user: only commands from that user in that private chat are accepted. No additional admin variable is needed. In a group, set `TELEGRAM_ADMIN_IDS` to a comma-separated list of numeric user IDs; group commands are denied without this list.

Attach a Railway volume at `/data`. Exclusions, pending alerts, sent-alert deduplication, and reply-to-wallet mappings are saved immediately to `/data/telegram-state.json` using atomic replacement. This file is separate from the original `store.json`. Use **one running replica**; concurrent writers/pollers are not supported. For local use, set `TELEGRAM_DATA_DIR` to a writable directory. Do not commit this state file or credentials. Corrupt/unwritable Telegram state stops initialization instead of silently losing exclusions.

## Commands

| Command | Effect |
| --- | --- |
| `/block 0xAddress reason` | Permanently suppress alerts whose subject wallet matches this address |
| `/unblock 0xAddress` | Remove its Telegram exclusion |
| `/remove 0xAddress` | Alias for `/unblock` |
| `/mute 0xAddress 24h` | Suppress the wallet temporarily; accepts `m`, `h`, or `d`, up to 365 days |
| `/blocked` | List active Telegram exclusions and reasons |
| `/help` | Show command usage |

New wallet alerts include a **Block wallet** button. Alternatively reply to one with `/block`, `/block exchange hot wallet`, `/mute 24h`, or `/unblock`. Replies use the saved message-to-wallet mapping, not text extracted from a forwarded message. Mappings retain the most recent 10,000 wallet alerts. Old alerts sent before this update need an explicit address.

Commands apply across EVM chains. They suppress the subject wallet's notifications, not blockchain transactions. They also remove queued alerts about that wallet. An already in-flight send may still arrive. Addresses without a designated alert subject (for example pool-wide summaries) cannot be blocked by replying to that summary.

Your built-in exclusions remain. `/unblock` does not remove an address hardcoded in the original script; `/blocked` lists Telegram additions only. Fan-out also skips legs involving a Telegram-excluded address, and accumulation skips excluded receivers. A flagged wallet sending to an excluded service is still eligible for contextual alerts about the flagged sender. Exclusions do not relabel other interacting wallets or erase tracking history.

## Two accumulation rules

Keep the original Railway variables at your intended original settings:

```text
ACCUM_MIN_USD=100000
ACCUM_COUNT=3
ACCUM_WIN_MIN=15
```

The additional rule defaults to:

```text
ACCUM_EXTRA_MIN_USD=50000
ACCUM_EXTRA_COUNT=5
ACCUM_EXTRA_WIN_MIN=30
```

The new rule requires **strictly more than $50,000 per transfer**, five transfers into the same wallet during the rolling 30-minute window. Incoming senders may differ, matching the original receiver-based accumulation model. Exactly $50,000 does not count. It escalates at seven, nine, and subsequent odd counts. These are native ETH values estimated by the existing price service, not DAI/USDT/USDC transfers.

The original rule and its three/five/seven-count escalation continue unchanged. Each original-rule alert suppresses additional-rule messages for that receiver for the original window length (15 minutes by default), while both counters continue updating. This gives the original incident priority rather than sending two alerts for the same accumulation. A later stronger original alert can still follow an earlier lower-threshold alert.

Counts use the original bot's processing-time windows and in-memory storage. They reset on process restart; this update does not add historical backfill or change transaction verification. Thresholds alone do not establish stolen origin.

## Delivery retries

Alerts enter the durable queue before transmission and are acknowledged only after Telegram reports success. Failures retry with exponential backoff capped at five minutes, honoring Telegram's `retry_after` when longer. Other ready alerts may proceed while one is waiting, except during a Telegram-wide rate-limit delay. Invalid Markdown gets a plain-text retry. Permanent permission/token errors retain alerts for retry after configuration is fixed and appear in logs.

Successful sends retain the existing five-minute dedup interval. If Telegram accepts a message but the response is lost, or the process exits before recording success, a duplicate can arrive. This is at-least-once delivery, not exactly-once. Startup and command responses use the same queue and may be delayed behind pending alerts.

`npm test` runs offline tests with temporary state files and mocked Telegram/RPC inputs. It does not start the bot, send real messages, or consume Alchemy CU. Live command/delivery behavior should be checked after deployment with `/help`, a temporary `/mute`, and `/unblock`.
