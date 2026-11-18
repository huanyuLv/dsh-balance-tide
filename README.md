# dsh-balance-tide

**English** | [简体中文](./README.zh.md)

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-DeepSeek%20Harness-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![version](https://img.shields.io/badge/version-0.5.2-4176E6)](package.json)

**DeepSeek Harness (DSH) plugin: account balance + peak/off-peak window indicator.**

Adds a line **below** the built-in composer status row (turns / steps / tok · cache hit · context):

```
[peak] ends 18:00 · 3h 45m left  next off-peak 18:00–tmrw 09:00 | Balance ¥28.78 | ~¥0.42 this session | ?
[off-peak] ends Mon 09:00 · 2d 14h left  next peak Mon 09:00–12:00 | Balance ¥28.78 | ~¥0.42 this session | ?
```

## Features

- **Current window**: `peak` / `off-peak` badge, judged live in Beijing time — weekends and Chinese public holidays included
- **When it ends**: end time of the current window plus time left, ticking every second
- **Next window**: start–end of the next window, e.g. `next peak 14:00–18:00`
- **Balance**: live balance from the official `/user/balance` endpoint
- **Session cost**: estimated at current-window prices (reuses `sessionProjections`; same turn/step samples replace rather than double-count)
- **Hover details**: current window start/end, weekend/holiday note, the official rule, and both price tables
- **`?` icon**: opens the official pricing page
- **Zero config**: reuses `DEEPSEEK_API_KEY` from DSH credentials — no key in the repo, ever
- **i18n**: 中文 / English

## Peak/off-peak rule (Beijing time)

Per the official pricing page (last verified 2026-11-18): Mon–Fri, excluding Chinese public holidays, 09:00–12:00 and 14:00–18:00 are peak; everything else — including weekends and public holidays all day — is off-peak. Off-peak = half of peak.

Public holidays: 2026 and 2027 are built in (from [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)); the server refreshes them daily via jsDelivr and falls back to the built-in table on failure. Make-up working weekends still count as off-peak, per the official wording.

| Model (CNY per 1M tokens) | Off-peak (hit / miss / output) | Peak (hit / miss / output) |
|---|---|---|
| deepseek-flash (legacy name deepseek-v4-flash, same price) | 0.02 / 1 / 4 | 0.04 / 2 / 8 |
| deepseek-v4-pro | 0.15 / 4.5 / 13.5 | 0.30 / 9 / 27 |

## Install

**From npm (recommended)**

```sh
dsh plugin --profile web add dsh-balance-tide
# desktop DeepSeek Harness.app uses the desktop profile:
dsh plugin --profile desktop add dsh-balance-tide
```

**From the Git URL**

```sh
dsh plugin --profile web add https://github.com/huanyuLv/dsh-balance-tide
```

**From a local directory**

```sh
dsh plugin --profile web add file:/path/to/dsh-balance-tide
```

Restart `dsh web` to take effect. Requires `pnpm` (`npm i -g pnpm`).

## Configuration (in `$DSH_HOME/profiles/web/cordis.patch.yml`)

```yaml
- id: dsh-balance-tide
  config:
    refreshIntervalMs: 300000   # how often the host polls the balance API
    clientPollIntervalMs: 30000 # how often the browser re-reads the cache
    currency: CNY
    allowedHosts: []            # register your domain here if you front dsh with a reverse proxy
```

When the official prices or the schedule change, override them in config — no need to
wait for a plugin release:

```yaml
- id: dsh-balance-tide
  config:
    tideCutoff: '2026-08-17T00:00:00+08:00'   # when peak/off-peak pricing starts
    peakWindows:                              # peak hours (Beijing time, [start, end))
      - { start: 9, end: 12 }
      - { start: 14, end: 18 }
    tidePrices:                               # per-window prices (per 1M tokens)
      peak:
        deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
      offpeak:
        deepseek-flash: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
    holidaySource: ''                         # empty = offline, built-in holiday table only
    extraHolidays: ['2026-12-24']             # extra all-day off-peak dates
```

`peakWindows: []` means there are no peak hours at all — use it if the tiered pricing
is ever withdrawn.

## Security

- **Credentials**: prefer `DEEPSEEK_API_KEY` from DSH credentials. The `apiKey` config
  option is an escape hatch only — it lands in a config file in plaintext, so **avoid it**.
  `baseUrl` must be https; plaintext http is rejected outright (it would put the key on
  the wire).
- **Balance endpoint**: `/query-tide` serves your account balance, so readers are checked.
  The Host must be localhost, an IP literal, or a domain registered in `allowedHosts`
  (this blocks DNS rebinding); any request carrying an Origin must be same-origin (this
  blocks arbitrary web pages from reading your balance). Rejected reads get a 403.
- **Error reporting**: the server sends only a small set of error codes to the browser;
  raw exception text goes to the log, so a custom `baseUrl` never leaks to the frontend.

## Known limitations

- Costs are **estimates** computed at current-period prices; the official invoice is authoritative.
- For multi-currency accounts the readout row shows the first currency only; the rest appear in the tooltip.
- `deepseek-chat` / `deepseek-reasoner` are no longer listed on the official pricing page —
  the static entries in `prices` are a fallback, not a verified quote.

## Development

```sh
npm install
npm test
```

## Compatibility

- DeepSeek Harness `0.1.0-rc.6` – `0.2.x` (web / desktop profile; verified on desktop 0.2.2-rc.3)
- Node.js 20 / 22 / 24 (covered by CI)
- Cross-platform: pure JavaScript + standard browser CSS, no native modules
- License: MIT
