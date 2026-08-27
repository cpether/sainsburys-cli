# Sainsbury's Groceries Online (GOL) — Private API notes

Source: HAR captures `www.sainsburys.co.uk.har` (867 entries, manual session 2026-04-06, cookies redacted) and `www.sainsburys.co.uk-new.har` (981 entries, 2026-05-04, cookies present + missing flows exercised). All API base paths live under `https://www.sainsburys.co.uk/groceries-api/...`.

> **HAR caveats**: the original capture had `Cookie` / `Set-Cookie` headers stripped and empty `cookies[]` arrays. The new capture has them populated — §2 cookie list is now from observation, not inference. Response bodies on most basket GETs are still missing (only `size` recorded, no `text`), but enough have bodies to confirm shapes.

---

## 1. Auth flow

The login is a 4-stage OAuth2 + PKCE flow with a separate "session bridge" call. Identity is provided by **ORY Hydra** at `https://account.sainsburys.co.uk/oauth2/...`; the audience is `gol.sainsburys.co.uk`, client_id `gol`, scopes `openid offline gol-session`.

### Stage 0 — bootstrap on the SPA
```
POST /groceries-api/gol-services/login/v1/login-start
  → 204 No Content (empty body)
```
Headers: `wcauthtoken: ""` (empty string). No cookies of interest captured. Response sets `correlation-id` and standard cache-busters; almost certainly also issues an Akamai/session cookie (redacted). Purpose: SPA tells the BFF "I'm about to start logging in" and the BFF prepares server-side session state.

### Stage 1 — kick off the OAuth dance
The SPA navigates the browser to:
```
GET https://account.sainsburys.co.uk/oauth2/auth
    ?missionId=gol
    &audience=gol.sainsburys.co.uk
    &client_id=gol
    &redirect_uri=https://www.sainsburys.co.uk/gol-ui/oauth/redirect
    &response_type=code
    &scope=openid offline gol-session
    &state=<random-hex-32>
    &code_challenge=<base64url-S256>
    &code_challenge_method=S256
    &response_mode=query
```
This is **PKCE with S256**. Sample values from the capture:
- `state = 00000000000000000000000000000000`
- `code_challenge = REDACTED_CODE_CHALLENGE_SAMPLE_S256_B64URL`

Hydra responds `302 → /login-init?login_challenge=<hex32>` then `→ /gol/login?login_challenge=...` which serves the React login UI.

### Stage 2 — credential POST (Hydra login form)
```
POST https://account.sainsburys.co.uk/gol/login   (form-urlencoded)
  username=<email>
  password=<plain>
  login_challenge=<from previous step>
  web_authn_device=0
  ioBlackBox=<~3.5KB ThreatMetrix device fingerprint>
  → 302 → /oauth2/auth?...&login_verifier=<hex32>...
```
**`ioBlackBox` is a LexisNexis ThreatMetrix payload** (their device fingerprint blob). The login form's JS computes it before submit. It is checked server-side; replaying old values may fail device-risk scoring.

After Hydra's silent consent (`/oauth2/auth?...&consent_verifier=...` → `/consent?consent_challenge=...` → another `/oauth2/auth` with `consent_verifier`), the user is redirected to:
```
https://www.sainsburys.co.uk/gol-ui/oauth/redirect?code=<auth-code>&scope=...&state=...
```

### Stage 3 — exchange code for app session
The SPA at `/gol-ui/oauth/redirect` does *not* run a standard PKCE token exchange against Hydra. Instead, the browser fetches `GET /groceries-api/gol-services/login/v1/time` (a server-time probe) and then calls:
```
POST /groceries-api/gol-services/login/v1/login-access-token
Content-Type: application/json
Body: { "access_token": "<JWT>", "food_profile_create": false }
  → 200 OK   (empty JSON-ish body, but ~470 bytes — contains a session payload that is redacted in this HAR)
```
The `access_token` posted is a **signed JWT** issued by Hydra (visible in HAR). Its decoded payload:
```json
{
  "aud": ["gol.sainsburys.co.uk", "account.sainsburys.co.uk"],
  "client_id": "gol",
  "scp": ["openid","offline","gol-session"],
  "sub": "00000000-0000-4000-8000-000000000000",   // identity_id
  "iss": "https://account.sainsburys.co.uk/",
  "iat": 1775478270, "exp": 1775481871,             // 1 hour TTL
  "jti": "11111111-1111-4111-8111-111111111111"
}
```
**Implication**: Hydra hands the SPA a short-lived JWT. The SPA hands that JWT to the GOL BFF, which verifies it, mints its **own** session/cookie + the `wcauthtoken` HMAC, and replies with `Set-Cookie` (redacted in HAR). From this point on the JWT is no longer used; only the cookie + `wcauthtoken` header authenticate further calls.

