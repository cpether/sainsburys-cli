# Sainsbury's protocol observations

These notes preserve the useful request knowledge from upstream commit `dde7355e8b52aa64583f3ab0516fbcf35f3c45b6`. Most request shapes are historical observations from the author's 2026 captures. Supervised live login and cached read checks passed on 15 October 2026; the additional unslotted response shape is recorded below. No real HAR or account session is checked in. Tests use synthetic fixtures, clearly labeled as such. See LIVE_VALIDATION.md for completed checks and remaining validation.

## Authentication

The local browser performs Sainsbury's normal account/OAuth flow, including bot checks and manual MFA. Requests to the exact origin `https://www.sainsburys.co.uk` reveal the custom `wcauthtoken` and OAuth bearer token. Retain both tokens and the appropriate cookies for API calls. Earlier upstream claims that there was no bearer token conflicted with the later capture and implementation. This fork preserves the bearer header.

The custom token URL-decodes to `<numeric user ID>,<opaque HMAC>`. Cookies are filtered for the intended host and deduplicated by name, preferring the more specific domain. Account-subdomain cookies are not replayed as www-host cookies. Cookie/token expiry and bot challenges remain live reliability risks. A 401/403 requires explicit local login; no mutation is blindly retried.

The browser profile is dedicated to the account email and session path. Login verifies the customer profile's user ID and email before exporting credentials. Supported identity response shapes are flat or nested under `customer`, with `user_id` and `email` or `email_address`. These alternatives fail closed if unverifiable. Live login and fresh-process cached identity reads passed; that does not establish every alternative response shape live.

## Retained request shapes

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

## Unresolved live questions

Check identity fields, session reuse/expiry, the bearer/cookie combination, bot challenges, search region, no-reservation store context, basket ID stability during the first addition and quantity-zero removal. Compare delivery prices, Nectar/promotional prices, catchweight totals and slot context with the website. Record sanitized response shapes and concrete failures before changing the transport approach.

The old upstream payment listener accepted an order ID as success without establishing payment completion. Its behavior is not evidence of a completed order. This fork contains no payment completion claim or automatic payment path.
