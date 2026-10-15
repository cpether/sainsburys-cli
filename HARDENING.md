# Hardening and validation record

Implementation date: 15 October 2026. Fork: https://github.com/cpether/sainsburys-cli. Branch: `harden-personal-shopping`. Base: audited commit `dde7355e8b52aa64583f3ab0516fbcf35f3c45b6`. The original checkout was clean. The fork's main branch matches that commit; no newer upstream changes were included. `upstream` remains the original repository; pushes target the fork's implementation branch only.

## Baseline

Before changes, `npm ci --ignore-scripts`, typecheck, build and all 38 upstream tests passed. Running the existing audit reproduction script reproduced its 23 assertions. Those assertions demonstrate defects and positive controls; they are not security acceptance tests. The original reports remain in the parent shopping workspace. The upstream source and complete historical API notes remain available in Git at the base commit.

The initial dependency audit reported one low-severity esbuild development advisory, [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr). Updating compatible Playwright, tsx and Node type versions through the lockfile selected patched esbuild. No major-version audit fix was forced. The silent postinstall browser download was replaced by explicit `browser:install`, which installs the Chromium runtime actually used.

## Acceptance coverage

The automated suite executes application modules and the CLI with dummy credentials, mocked retailer/browser behavior and temporary private homes. Its isolation preloader disables default network access before loading application modules. No ordinary browser profile is read or modified.

| Area | Regression coverage |
| --- | --- |
| Storage and identity | Initial permissions, permission rejection, atomic/concurrent writes, malformed sessions, account/path profile separation, verified profile identity, logout of profiles/session/legacy state, no-persist temporary cleanup and cleanup failure |
| Authentication lifecycle | Concurrent login coalescing, account mismatch, cached login without password, expired session requiring local login, successful/failed timer cleanup, manual MFA only |
| HTTP | Exact HTTPS origin, unsafe absolute URLs/credentials/fragments, redirect refusal, protected headers, bounded bodies and overall deadlines, cancellation, HTML/challenge/malformed JSON, endpoint validators, shared read refresh, no mutation retry, unknown writes, redacted errors |
| Basket | Numeric/nested product SKU, sain ID and line ID normalization, finite/unit bounds before requests, existing catchweight preservation, actual account/slot context, explicit store override, expired/malformed reservation, target quantities and repeated/concurrent idempotence |
| Authority and outcomes | Amendment rejection from both basket and active-order status, snapshot/account/context/price binding, public-hash hostile plan revalidation, enforced quantity/estimated spending limits, per-write readback, unchanged unrelated lines, partial/mismatch/unknown outcomes |
| Supported CLI | Actual JSON search/basket/plan/apply operations, rejected payment/amendment/booking/additive commands before network, structured failure results and exit codes, no duplicate addition on reapply |

Final checks: clean lockfile install, typecheck, build and 138 automated tests pass. `npm audit --audit-level=low` reports zero vulnerabilities, including development dependencies. CI uses Node 22/24 on Linux/macOS. The local run used Node 25.8.1 on macOS; remote CI results are recorded on the draft PR.

### First supervised login attempt

The user subsequently reported apparent browser sign-in followed by a generic terminal failure. Offline reproductions showed that a document-load timeout after credential capture and a rejected verification read both produced that same error. The follow-up fix lets authenticated API activity proceed to identity verification independently of document load, tolerates the navigation timeout while the person signs in, and removes the premature automatic trolley navigation. It reports safe failure stages and sanitized verification status/response reasons without retaining diagnostics. The original dedicated profile is preserved for retry.

A second supervised attempt captured authenticated API credentials, then failed before a usable verification response reached the HTTP validator. This does not establish an HTTP rejection or bot challenge. The diagnostic build preserves fixed error categories from the browser request boundary, separately identifies body/response-adapter failures, and never emits raw Playwright call logs. Claude's focused inspection also identified a metadata/navigation race, fixed by reading user agent on about:blank before navigation, with a red/green regression.

