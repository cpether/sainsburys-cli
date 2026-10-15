# Sainsbury's protocol observations

These notes preserve the useful request knowledge from upstream commit `dde7355e8b52aa64583f3ab0516fbcf35f3c45b6`. Most request shapes are historical observations from the author's 2026 captures. Supervised login, reads and reversible basket mutations ran on 15 October 2026, with an authentication failure during removal verification and later confirmed restoration. The additional unslotted response shape is recorded below. No real HAR or account session is checked in. Tests use synthetic fixtures, clearly labeled as such. See LIVE_VALIDATION.md for completed checks and remaining validation.

## Authentication

The local browser performs Sainsbury's normal account/OAuth flow, including bot checks and manual MFA. Requests to the exact origin `https://www.sainsburys.co.uk` reveal the custom `wcauthtoken` and OAuth bearer token. Retain both tokens and the appropriate cookies for API calls. Earlier upstream claims that there was no bearer token conflicted with the later capture and implementation. This fork preserves the bearer header.

The custom token URL-decodes to `<numeric user ID>,<opaque HMAC>`. A maintained cookie jar selects cookies by the exact request URL, preserving host-only/domain, path, Secure and expiry rules. Same-name cookies on different paths are not collapsed into one value. Account-subdomain cookies are not replayed as www-host cookies. Trusted response cookie replacements and deletions are retained before readback and subsequent CLI requests. Redirects and foreign responses cannot update the jar. Cookie/token expiry and bot challenges remain live reliability risks. The legacy HTTP client requires explicit login after a 401/403. The resident browser can recover a read through one silent website reload; human-required authentication still needs explicit local login. No mutation is blindly retried.

The browser profile is dedicated to the account email and session path. Login verifies the customer profile's user ID and email before exporting credentials. Supported identity response shapes are flat or nested under `customer`, with `user_id` and `email` or `email_address`. These alternatives fail closed if unverifiable. Live login and fresh-process cached identity reads passed; that does not establish every alternative response shape live.

During the supervised pilot, cached authentication was rejected before the bearer expiry timestamp. Explicit local login recovered access. Subsequent successful read responses set 4–5 cookies, replacing existing cached values. Counts were observed without retaining names, values or raw headers. The original HTTP client ignored these updates; an offline rotating-cookie fixture reproduces a possible stale-session failure. The observed changes do not establish the cause of the live rejections, and no response cookie is assumed to be a replacement `wcauthtoken` or bearer token.

## Retained request shapes

New persistent logins retain a dedicated headed Chromium process and send the same API requests through its retailer page. The browser owns cookies and browser-generated request metadata. The local adapter supplies only captured API credentials and allowlisted noncredential headers; raw credentials never cross the private IPC socket. Playwright `context.request` uses its API HTTP transport and shares cookies, which alone is not proof of Chromium renderer behavior.

The diagnostic removal was HTTP PUT 200, then basket GET 500 JSON, then profile GET 401. This establishes a server/session failure sequence, not a parser error or a proven token-expiry cause. Headless profile reuse reached a browser challenge; headed reuse reached sign-in. Keeping one accepted browser session resident avoids relying on repeated exports followed by fresh interactive browser launches. Compatibility still needs live verification after implementation.

All paths below are under `/groceries-api/gol-services/` on the exact retailer HTTPS origin. Authenticated redirects are refused. The feature flags snapshot remains in `src/lib/feature-flags.ts`; its necessity has not been re-established live.

