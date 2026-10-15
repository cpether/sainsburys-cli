# Supervised live validation

Status on 15 October 2026: early HTTP pilots failed immediate verification after writes. Status-only diagnosis and the first resident pilots then reproduced last-item removal followed by basket HTTP 500 and later authentication rejection. The original empty basket was restored and verified through fresh API reads and the website. No purchase, amendment or slot change occurred.

The account holder completed one sign-in for the resident-browser validation below. Subsequent minimized profile resumes required no additional human sign-in. A bounded diagnostic then verified removal successfully by replacing only the page inside the same browser after basket GET 500, re-verifying identity and repeating the read. The mutation was never repeated. Production regression tests and the full normal-service pilot of that recovery passed. Every mutation was verified, the website matched quantities and totals, and a fresh CLI process confirmed restoration. Longer session lifetime and natural expiry remain unverified.

The earlier generic login failure was followed by a verification failure. Claude independently reproduced an adapter bug with multiple Set-Cookie headers using real Playwright HTTP and a dummy loopback server. The fixed adapter and refreshed-cookie export were followed by successful live login and cached reads. The unslotted reservation also omitted `is_expired`; the parser now accepts that observed form while requiring an explicit expiry flag whenever a slot is present. Synthetic regression fixtures preserve the field layout without account values. No real session, HAR or raw profile response is checked in.

## First pilot results

The person confirmed the website showed an empty basket and approved one 65p ordinary `ea` porridge pot, with target quantities one, two, then zero. Each fresh plan enforced a £1.30 estimated basket ceiling and a maximum quantity of two, using the account's unchanged store context and no booked slot. A private original snapshot and plan files were created with directory mode 0700 and file mode 0600. Those temporary shopping-data files were removed after verified restoration; the normal cached login was retained.

| Step | CLI result | Website comparison |
| --- | --- | --- |
| Set target to one | Verified one item at £0.65 | One item and £0.65 after refreshing a transient website error |
| Repeat the same plan | Already applied, zero verified changes, quantity stayed one | No duplicate addition |
| Set target to two | Verified two items at £1.30 | Two items and £1.30 |
| Set target to zero | Unknown outcome because immediate readback failed | Empty trolley; the mutation was not retried |
| Verify restoration after explicit local login | Fresh API read matched the original empty basket and £0 total; amendment mode off and no active order | Empty trolley |

Before the first write, the cached session was also rejected: identity returned HTTP 401 about twenty minutes after capture, even though the bearer token expiry was still in the future. Explicit local login recovered access. Another authentication failure prevented removal readback. These observations establish rejection and recovery behavior; they do not establish the cause or a natural expiry interval.

An independent source investigation confirmed that ordinary HTTP responses ignored Set-Cookie updates. A separate read-only diagnostic after recovery observed 4–5 response cookies per endpoint with existing names but changed values. Only status, fixed endpoint/category labels and counts were emitted, with no raw names, values, headers, bodies or hashes. Offline tests reproduced the general stale-cookie failure pattern. This is evidence for fixing a concrete client gap, not proof that it caused either live rejection.

The cookie-refresh fix now retains scoped cookie replacements/deletions and coordinates persistence with concurrent requests, login and logout. All 183 automated tests pass. A bounded read-only live check with the updated client passed identity, context, empty basket and a second identity read in fresh CLI processes; cookie-state changes were persisted without changing the login timestamp or account identity. The second approved pilot below then tested live mutations with this fix.

## Second pilot after cookie hardening

The person approved the same 65p ordinary `ea` pot, SKU `7515858`, with target quantities zero, one, two, then zero. The ceiling remained £1.30 and two items. Preflight cached authentication was rejected before any write. Explicit local login succeeded, and fresh reads confirmed an empty basket, amendment mode off, no active order, the unchanged account-derived store and no booked slot. Bulk lookup confirmed availability, 65p and the `ea` unit. The website also showed an empty trolley.

| Step | CLI result | Website comparison |
| --- | --- | --- |
| Set target from zero to one | Exit 5, unknown outcome because immediate basket readback failed; zero changes verified | One pot at £0.65 |
| Fresh read after the unknown outcome | Exit 2, authentication required; the mutation was not retried | Still one pot |
| Explicit local login and fresh read | One pot at £0.65, amendment mode off | Matched |
| Fresh recovery plan from one to zero | One change verified immediately; £0 total | Empty trolley |
| Separate-process restoration check | Whole basket matched the original empty snapshot; unchanged context, no slot and no active order | Empty trolley |

The target-two and repeated-plan steps were not attempted in this pilot. Restoration was within the approved sequence and used a fresh plan after inspecting the actual state. Private snapshots, plans and result files were removed only after verified restoration. Cached authentication was retained.

The cookie fix did not establish dependable live writes. A newly verified login supported preflight reads and planning, then API access was rejected after the first add. Removal after another explicit login did verify successfully, so verification does not fail universally. The failure pattern is not yet characterised. The immediate readback error does not identify its underlying transport/status cause; the subsequent fresh read established authentication rejection. No raw response or credential-bearing trace was retained. These observations do not prove a bot challenge, bearer expiry, missing header or any other cause.