Claude's next pass independently reproduced a concrete adapter bug using real Playwright HTTP against a loopback server: multiple Set-Cookie headers are joined with newlines, which Fetch Headers rejects. The adapter now copies only content type and length; Playwright's shared cookie jar still processes Set-Cookie. The session captures cookies again after successful verification so refreshed cookies are exported. A real-Playwright loopback regression failed first on header adaptation, then exposed the stale pre-read cookie snapshot, and passes with both fixes. This is a strong candidate for the live failure but remains unconfirmed there. All 154 automated tests, typecheck and build pass, with zero dependency audit findings. Successful live login, cached HTTP replay and all basket validation remain pending. Stale profile credentials and login opened in another tab remain bounded pilot limitations; the current workflow watches its initial tab and requires same-tab sign-in/Trolley activity.

## Independent review

Implementation agents owned separate auth, HTTP and basket modules. The HTTP reviewer independently reviewed authentication and basket plans, and the auth reviewer independently reviewed the other API/context/CLI modules. Material findings fixed and tested include temporary-profile cleanup suppression, trusting a caller-supplied spending estimate, plan deserialization bypasses of unit/catchweight checks, mismatched product identity on sain-only lines, malformed basket readback classified too weakly, conflicting product slot overrides and stale reservation times. A final identifier-shape test covers a new item returned with only nested `product.sain_id`. No material review blocker remained at delivery.

### Claude PR review

The requested external review runs through the authenticated Claude CLI with `--model claude-opus-5-5 --effort high`. Its first pass found product/line-ID confusion, readback aliases that could misclassify a valid add, stale locks preventing logout after interruption, a missing new-product unit check, and JSON-null/schema error inconsistencies. All have regression coverage and fixes. Follow-up verdicts and final CI status are recorded in the PR.

The fixes also reconcile aliases when choosing an existing line for update, reject contradictory numeric identifiers, preserve idempotence across the observed response shapes, reclaim dead-process locks without deleting a new live claim, clean abandoned temporary authentication state on logout, abort HTTP on graceful signals, and let CLI cleanup finish before exit. SIGKILL/power loss still cannot execute immediate cleanup. Unknown live lock owners fail closed.

The Standards review's confirmed product/line-ID defect and two duplication concerns were resolved. Automatic dotenv loading, terminal control sequences in retailer text, and deletion of an unverified legacy folder beside a custom session path were also addressed. The HTTP client's tested read-refresh seam remains available as a library feature; the agent CLI still requires explicit local login. Policy/input failures retain the documented exit code 1.

The second Claude pass independently exported and tested the committed fix, found no material blockers, and stress-tested 16 processes across 107 critical sections with six killed holders and no overlaps. Its additional logout-refusal finding was fixed: owned session/profile/temporary state is cleared before reporting any live or unverified state left behind. Abandoned lock candidates are recovered on the next acquisition. SIGINT/SIGTERM now emit one structured JSON result, tracking an unverified write through authoritative basket readback; the six real CLI interruption cases and both logout-recovery cases pass. A final focused Claude pass reviews these last changes before merge.

## Limits and next action

Live validation did not happen. The next action is the person's local login in LIVE_VALIDATION.md, followed by comparing identity, context, search and basket with the website. A specific reversible test item/quantity sequence still requires approval. No purchase, amendment or slot booking is authorized.

The undocumented API can change, bot protection may reject replay, and the profile/context schemas may require adjustments after sanitized live observation. A plan is not an atomic retailer transaction. Price changes or a readback failure can leave verified or uncertain partial changes. Weighted fulfillment, substitutions and later website actions prevent a local estimate from guaranteeing the eventual payment amount. Existing catchweight is preserved; new catchweight choices stay on the website. Removal still requires a resolvable product and valid price; otherwise use the website.

No diagnostics are retained: screenshots, HAR capture and browser-page dumps were removed. Private opt-in diagnostic capture would need a separate redaction/retention implementation before introduction. No SMS/chat bridge is supported. There is no automatic reauthentication loop and no payment/amendment/booking execution code.

The approval digest binds plan contents to a review, but does not authenticate a human or isolate the agent. A same-user shell-capable agent can read session state or alter this code. Strong enforcement requires credentials in a separately isolated account/service and an allowlisted interface with an approval channel outside agent control. Local logout cannot revoke copied tokens.