### Net auth model for a CLI client
You need to replicate three layers:
1. **Akamai Bot Manager cookie/sensor** (see §5) — without it, you'll be 403'd at the edge.
2. **Hydra OAuth2/PKCE login** — POST to `/gol/login` with username/password/login_challenge plus a valid-looking `ioBlackBox` (ThreatMetrix). Then follow redirects to harvest the auth code.
3. **`POST /login-access-token`** — exchange the Hydra JWT for the GOL session cookie. Persist that cookie. Read the `wcauthtoken` from the SPA bootstrap (it's a userId + HMAC; format below) and send it on every subsequent call.

There is no refresh-token call in the capture. Sessions are presumably refreshed by re-running the OAuth dance (the JWT has `offline` scope, so a refresh token exists on Hydra's side, but the SPA never calls a refresh endpoint visibly — it likely relies on the GOL session cookie's longer TTL and re-runs login-access-token on JWT expiry).

---

## 2. Required headers/cookies for authenticated calls

Sample: `GET /groceries-api/gol-services/basket/v2/basket?calculate=true&pick_time=2026-04-07T00:00:00Z&store_number=2168&slot_booked=true`

Headers actually sent (all values verbatim from HAR except `cookie` which was redacted):
```
:authority: www.sainsburys.co.uk
:method: GET
:path: /groceries-api/gol-services/basket/v2/basket?...
:scheme: https
accept: application/json
accept-encoding: gzip, deflate, br, zstd
accept-language: en-GB,en;q=0.9
content-type: application/json
dnt: 1
enabled-feature-flags: <giant comma-separated list, see below>
priority: u=1, i
referer: https://www.sainsburys.co.uk/gol-ui/...
sec-ch-ua: "Chromium";v="146", ...
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Linux"
sec-fetch-dest: empty
sec-fetch-mode: cors
sec-fetch-site: same-origin
sec-gpc: 1
traceparent: 00-<32hex>-<16hex>-01            # New Relic browser RUM
tracestate: 2092320@nr=0-1-NNNNNNN-NNNNNNNNN-<spanid>----<epoch_ms>
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ... Chrome/146.0.0.0
wcauthtoken: 123456789%2CAbCdEfGhIjKlMnOpQrStUvWxYz0%3D
[Cookie: <REDACTED in HAR — but the JS clearly does `credentials: include`>]
```

### Observed cookies on authenticated `/groceries-api/...` calls

Pulled with `jq '.log.entries[] | select(.request.url | contains("groceries-api")) | .request.cookies[].name'` on the new HAR, deduped:

**Akamai Bot Manager / edge** (refreshed continuously by the `/UPUWYeuN7oRRTeB5AA/...` sensor stream):
- `_abck` — main BM token. TTL ~1 year (e.g. `Set-Cookie expires` 2027-05-04). Re-stamped on virtually every request.
- `bm_sz` — BM session, ~2h TTL.
- `bm_sv` — BM session validation, ~2h TTL.
- `bm_s`, `bm_so`, `bm_ss`, `bm_lso` — additional BM cookies (mostly session/short-lived; `bm_s` ~30 days).
- `ak_bmsc` — Akamai BM session, ~2h TTL.
- `akavpau_vpc_gol_default` — Akamai virtual-IP-controller session marker (session cookie).
- `akaas_gol_global`, `akaas_gol_random` — Akamai App-Aware Service routing (session).

**AWS ALB** (origin LB stickiness):
- `AWSALB`, `AWSALBCORS` — 7-day TTL.

**WebSphere Commerce app session** (the GOL backend):
- `JSESSIONID` — session.
- `WC_SESSION_ESTABLISHED` — session.
- `WC_AUTHENTICATION_123456789` — keyed by `userId`, **this is the auth-bearing cookie**. Pairs with the `wcauthtoken` header (which is essentially this cookie's value re-presented).
- `WC_USERACTIVITY_123456789` — keyed by `userId`, last-activity tracker.
- `WC_ACTIVEPOINTER` — store/locale pointer.
- `WC_PERSISTENT` — long-lived persistent prefs.
- `Apache` — Apache server session marker (session).

**Other**:
- `__Secure-identity.transfer-token` — Hydra cross-domain identity transfer (set by `account.sainsburys.co.uk`, replayed on `www.sainsburys.co.uk`). Used during the OAuth bounce.
- `utag_main` — Tealium analytics (not auth-bearing, but the SPA always sends it; omitting may not break anything).
- `SESSION_COOKIEACCEPT` — cookie-banner consent flag.

The user-keyed cookies (`WC_AUTHENTICATION_<userId>`, `WC_USERACTIVITY_<userId>`) are the smoking gun — `userId=123456789` matches the prefix of `wcauthtoken` (`123456789%2C...`).

### Minimum cookies a non-browser client must replay

Now grounded in observation:
- **Auth (mandatory)**: `WC_AUTHENTICATION_<userId>`, `WC_USERACTIVITY_<userId>`, `JSESSIONID`, `WC_SESSION_ESTABLISHED`. Without these the BFF returns 401 (entries 43/50 in the new HAR, before the auth cookies were established, returned 401).
- **Edge (mandatory)**: `_abck`, `bm_sz`, `bm_sv`, `ak_bmsc`. These are scored by Akamai BM; a stale or absent `_abck` triggers a challenge.
- **LB stickiness (probably mandatory under load)**: `AWSALB`, `AWSALBCORS`. The ALB hashes on these to keep you on the same origin instance.
- **Likely optional but cheap to send**: `bm_s`, `bm_so`, `bm_ss`, `bm_lso`, `akaas_*`, `akavpau_*`, `WC_ACTIVEPOINTER`, `WC_PERSISTENT`, `Apache`, `__Secure-identity.transfer-token`, `utag_main`, `SESSION_COOKIEACCEPT`. Replay them all — fingerprint cost of dropping any is unclear.

### Other request headers (unchanged from previous capture)
- `wcauthtoken: <userId>,<base64hmac>` (URL-encoded). Sent on every `/groceries-api/...` call alongside the cookie. Server-side it's likely cross-checked against `WC_AUTHENTICATION_<userId>`.
- `accept: application/json`, `content-type: application/json` (even on GETs).
- `user-agent`, `accept-language`, `sec-*` and `sec-ch-ua-*` headers — Akamai BM scores you on these.
- `referer` and `origin: https://www.sainsburys.co.uk` — Akamai checks origin on writes.
- `enabled-feature-flags` — large feature-flag manifest. SPA always sends; behaviour without it not yet probed.

**Correction (verified live 2026-05-17)**: the SPA also sends `Authorization: Bearer <Hydra-JWT>` on essentially every `/groceries-api/` call. Reads (`GET /basket`, `GET /customer/profile`, `GET /order/status`, etc.) happen to work without it because the WCS cookie + `wcauthtoken` alone is sufficient. **Writes (POST/PUT to `/basket/item`, `/order/{id}/amend`, `/checkout/...`) return 401 without the Bearer header.** The JWT is the same Hydra access token (~1h TTL, `sub` = identity UUID) — captured during Playwright login alongside `wcauthtoken`. When it expires, the SPA refreshes silently — we just re-run Playwright.

No `X-CSRF-Token`, no `X-Requested-With`. Auth on writes = `Cookie` + `wcauthtoken` + `Authorization: Bearer <JWT>`.

Also: the basket Cookie header must not include cookies scoped to `account.sainsburys.co.uk` (Hydra-internal cookies like `login_challenge`, `oauth2_*_csrf`). Sending them confuses the WCS backend and triggers a 401 plus `Set-Cookie: WC_AUTHENTICATION_<userId>=DEL` to nuke the session. Filter cookies by host: only `www.sainsburys.co.uk` and bare-domain `.sainsburys.co.uk` cookies should be replayed.

### `wcauthtoken` format
`<numeric_userId>,<base64-encoded-HMAC>=`, URL-encoded so `,` → `%2C`, `=` → `%3D`. Sample: `123456789%2CAbCdEfGhIjKlMnOpQrStUvWxYz0%3D`. The userId matches `customer.user_id` returned by `/customer/v1/customer/profile`. The HMAC is opaque; it's a IBM WebSphere Commerce legacy auth token (the name `wcauthtoken` is straight out of WCS) — server-issued, you cannot forge it; it must be obtained from a successful `login-access-token` exchange.

### Bot-protection traffic (Akamai Bot Manager)
The HAR contains **54 requests** to obfuscated paths under `/UPUWYeuN7oRRTeB5AA/...` (e.g. `/UPUWYeuN7oRRTeB5AA/fazOrXctuL4DLt7r/TVhVX1U/IW1nBTM2/HhUB`). These are POSTs of `Content-Type: text/plain` with bodies like:
```json
{"sensor_data":"3;0;1;0;3617593;Dxxo1C/tT3bjF+AgIcJpiq+nfWWEx6fzWEIBXvT2wv0=;73,0,0,0,6,0;hQ\"p{F\"...
```
Body sizes ~2-15KB. This is **Akamai Bot Manager's `_abck` sensor data**: the obfuscated JS in the page collects mouse moves, key timing, screen properties, WebGL/canvas fingerprints and POSTs them to refresh the `_abck` cookie. The path is randomised per-tenant (`UPUWYeuN7oRRTeB5AA/...`). Sample GET (with `?v=<uuid>`) loads the obfuscated sensor JS bundle.

**Implication for the CLI**: stripped of a real browser this entire sensor stream cannot be reproduced. Without a fresh `_abck` cookie that has passed Akamai's heuristics, requests to `/groceries-api/...` will be challenged or 403'd. Two practical options:
- **Headless browser**: Playwright/Puppeteer with stealth, run through full login, extract cookies + `wcauthtoken`, hand them to a thin HTTP client. Periodically rerun the browser to refresh.
- **Cookie reuse**: scrape from a logged-in real browser (export cookies from your own session) and feed them to the CLI; this works until Akamai's session cookie expires (typically tens of minutes to a few hours, plus periodic re-validation hits).

Going pure-HTTP without a browser is technically possible (people have RE'd Akamai sensor) but is a maintenance treadmill — every Akamai BM minor release breaks the sensor format. Don't.

---

## 3. Critical endpoints

Base: `https://www.sainsburys.co.uk/groceries-api/gol-services`. All authenticated calls require the cookie+wcauthtoken pair from §2.

### 3.1 Basket

**`GET /basket/v2/basket`**
Query params (all observed):
- `pick_time` — ISO-8601, used to gate availability and pricing (e.g. `2026-04-07T00:00:00Z`). When no slot is booked: looks like the SPA passes "now" rounded.
- `store_number` — 4-digit store id (`2168` shows up as a pre-slot default).
- `slot_booked` — `true|false`.
- `calculate=true` — recompute totals/promotions.

Response (empty basket, real example):
```json
{
  "basket_id": "1280000003",
  "order_id": "1280000003",
  "subtotal_price": 0,
  "total_price": 0,
  "savings": 0,
  "vouchers_savings": 0,
  "minimum_spend": 25,
  "has_exceeded_minimum_spend": false,
  "is_in_amend_mode": false,
  "item_count": 0,
  "items": [],
  "delivery_instructions": "",
  "promo_savings": 0,
  "nectar_savings": 0,
  "your_nectar_savings": 0,
  "error": [
    {"code":"VOUCHER_TOTAL_EXCEEDS_TOTAL", "message":"Voucher Amount exceeds basket sub total"},
    {"code":"PCS_API_FAILED", "message":"Unable to get Nectar prices from PCS"}
  ]
}
```
Items, when present, mirror the `order_items` shape (see §3.3). Note `basket_id == order_id` — the basket *is* a draft order. `error[]` is informational, not fatal (200 status).

**`POST /basket/v2/basket/item`** — add item
Same query params as basket GET. Body:
```json
{ "product_uid": "8194039", "quantity": 1, "uom": "ea", "selected_catchweight": "" }
```
- `uom` ∈ `{ea, kg, ...}`.
- `selected_catchweight` is non-empty only for catchweight items (e.g. loose meat) where the user picks a target weight from a dropdown.
Response: empty (200). The SPA refetches `/basket` after to get the new state.

**`PUT /basket/v2/basket`** — update quantity / replace item / **delete item (qty 0)**
Body shape (increment):
```json
{ "items": [
    { "product_uid": "7566892", "quantity": 3, "uom": "ea", "selected_catchweight": "", "item_uid": "28466370367" }
] }
```
Decrement (note the optional `decreasing_quantity` flag the SPA adds when going down):
```json
{ "items": [
    { "product_uid": "7566892", "quantity": 2, "uom": "ea", "selected_catchweight": "", "item_uid": "28466370367", "decreasing_quantity": true }
] }
```

**Delete = PUT with `quantity: 0`** (confirmed; user verified, no separate `DELETE` endpoint exists). Exact body observed (entry 347 in new HAR):
```json
{ "items": [
    { "product_uid": "8202235", "quantity": 0, "uom": "ea", "selected_catchweight": "", "item_uid": "28466370549", "decreasing_quantity": true }
] }
```
- URL: `PUT /groceries-api/gol-services/basket/v2/basket?pick_time=2026-05-05T00%3A00%3A00Z&store_number=2168&slot_booked=true`
- Response status: `200`, body: literal `null` (i.e. JSON null, not an empty string). The SPA refetches `/basket` afterward.
- Net effect: the line is **removed**. The next captured basket GET with body (entry 909) shows `item_count: 0`, `items: []` — the qty-0 line does not stick around. (The *immediately* following basket GET responses in the HAR happen to have empty `text` fields — only `size` is recorded — but the eventual final-state GET confirms removal.)

`item_uid` is the basket-line identifier (not the product SKU). Returned in the basket items list. The capture only ever sends one item per PUT call — likely the SPA does N PUTs rather than batching, but the `items` array shape suggests the BFF would accept N entries in one call.

There is **no `DELETE /basket/v2/basket/item` endpoint** — `jq '.log.entries[] | select(.request.method == "DELETE")'` returns 0 rows on both HARs.

### 3.2 Order — list + status + detail

**`GET /order/v1/order?page_size=10&page_number=1`** — order history (response body wasn't captured in HAR, but the URL pattern is straightforward; expect `{ orders: [...], page: {...} }`).

**`GET /order/v1/order/status`** — *active/in-flight* order summary. Response:
```json
{
  "order_uid": "1280000002",
  "is_in_amend_mode": true,
  "is_cutoff": false,
  "cutoff_time": "2026-04-06T22:00:00Z",
  "slot_start_time": "2026-04-07T18:00:00Z",
  "slot_end_time": "2026-04-07T19:00:00Z",
  "order_type": "delivery",
  "total": 75.25
}
```
Empty body when no current order — probably `{}` or 204.

**`GET /order/v1/order/{orderId}?placed=true&deliveryPass=false`** — full order. Top-level keys:
```
order_uid, status, order_type, slot_start_time, slot_end_time, slot_van_status,
slot_price, store_identifier, address_uid, delivery_address, payment, sub_total,
total, adjustment, savings, savings_offer, savings_np, savings_ynp, vouchers_savings,
carrier_bag_charge, click_and_collect_uid, cutoff_time, is_cutoff, is_cancellable,
is_in_amend_mode, amend_cutoff_message, receipt_url, delivery_pass_email, order_items[]
```
Sample full values:
```json
{
  "order_uid": "1280000001",
  "order_type": "delivery", "status": "scheduled",
  "slot_start_time": "2026-04-07T18:00:00Z", "slot_end_time": "2026-04-07T19:00:00Z",
  "store_identifier": "2168", "total": 90.05, "sub_total": 90.05,
  "address_uid": "100000001",
  "is_in_amend_mode": false, "is_cancellable": true, "is_cutoff": false
}
```
`payment`:
```json
{ "masked_card_number": "***************1111", "is_preferred": true,
  "expiry_year": "2029", "expiry_month": "11", "card_uid": "6",
  "authorised": true, "card_network": "Mastercard Debit" }
```
`delivery_address`:
```json
{ "address_uid": "100000001", "nickname": "Home", "postcode": "AB1 2CD",
  "street": "Example Street", "building_name": "1, Example House",
  "town": "Exampletown", "county": "London", "country_code": "GB",
  "delivery_instructions": "" }
```

`order_items[]` element (line item):
```json
{
  "quantity": 1, "uom": "kg", "sub_total": 1.75,
  "allow_substitutions": true,
  "create_date": "2026-04-06T12:25:49Z",
  "product": {
    "product_uid": "7457282",
    "product_type": "BASIC",
    "name": "Dr. Oetker Ristorante Pepperoni-Salame Pizza 320g",
    "image_url": "https://assets.sainsburys-groceries.co.uk/gol/7457282/image.jpg",
    "product_url": "//www.sainsburys.co.uk/gol-ui/product/dr-oetker-ristorante-pizza-pepperoni-salame-320g",
    "adjustment": [ { "currency":"GBP","usage":"Discount","amount":"-1.75","description":"N4E","code":"7341-10737561" } ],
    "totalAdjustment": { "value": "-1.75", "currency": "GBP" },
    "promotion_data": { "applied_promotions": [...], "missed_promotions": null },
    "xiamou_promo_strap_line": "Buy 1 for 1.75",
    "reviews": { "is_enabled": true, "average_rating": 4.6196 }
  }
}
```
Items don't carry their own `item_uid` here; that lives on the *basket* representation.

**`POST /order/v1/order/{orderId}/amend`** — kick off amendment.
Empty request body, empty response body, returns 200. Side effects only:
- Server-side flips the order into amend mode (`/order/status` now returns `is_in_amend_mode: true` for the same order_uid).
- Subsequent `/basket` calls return the order's items as a basket the user can edit.
- Slot reservation gets re-bound to the order (`/slot/reservation?order_uid=<id>`).

To finalise the amendment the SPA goes through the normal checkout flow (`checkout/v2/checkout/start`, `payment/start`, `payment/process`).

### 3.3 Product

**`GET /product/v1/product?uids=<csv>&...`** — bulk lookup by SKU.
Query params (real example):
```
uids=7457282,7659331,9126,8202235,7566892    (URL-encoded commas)
filter[available]=true
include[MAIN_CATEGORIES]=true
include[DIETARY_PROFILE]=true
include[REPLACEMENT_PRODUCTS]=true
include[PRODUCT_AD]=citrus
minimised=true|false
store_identifier=2168
slot_date=2026-04-07
slot_datetime=2026-04-07T18:00:00Z
slot_type=delivery
flexi_stores=2168
```
Response shape:
```
{ "controls": { sort, page, filters, total_record_count, returned_record_count }, "products": [ ... ] }
```
A product object has 60+ fields. Key ones:
```
sainId (8-char alphanum), product_uid (numeric SKU), eans[],
name, full_url, product_type, main_category {pimid,id,name,level},
unit_price {price, measure, measure_amount}, retail_price, original_unit_price,
is_available, promotions[], hfss_restriction[], not_for_eu, is_alcoholic,
is_intolerant, badges[], labels[], reviews {total, average_rating},
breadcrumbs, assets {plp_image, images, video}, description, short_description,
categories[], associations[]
```
**Keyword search** (confirmed from the new HAR — user typed "test keyword" into the site search bar):

```
GET /groceries-api/gol-services/product/v1/product
    ?filter[keyword]=test%20keyword
    &include[PRODUCT_AD]=citrus
    &citrus_max_number_ads=5
    &page_number=1
    &page_size=60
    &sort_order=FAVOURITES_FIRST
    &store_identifier=2168
    &region=England
    &flexi_stores=2168
    &salesWindow=1
```

Search **hits the same `/product/v1/product` endpoint** as bulk-by-`uids` — there is no separate `/search` path. The discriminator is `filter[keyword]=<query>` instead of `uids=<csv>`. URL-encoding: spaces are `%20` (not `+`), brackets `[]` may be sent literally or as `%5B%5D` depending on the SPA codepath (both work; the new HAR has both forms across two near-identical calls).

Observed `sort_order` values: `FAVOURITES_FIRST` (default), and the response's `controls.sort.options` enumerates the user-selectable values: `-relevance`, `price`, `-price`, `-customer rating`. Pass `sort_order` to override.

**Response shape** (top-level keys):
```json
{
  "products": [ /* same product object as bulk-by-uids, see above */ ],
  "controls": {
    "sort": { "active": "-relevance", "options": [ ... ] },
    "total_record_count": 28,
    "returned_record_count": 28,
    "page": { "active": 1, "first": 1, "last": 1, "size": 60, "size_options": [30, 60, 90] },
    "filters": [ ... ],
    "cat_filters": [ ... ],
    "searchterm_hfss_restricted": false,
    "category_match": null
  },
  "suggested_search_terms": [ ... ]
}
```

For "test keyword" the BFF returned 28 products (mostly pregnancy/ovulation tests — it tokenises and matches "test"). Sample product object keys (first 20):
`sainId, product_uid, favourite_uid, eans, product_type, name, image, image_zoom, image_thumbnail, image_thumbnail_small, full_url, unit_price, retail_price, original_unit_price, is_available, promotions, associations, is_alcoholic, relevancyRank, is_spotlight` — same shape as bulk-lookup products, with extras `relevancyRank`, `is_spotlight`, `favourite_uid`, `zone`, `department`.

**Pagination**: `page_number` (1-indexed), `page_size` (30/60/90). Response `controls.page.{first,last,active}` tells you bounds; `total_record_count` for total hits.

**Search suggestions / autocomplete** — separate endpoint, fired on each keystroke:
```
GET /groceries-api/gol-services/product/v1/product/search/suggestions?search=test%20keyword
  → 200 [<list of suggestion strings>]    // empty array `[]` for "test keyword"
```
Returns a JSON array of suggested completions (empty when nothing matches).

**`GET /product/v1/favourites?...`** — paged favourites.
```
include[ASSOCIATIONS]=true
include[REPLACEMENT_PRODUCTS]=true
include[PRODUCT_AD]=citrus
minimised=true
store_identifier=2168
slot_date=2026-04-07
slot_datetime=2026-04-07T19:00:00Z
slot_type=delivery
flexi_stores=2168
page_number=1..N      (default 1)
page_size=60          (also seen 200; size_options in controls: 30/60/90)
filter[nav_Filter-Your-Results]=Offers   (optional)
```
Returns the same `{controls, products}` shape; products have `is_favourite: true, favourite_type: "FREQUENTLY_BOUGHT" | ...`. Note: 307 redirects observed without `slot_*` params — pass them.

**`GET /product/v1/favourites-by-pattern?...&pattern=usuals`** — bucketed favourites (`pattern ∈ {usuals, seasonal, ...}`). Adds `compare_seasonal=true` for seasonal.

The path `/product/v1/product/interstitial/forgotten-favourites` and `.../upsells` are checkout interstitials (returned products to upsell mid-flow). Same shape.

### 3.4 Slot reservation

**`GET /slot/v1/slot/reservation`** — current pending reservation (no order yet).
**`GET /slot/v1/slot/reservation?order_uid={orderId}`** — reservation tied to a specific order.

Response:
```json
{
  "is_expired": false, "reservation_type": "delivery",
  "reserved_until": "2026-04-06T22:00:00Z",
  "postcode": "AB1 2CD", "region": "England",
  "slot": {
    "start_time": "2026-04-07T18:00:00Z", "end_time": "2026-04-07T19:00:00Z",
    "price": 0, "qualified_price": 2, "unqualified_price": 7,
    "is_green": false, "is_alcohol_restricted": false,
    "booking_key": "<long opaque base64, ~210 chars>",
    "slot_type": "1hour",
    "reservation_id": "22222222-2222-4222-8222-222222222222"
  },
  "delivery_address": { ...same shape as order delivery_address... },
  "store_identifier": "2168",
  "flexi_stores": ["2168"]
}
```

**Listing slots** — `POST /slot/v2/slots` with the **mandatory** header `X-HTTP-Method-Override: GET` (without it: `400 HUMAN_VERIFICATION_FAILED`). It's a POST-shaped GET because `product_uids` is too long for query params. Body:
```json
{
  "week_number": 1,
  "slot_type": "DELIVERY",
  "product_uids": ["7457282", "9126", ...],
  "is_slot_locked": false,
  "store_identifier": "2168",
  "delivery_type": ["saver_slot", "1hour"]
}
```
Returns ~39 slots per day, ~7 days per week. Response shape (verified live 2026-05-25):
```json
{
  "slots": [
    {
      "start_time": "2026-05-26T13:00:00Z",
      "end_time": "2026-05-26T14:00:00Z",
      "price": 0,
      "is_available": true,
      "is_booked_by_customer": false,
      "is_green": false,
      "is_alcohol_restricted": false,
      "is_same_day": false,
      "is_delivery_pass_applicable": true,
      "is_xmas": false,
      "booking_key": "<long opaque base64>",
      "slot_type": "1hour",
      "slot_message": ""
    }
  ],
  "weeks": [...], "slot_types": [...], "has_xmas_slots": false,
  "postcode": "AB1 2CD", "address_nickname": "Home", "store_identifier": "2168"
}
```
Empty `product_uids` is rejected — for a flow with no active basket, fall back to the active order's items.

**Booking / changing a slot** — `POST /slot/v1/slot/reservation`. Body:
```json
{
  "booking_key": "<from /slot/v2/slots>",
  "changes_confirmed": false,
  "new_slot_date": "2026-05-26T13:00:00Z",
  "new_store_number": "2168"
}
```
Returns 200 with empty body. To change the slot on a *placed* order, you must first `POST /order/{id}/amend` to flip into amend mode, then book the new slot, then re-confirm via the checkout flow (otherwise the slot change isn't committed). This produces a new `order_uid` representing the amended order.

### 3.5 Checkout

- `GET /checkout/v2/checkout/start` — primes the checkout (200, body redacted in HAR).
- `GET /checkout/v1/checkout/payment-cards` — saved cards (no body captured).
- `POST /checkout/v1/checkout/payment/start` — begin payment.
  Body:
  ```json
  { "card_uid": "6", "staff_discount_confirmed": false,
    "pick_time": "2026-04-07T00:00:00Z", "store_number": "2168",
    "calculate_substitutes": false }
  ```
- `GET /checkout/v1/checkout/payment/process` — poll/finalise. Response: `{"order_id":"1280000001"}`.
- `GET /gol-ui/checkout/payment/redirect?sessionId=<uuid>` — 3DS / external return path.

### 3.6 Other (lower-priority for the CLI)

- `GET /customer/v1/customer/profile` — full user details (see §4 sample).
- `GET /customer/v1/customer/identity-profile` — Hydra identity (no body in HAR).
- `GET /product/categories/tree`, `/product/v1/product/taxonomy`, `/product/v1/product/meganav` — nav data.
- `GET /content/v1/magnolia/template?name=<page>&has_nectar_associated=true&...` — CMS slots.
- `POST /content/v2/withMagnoliaTemplate/ads` — Citrus ads.
- `GET /coupon/v1/coupon` — applied coupons (response not captured).
- `GET /nectar/v1/nectar/offers` — `{ account_status, offers[] }`.
- `GET /nectar/v1/nectar/ynp-opt-ins?store_id=2168&slot_date=2026-04-07` — your Nectar prices opt-ins (404 in this capture — user not opted in).
- `GET /loyalty-services/v1/card/details` — Nectar card.

---

## 4. Identifiers (real samples)

| Type | Sample value | Notes |
|---|---|---|
| `user_id` | `123456789` | numeric, 9 digits; appears in `wcauthtoken` prefix |
| `customer_id` / `customer_number` | `987654321` | numeric, 9 digits |
| `identity_id` | `00000000-0000-4000-8000-000000000000` | UUID v4; matches JWT `sub` |
| `personalization_id` | `1600000000000-00` | epoch_ms-N |
| `order_uid` / `basket_id` / `order_id` | `1280000001`, `1280000002`, `1280000003`, `1280000004` | numeric 10 digits. Basket and order share the id space — basket is a draft order. |
| `address_uid` | `100000001` | numeric 9 digits |
| `card_uid` | `6` | small integer (per-customer index) |
| `store_identifier` / `store_number` | `2168` (default-pre-slot) | 4-digit zero-padded |
| `delivery_pass_id` | `12017` | numeric 5 digits |
| `slot.reservation_id` | `22222222-2222-4222-8222-222222222222` | UUID |
| `slot.booking_key` | `b64opaque...` (210 chars) | opaque base64; required to commit a slot |
| basket `item_uid` | `28177740249` | numeric 11 digits |
| product `product_uid` (SKU) | `7457282`, `7566892`, `8194039`, `8202235`, `9126` | numeric, variable length 4-7 digits |
| product `sainId` | `947xafvt` | 8-char base32-ish alphanumeric |
| product EANs | `4001724820208`, `4001724042228` | 13-digit GTIN |
| `promotion_uid` | `10737561` | numeric |
| Nectar promo-mechanic | `99` (= "Half Price with Nectar"), `code: "7341-10737561"` | |
| Hydra `state` | `00000000000000000000000000000000` | 32-hex |
| Hydra `code_challenge` | `REDACTED_CODE_CHALLENGE_SAMPLE_S256_B64URL` | base64url, S256 |
| Hydra auth code | `REDACTED_ONE_SHOT_AUTH_CODE.REDACTED` | one-shot |
| Hydra JWT `kid` | `public:09998e47-63e6-4de9-913a-722c25d8c1f3` | RSA |

---

## 5. Open questions / risks

### Auth & session
- **JWT TTL 1 hour, no refresh call observed.** When the SPA's session expires, my best guess is it silently re-runs the OAuth dance using the WCS session cookies (which presumably hold a longer-lived refresh token server-side). For a CLI client: plan to do a full re-login on any 401, including the ThreatMetrix step.
- **No `Authorization: Bearer` header anywhere on app traffic.** The JWT is only used once, in `login-access-token`. After that, auth is entirely cookie (`WC_AUTHENTICATION_<userId>` + friends) + `wcauthtoken` HMAC header.

### Bot protection
- **Akamai Bot Manager is in front of everything.** 54 sensor POSTs in this session (~10% of all traffic). Path: `/UPUWYeuN7oRRTeB5AA/...` (random-looking but stable per tenant). Without a fresh `_abck` token earned via real-browser sensor data, requests will be challenged.
- **ThreatMetrix `ioBlackBox`** is required at login. ~3.5KB of base64 generated by their JS. You can't fake it cheaply; capture from a real browser or use a Playwright-driven login. May be tied to device/IP — re-using one across many sessions could trip risk scoring.

### CSRF / write protection
- No `X-CSRF-Token` or `X-Requested-With` headers observed. Akamai BM + same-origin policy + the custom `wcauthtoken` HMAC are doing the CSRF prevention. Implication: any POST/PUT/DELETE just needs the `Cookie` + `wcauthtoken` + `Origin: https://www.sainsburys.co.uk`.

### API surface gaps still unprobed
- **No slot-booking POST** captured — the user already had a slot in both HARs. Out of scope for now; capture a fresh booking later to learn the request body.
- **No favourites add/remove** — only GETs were captured. Probable shape: `POST /product/v1/favourites { product_uid }` and `DELETE /product/v1/favourites/{product_uid}`. Out of scope for now.
- **Most basket GET response bodies are missing `text`** in the HAR (only `size` is recorded). Final-state confirmation worked because one basket GET happened to retain its body, but if you need to inspect intermediate states, force the HAR exporter to include large bodies.

### Operational
- The `enabled-feature-flags` header is ~3KB of feature names. The BFF *may* require it to render some endpoints correctly (flags affect price-display, promotion logic, basket service version `use_food_basket_service_v3` / `_v4`). Send a snapshot or experiment with omitting it.
- New Relic `traceparent`/`tracestate` headers are present on every call. Server doesn't seem to require them, but they're also low-cost to send and reduce your fingerprint as "obvious bot".
- Rate-limiting policies unknown. Akamai will throttle aggressive clients regardless.

### Legal/ToS
- Sainsbury's ToS prohibits automated access. Anything you build for personal use is at your own account-suspension risk. Don't share credentials, don't hammer the API, don't redistribute.

---

## TL;DR build plan

1. **Use Playwright** (or Puppeteer) for the login flow only. Run headed once to seed `_abck`/cookies, then headless on a refresh schedule.
2. After `POST /login-access-token` succeeds, scrape:
   - All cookies on `www.sainsburys.co.uk`.
   - `wcauthtoken` from a subsequent fetch's request headers (it's set on every XHR by the SPA — easiest to read it from a `page.on('request')` hook).
3. Hand the cookie jar + `wcauthtoken` to a thin Go/Python HTTP client for all the §3 calls. Mirror the SPA's headers (UA, sec-ch-ua-*, accept, content-type, origin, referer, enabled-feature-flags).
4. Re-run step 1 on any 401/403, or on a schedule (every ~30-45 min to be safe).
5. Don't try to reproduce the Akamai sensor pipeline by hand. It's not worth it.