At that point write experiments were paused. The person subsequently requested continued work. The diagnosis below records the additional evidence before changing the transport. Any diagnostic must emit only fixed endpoint labels, status/content-type categories and sanitized schema results. Preserve useful API shapes and dummy fixtures; do not collect HARs or token-bearing headers. Propose the transport change based on that comparison rather than continuing speculative patches.

## Diagnosis after the second pilot

The person requested continued work and fewer login interruptions. The same approved item and two-item/£1.30 limits were retained. Three fresh cached identity/context/basket rounds passed without login. A new zero-to-one plan passed write and immediate readback, repeating it reported zero writes, and a one-to-two plan passed. Website quantities and totals matched both steps.

A fresh two-to-zero plan returned HTTP 200 for its PUT, then HTTP 500 JSON for the immediate basket GET. The CLI returned an unknown outcome. A fresh identity read then returned HTTP 401. The mutation was not retried; the website showed an empty trolley. These fixed status categories distinguish the actual failed readback from the later authentication rejection. No raw response, cookie value, header, token or account identifier was logged.

A bounded headless reuse attempt reached a browser challenge and sent no authenticated API requests. A headed minimized reuse attempt reached the real sign-in form, including after restoring nonexpired cached cookies. Neither attempt requested credentials in a tool or opened repeated interactive login flows. The saved state cannot currently establish the account without fresh participation. Repeatedly launching login is therefore not a dependable recovery strategy.

The resident-browser approach keeps the browser process and website JavaScript session alive after one explicit sign-in. The existing request shapes, response validators, target plans and spending/amendment guards remain. A read may renew the website session once after a 401/403; a basket mutation is sent once. Transient post-write verification may repeat one GET. Authentication required by the retailer still needs human participation through explicit `auth login`; ordinary commands leave the window minimized and return a sanitized error rather than opening sign-in.

## Resident-browser validation

An initial explicit login wait expired without verified identity. After the account holder confirmed completed sign-in, the same dedicated browser verified identity in about three seconds without another credential prompt. The first preflight then failed authentication before any write. A minimized restart resumed the saved profile without human participation, and fresh API reads confirmed the earlier empty-basket restoration, account-derived context, no active order and the approved ordinary pot's availability and 65p price.

Two source defects were reproduced with dummy browser fixtures. Recovery discarded complete rotated credential pairs before trying them, and a failed silent refresh permanently blocked later reads even when the retained browser recovered. The fixes verify observed pairs against the expected account before adoption and let a later bound read attempt one silent recovery. Account/generation checks, cancellation and the prohibition on mutation retries remain. Real engine, private IPC and CLI regressions cover these cases. Claude Opus 5.5 high independently reviewed both deltas and found no material blockers. The suite at `4596cfd` passed 267 tests, typecheck and build.

The first normal resident pilot verified quantity one, repeated-plan zero writes and quantity two. The website matched quantity two and £1.30 after a transient page error was refreshed. Removal returned unknown with fixed readback category HTTP 500. A fresh read failed authentication; the website showed empty. A minimized restart, without manual login, enabled fresh API confirmation of the original empty basket, unchanged basket identity and £0 total.

The website used 175 feature flags while the retained static list contained 166. A controlled comparison using the website's current flags reproduced the same final-removal HTTP 500. That difference was not established as the cause, and no speculative feature-flag source change was retained. Quantity one, idempotence and quantity two passed, with website comparisons, before removal. Fresh API and website checks again confirmed restoration after a minimized resume.

A native website removal comparison was inconclusive: the page appeared empty, but no request shape was captured and fresh API reads still showed one pot. That optimistic display was not treated as successful removal. A fresh reviewed one-to-zero CLI plan then exercised a narrowly scoped read-only recovery diagnostic. Its trace showed removal success, basket GET 500, one fresh page in the same minimized browser context, profile verification recovering from 401 to 200, and basket GET 200. The CLI reported one verified change and an empty basket. A separate fresh API process matched the original basket and identity; a website refresh also confirmed empty. The page instrumentation was removed. No passwords, MFA codes, cookies, tokens or raw account responses were emitted or checked in.

This evidence supports replacing the stale page for a basket GET 500, followed by identity verification and one read retry. It does not establish the retailer's internal reason for invalidating the old page's API access, or prove a session-storage cause. The normal-service implementation must preserve the same account and generation, remain within its request deadline, close late pages on cancellation and never repeat the write. The final supervised normal-service pilot below passed with this production recovery.

### Final normal-service pilot

The diagnostic wrapper was stopped. The production implementation started through the normal CLI, resumed the same dedicated private profile without another human sign-in, and passed preflight. The approved SKU `7515858`, ordinary `ea` unit, empty catchweight selection, account-derived context, no booked slot, £1.30 ceiling and two-item maximum were unchanged.

