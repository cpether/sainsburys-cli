# sainsburys-cli

Agent-friendly CLI for Sainsbury's Groceries Online (GOL). Sainsbury's has no official API — this tool drives the same reverse-engineered endpoints the web SPA uses, with a real (Playwright) browser handling login and checkout.

Build baskets, amend live orders, book delivery slots, apply coupons, and place orders — all scriptable, all with `--json` output and stable exit codes, so an AI agent (or a cron job) can do your weekly shop.

## Install

```sh
npm install -g @amar/sainsburys-cli
```

Postinstall downloads Chromium via Playwright. Login works best with system Chrome installed (the browser launches with `channel: "chrome"` to pass bot detection).

## Setup

```sh
cp .env.example ~/.config/sainsburys/.env
# edit: SAINSBURYS_EMAIL + SAINSBURYS_PASSWORD (quote the password!)
sainsburys auth login
```

Sessions persist to `~/.config/sainsburys/session.json` (chmod 600) and are refreshed automatically on 401. If your account has SMS MFA, either enter the code on stdin when prompted, or configure `SAINSBURYS_MFA_CHAT_ROOM_ID` to auto-read codes from a Matrix/Beeper SMS bridge.

## Usage

```sh
sainsburys basket show                    # current basket
sainsburys basket add 7457282 -q 2       # add by SKU
sainsburys basket remove 7457282
sainsburys product search "pizza"
sainsburys order list
sainsburys order amend <orderId>          # flip a placed order into amend mode
sainsburys slot list --week 2
sainsburys slot book <booking-key> 2026-01-06T11:00:00Z
sainsburys checkout --yes --headless      # place the order (drives the SPA)
```

Every command supports `--json` for structured output and `-v` for progress on stderr. Nested `--help` everywhere. Exit codes: `0` ok, `1` generic, `2` auth error, `3` API error, `4` no session.

Amendments are only committed once `checkout` completes — abandoning an amend-mode basket reverts the order at cutoff.

`checkout` pre-flights minimum spend, lists stored coupons (e.g. substitution refunds) and auto-applies them in the browser flow, refusing to place the order if a coupon fails to apply.

## How it works

1. **`src/auth/`** — Playwright drives the OAuth2/PKCE login against ORY Hydra, captures cookies, the `wcauthtoken` HMAC, and the Hydra bearer JWT.
2. **`src/client/`** — a `fetch` wrapper that replays the SPA's full header set and re-authenticates once on 401/403.
3. **`src/api/`** — typed wrappers for basket / order / product / slot / coupon / customer endpoints.
4. **`src/checkout/`** — checkout and coupon-apply are driven through the real browser, because those paths sit behind stricter bot checks.

`API_NOTES.md` documents the reverse-engineered API surface in detail (all sample values anonymised).

## Caveats

- **Sainsbury's ToS prohibits automated access.** This is a personal-use tool; use it on your own account at your own risk.
- Akamai Bot Manager and ThreatMetrix guard the login and legacy endpoints — hence the real-browser approach. Headless works today; if you get blocked, try headed (`SAINSBURYS_HEADED=1`).
- 3DS-challenged payments aren't handled headless.
- The API surface is unofficial and can change without notice.

## License

MIT
