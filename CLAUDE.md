# Sainsbury's CLI

A CLI tool that lets AI agents programmatically interact with Sainsbury's Groceries Online (GOL) — amend live orders, build new baskets, manage favourites, book slots — without an official API.

## Status
**Stage 2: built.** Node/TS CLI with Playwright login, HTTP client with auto-reauth, basket/order/product/customer modules, and a non-destructive test suite (32 tests).

- `API_NOTES.md` — reverse-engineered API surface. Read this first when extending.
- `*.har` — gitignored traffic captures used for reverse-engineering. They contain session cookies and personal data — never commit or share them.
- `src/` — implementation. Layout below.
- `test/` — `node:test` + `tsx`. Unit tests use a fake `fetch`; the CLI smoke test spawns `tsx` and exercises help only.

Run `npm install` (auto-installs Chromium for Playwright via postinstall), set `.env` (copy from `.env.example`), then `npm run dev -- auth login` for the first run.

## Architecture

Three layers, in dependency order:

1. **`src/auth/`** — Playwright drives the OAuth2/PKCE dance against ORY Hydra. After login it intercepts an outgoing `/groceries-api/` request to capture the `wcauthtoken` HMAC, harvests cookies via `context.cookies()`, and persists everything to `~/.config/sainsburys/session.json` (chmod 600).
2. **`src/client/http.ts`** — `GroceriesClient` wraps `fetch`, attaches the SPA's full header set (UA, sec-ch-ua, origin, referer, `enabled-feature-flags`, cookie jar, `wcauthtoken`). On 401/403 it invokes the configured `reauth` callback **once** and retries.
3. **`src/api/`** — typed wrappers for basket / order / product / customer endpoints. Pure functions taking a `GroceriesClient`.

`src/cli/` uses `commander` with nested subcommands (`auth`, `basket`, `order`, `product`, `customer`). Global flags: `--json` (structured output), `-v` (stderr progress), `--store <N>`. Exit codes: 0 ok, 1 generic, 2 AuthError, 3 ApiError, 4 no session.

There is no `Authorization: Bearer`, no CSRF token. After login, auth = `Cookie` + `wcauthtoken: <userId>,<base64hmac>`.

## API base
`https://www.sainsburys.co.uk/groceries-api/gol-services/...`

Critical endpoints (full details in `API_NOTES.md`):
- `basket/v2/basket` — GET basket, PUT to update items. Basket *is* a draft order (`basket_id == order_id`).
- `basket/v2/basket/item` — POST to add. DELETE/PATCH unobserved; needs capture.
- `order/v1/order/status` — active in-flight order summary.
- `order/v1/order/{orderId}` — full order with `order_items[]`.
- `order/v1/order/{orderId}/amend` — POST (empty body) to flip an order into amend mode; from then on `/basket` returns the order's items as an editable basket. Finalise via the standard checkout flow.
- `product/v1/product?uids=<csv>` — bulk SKU lookup.
- `product/v1/favourites`, `favourites-by-pattern?pattern=usuals` — favourites.
- `slot/v1/slot/reservation` — current/active slot. Booking POST unobserved.

## Capture gaps (open)
Resolved in the second HAR: cookies, basket delete (= PUT qty 0), keyword search (= `/product/v1/product?filter[keyword]=`).

Still uncaptured / not wired up:
- **Slot booking** POST — out of scope for now.
- **Favourites add/remove** — out of scope for now.
- **Checkout flow** to finalise an amendment — `/checkout/v2/checkout/start`, `payment/start`, `payment/process` are documented in `API_NOTES.md` but not exposed via the CLI yet. `order amend <id>` flips into amend mode but the user must finalise via the website (or we extend the CLI).

## Constraints / risks
- Akamai Bot Manager — sensor stream at `/UPUWYeuN7oRRTeB5AA/...` (~10% of traffic). Don't hand-roll; use a real browser.
- ThreatMetrix at login — ~3.5KB `ioBlackBox` payload, computed by their JS, validated server-side.
- Sainsbury's ToS prohibits automated access. Personal use at own-account risk.

## Working notes
- All identifiers are numeric (orderIds 10 digits, product SKUs 4-7 digits, store_number 4 digits zero-padded, e.g. `2168` = home store).
- `pick_time`, `store_number`, `slot_booked` query params are required on most basket/product calls — they gate availability/pricing.