| Step | Production CLI result | Website comparison |
| --- | --- | --- |
| Target zero to one | One verified change; quantity one, £0.65 | One pot, £0.65 |
| Reapply the exact same plan | Already applied; zero writes; quantity one | Not separately reloaded for this read-only result |
| Target one to two | One verified change; quantity two, £1.30 | Two pots, £1.30 |
| Target two to zero | One verified change; empty basket, £0 | Empty trolley after refresh |
| Separate-process restoration read | Whole basket matched original empty snapshot; basket identity unchanged | Empty trolley, test product absent |
| Fresh identity/context/order/search reads | Expected identity; unchanged context; no active order; 30 search results | No slot/order change was made |

The resident process identity remained unchanged through removal and restoration. Its status remained running and authenticated. No explicit login, browser-process restart or mutation retry occurred during this final sequence. The dedicated browser remains running for subsequent shopping. This establishes the bounded ordinary-item workflow for this account at this time; it does not prove indefinite login, natural expiry, booked-slot pricing or weighted-product compatibility.

More than five minutes after restoration, new CLI processes again confirmed the expected identity, unchanged context, no active order and the original empty basket. The same resident process remained running and authenticated, with no further sign-in. This is short-term reuse evidence, not a natural-expiry test.

Final local checks passed typecheck, build, all 273 automated tests and dependency audit with zero vulnerabilities. The independent fresh-page reviewer separately passed 78 engine/IPC/CLI tests and found no material blocker. Final Claude review and CI are required before merge; their results are recorded on PR6.

## Login and reads

1. In your own local terminal, build and install the dedicated browser if needed, then run:

   ```sh
   cd /Users/chrispether/projects/shopping/sainsburys-cli
   npm ci --ignore-scripts
   npm run browser:install
   npm run build
   export SAINSBURYS_EMAIL='YOUR_ACCOUNT_EMAIL'
   node dist/cli/index.js auth login
   ```

   Enter the password and MFA only in the opened Chromium window. Never paste either into the assistant conversation, a command argument or a plan file.
   If sign-in finishes but the terminal is waiting, open Trolley in the same window. Expect verified login success; the dedicated browser then minimizes and stays running for later commands. If it fails, record only the sanitized terminal error, whether the window reached the account/trolley page. Keep the existing dedicated profile for retry; do not delete authentication state as a troubleshooting step.
2. Run `--json customer profile`, `--json customer context`, `--json slot current`, `--json product search oats` and `--json basket show`. Confirm the intended account, selected store/reservation, product prices and basket quantities against the normal website. If the store is unknown, compare the website before providing `--store`.
3. Keep a private original basket snapshot and record the chosen item's original quantity, unit and catchweight. Check `order status` and confirm amend mode is false. Stop if either amendment flag is true or context differs from the website.

## One approved reversible sequence

The assistant must first show you the specific SKU, product name, original quantity, units, test target quantities, delivery context, estimated basket totals and limits. You must approve that item and sequence before any live write. Choose a low-cost ordinary `ea` item, ideally absent initially; maximum test quantity two. The two pilots above had separate approvals. The person then authorized continued diagnosis within the same specific item, quantities and limits. The instructions below remain the workflow for any future test; a different item or broader limit requires its own approval.

For an initially absent approved item, generate and review a separate constrained plan for each step:

1. Set its target to 1 and verify the CLI readback and website.
2. Set its target to 2 and verify both again.
3. Set its target to 0 and verify removal.
4. Confirm the whole basket matches the original quantities, units and catchweight selections. If initially present, restore the original target quantity instead of leaving it removed. Do not adjust unrelated lines.

Use the README `basket plan`/`basket apply --approve` commands for every step. Applying a satisfied plan again should report zero writes. A fresh plan needs a fresh review. Do not retry an uncertain result. Inspect the website, then prepare a new recovery plan only after the person reviews the actual state. Every mutation needs readback even if its HTTP response failed.

## Session reuse and decision point

Run a fresh CLI process to read the identity and basket using the cached session. After API credential expiry, allow one bounded silent renewal through the resident browser. If Sainsbury's requires human authentication, confirm the command returns a sanitized error without showing a login window or repeating a mutation. Run explicit local login only then and verify identity/basket again. A later supervised read on another occasion gives better evidence than immediate reuse alone.

The earlier HTTP and resident pilots did not complete clean immediate verification. The final normal-service pilot passed after the fresh-page recovery, including restoration without new sign-in. Longer session reuse, natural expiry behavior, booked-slot context and weighted/catchweight products remain unverified. Keep the original account state unchanged while those checks are pending.

If login cannot establish identity, ordinary browser use works but direct HTTP replay is consistently challenged, or verified basket writes remain unreliable, stop after a bounded pilot. Record sanitized endpoint shapes, response status/content type, the operation and observed website state. Never store token-bearing headers, passwords, MFA codes, cookies, HARs or full account screenshots in the repository. Explain that evidence before replacing authentication or transport. Preserve the useful request shapes and sanitized fixtures.

No step authorizes placing an order, submitting payment, amending an existing order or booking/changing a slot. All checkout and payment stays manual on Sainsbury's website.
