# Supervised live validation

Status on 15 October 2026: two approved reversible pilots have run. Neither was a clean end-to-end pass. The second pilot, on cookie-hardened commit `b8e35ca`, stopped after its first add because immediate readback failed and fresh CLI reads required authentication. The website showed the added item. Explicit local login restored API access, and a fresh removal plan passed immediate verification. A separate CLI read and the website both confirmed the original empty basket. No amendment, slot change, checkout or payment occurred. Further live write pilots are paused pending a diagnosis of the retained authentication/HTTP approach.

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

Stop further write experiments here. Before replacing the retained login/HTTP implementation, explain this evidence and compare bounded, read-only requests through the retained HTTP client and the authenticated dedicated browser. Any diagnostic must emit only fixed endpoint labels, status/content-type categories and sanitized schema results. Preserve useful API shapes and dummy fixtures; do not collect HARs or token-bearing headers. Propose the transport change based on that comparison rather than continuing speculative patches.

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
   If sign-in finishes but the terminal is waiting, open Trolley in the same window. Expect `Authenticated API credentials captured; verifying account identity.` followed by verified login success. If it fails, record only the sanitized terminal error, whether that progress message appeared, and whether the window reached the account/trolley page. Keep the existing dedicated profile for retry; do not delete authentication state as a troubleshooting step.
2. Run `--json customer profile`, `--json customer context`, `--json slot current`, `--json product search oats` and `--json basket show`. Confirm the intended account, selected store/reservation, product prices and basket quantities against the normal website. If the store is unknown, compare the website before providing `--store`.
3. Keep a private original basket snapshot and record the chosen item's original quantity, unit and catchweight. Check `order status` and confirm amend mode is false. Stop if either amendment flag is true or context differs from the website.

## One approved reversible sequence

The assistant must first show you the specific SKU, product name, original quantity, units, test target quantities, delivery context, estimated basket totals and limits. You must approve that item and sequence before any live write. Choose a low-cost ordinary `ea` item, ideally absent initially; maximum test quantity two. The two pilots above had separate approvals. Neither approval authorizes another pilot. The instructions below describe the workflow for a future approved test after the current reliability investigation.

For an initially absent approved item, generate and review a separate constrained plan for each step:

1. Set its target to 1 and verify the CLI readback and website.
2. Set its target to 2 and verify both again.
3. Set its target to 0 and verify removal.
4. Confirm the whole basket matches the original quantities, units and catchweight selections. If initially present, restore the original target quantity instead of leaving it removed. Do not adjust unrelated lines.

Use the README `basket plan`/`basket apply --approve` commands for every step. Applying a satisfied plan again should report zero writes. A fresh plan needs a fresh review. Do not retry an uncertain result. Inspect the website, then prepare a new recovery plan only after the person reviews the actual state. Every mutation needs readback even if its HTTP response failed.

## Session reuse and decision point

Run a fresh CLI process to read the identity and basket using the cached session. After natural session expiry, confirm that a read returns an authentication/challenge error without starting another browser or mutation. Run explicit local login and verify identity/basket again. A later supervised read on another occasion gives better evidence than immediate reuse alone.

A clean mutation/readback sequence after cookie hardening failed in the second pilot. Longer session reuse, natural expiry behavior, booked-slot context and weighted/catchweight products remain unverified. Keep the original account state unchanged while those checks are pending.

If login cannot establish identity, ordinary browser use works but direct HTTP replay is consistently challenged, or verified basket writes remain unreliable, stop after a bounded pilot. Record sanitized endpoint shapes, response status/content type, the operation and observed website state. Never store token-bearing headers, passwords, MFA codes, cookies, HARs or full account screenshots in the repository. Explain that evidence before replacing authentication or transport. Preserve the useful request shapes and sanitized fixtures.

No step authorizes placing an order, submitting payment, amending an existing order or booking/changing a slot. All checkout and payment stays manual on Sainsbury's website.