- `GET customer/v1/customer/profile` reads the account profile.
- `GET slot/v1/slot/reservation` reads the current reservation. A slotted response includes `reservation_type`, boolean `is_expired`, `store_identifier`, `region`, `flexi_stores`, optional `reserved_until` and `slot` with start/end times, price, booking key and reservation ID. The supervised unslotted response had `reservation_type: "none"`, postcode/store/region/flexi-store context and an alcohol-restriction flag, with neither `slot` nor `is_expired`. Keep that store context while reporting no booked slot. Missing expiry is allowed only without a slot; active-slot context requires explicit `is_expired: false`. A known empty response or JSON null means no reservation. A malformed object is an error.
- `GET basket/v2/basket` uses `pick_time`, `store_number`, `slot_booked` and `calculate=true`. Derive store and delivery time from current account/reservation, honoring explicit overrides. Unknown context needs an explicit store. No generic store or old-order fallback is used.
- `POST basket/v2/basket/item` sends `product_uid`, `quantity`, `uom` and `selected_catchweight`.
- `PUT basket/v2/basket` sends an `items` array with those fields plus `item_uid`. `decreasing_quantity=true` is observed when decreasing. A zero quantity removes the line. JSON null or an empty successful write response is valid for this endpoint; it is followed by authoritative basket readback. HTML or malformed JSON is never an empty success.
- `GET order/v1/order/status` reads active order state. An observed empty response, JSON null or HTTP 404 means no current order. An object requires `order_uid`, `is_in_amend_mode` and `is_cutoff`. Unexpected objects are errors. Basket preparation checks both active status and basket amendment flags.
- `GET product/v1/product?uids=<csv>` fetches products. The observed bulk endpoint accepts `store_identifier`, `slot_date`, `slot_datetime`, `slot_type` and `flexi_stores`. The workflow uses this to recheck shortlisted products against delivery context.
- Keyword search uses that same product endpoint with `filter[keyword]`, `page_size`, `page_number`, `sort_order=FAVOURITES_FIRST`, `store_identifier`, optional account `region`/`flexi_stores`, `salesWindow=1` and `citrus_max_number_ads=0`. The observed search contract differs from bulk lookup and does not use `slot_*`; search alone is not a delivery availability check.
- `GET product/v1/product/search/suggestions?search=...` returns suggestion strings, including an empty array.
- `POST slot/v2/slots` is a read-only query with the mandatory `X-HTTP-Method-Override: GET` header. Its body has `week_number`, `slot_type`, `product_uids`, `is_slot_locked`, `store_identifier`, `delivery_type`. The current implementation defaults to `delivery_type=["1hour"]`. Product IDs come only from the current basket; partial/missing numeric IDs are an error, and past groceries are never substituted. Slot booking is unavailable.
- `GET coupon/v1/coupon` returns `coupons`, with coupon fields nested under `promotion`. Failure is an error, not an empty coupon list. Coupon application stays on the website.

The retained read-only order list/detail API functions are not exposed as CLI commands. They are useful protocol knowledge; their less-used response fields have limited validation. Payment/amendment/booking execution code has been removed rather than hidden behind documentation.

## Identifiers, units and estimates

Basket-line IDs never participate in product matching. Readback reconciles the reviewed SKU/sain-ID pair across response shapes and rejects conflicting identities.

Product SKUs are numeric `product_uid` or `product.sku`, sometimes JSON numbers that must normalize to strings. `sain_id`/`sainId` are distinct alphanumeric product identifiers. `item_uid` is the basket-line ID, never the product SKU. A basket response can put the SKU only in `product.sku`; preserve this shape. Line totals can be `subtotal_price` or `sub_total`.

Preserve the existing line's `uom` and `selected_catchweight` on updates. Initially only `ea` and `kg` are supported for writes, with conservative bounds. New lines must match a known sold-by unit. Unknown units require website review. New catchweight selection requires website review; the integration preserves existing selections. These fields and actual weight/pricing behavior need a supervised check before using weighted goods.

The supervised ordinary-item lookup returned a bulk `retail_price.measure` of `ea`, while its search result used an empty measure and its `unit_price` used kilograms for price comparison. Derive the sold-by unit from the bulk product lookup, not the comparative unit price. The approved ordinary-item sequence reached quantities one, two and zero; repeated target-one application did not duplicate it. Removal needed explicit login before a successful API read confirmed the website's empty basket. Weighted goods and booked-slot pricing are still unverified live.

## Unresolved live questions

The second approved pilot after cookie hardening lost API access immediately after its first add. The add reached the website, immediate CLI readback returned an unknown outcome, and a fresh read required authentication. Explicit local login recovered access. A fresh removal plan then passed immediate readback, and a separate API read plus the website confirmed the original empty basket. That pilot was not a clean end-to-end pass. The continued diagnostic and resident-browser follow-up are recorded in LIVE_VALIDATION.md.

The person authorized continued diagnosis. Preserve the bounded comparison evidence when evaluating the resident renderer transport. Preserve fixed endpoint labels, status/content-type categories and sanitized schema results only. No exact cause has been established. Sustained session reuse, natural expiry, the bearer/cookie combination and bot challenges remain open questions. Initial identity, search region, no-reservation store context and ordinary-item mutations have live evidence, with intermittent verification failure. Delivery prices, Nectar/promotional prices, catchweight totals and booked-slot context still need website comparison.

The old upstream payment listener accepted an order ID as success without establishing payment completion. Its behavior is not evidence of a completed order. This fork contains no payment completion claim or automatic payment path.
