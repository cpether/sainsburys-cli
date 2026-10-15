# Supervised live validation

Status: pending successful CLI login and verified reads. The first user-supervised attempt reached the account/trolley page, then closed with a generic terminal failure. A retry with stage diagnostics captured authenticated credentials, then failed before a usable verification response reached the validator. Claude independently reproduced a response-adapter failure with multiple Set-Cookie headers using real Playwright HTTP and a dummy loopback server. That defect and the export of cookies refreshed by verification are fixed with regression coverage. It is a strong candidate for the live cause, awaiting retry. The assistant has made no live retailer requests or basket changes. Offline tests establish local behavior only.

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

The assistant must first show you the specific SKU, product name, original quantity, units, test target quantities, delivery context, estimated basket totals and limits. You must approve that item and sequence before any live write. Choose a low-cost ordinary `ea` item, ideally absent initially; maximum test quantity two. No approval has been given yet.

For an initially absent approved item, generate and review a separate constrained plan for each step:

1. Set its target to 1 and verify the CLI readback and website.
2. Set its target to 2 and verify both again.
3. Set its target to 0 and verify removal.
4. Confirm the whole basket matches the original quantities, units and catchweight selections. If initially present, restore the original target quantity instead of leaving it removed. Do not adjust unrelated lines.

Use the README `basket plan`/`basket apply --approve` commands for every step. Applying a satisfied plan again should report zero writes. A fresh plan needs a fresh review. Do not retry an uncertain result. Inspect the website, then prepare a new recovery plan only after the person reviews the actual state. Every mutation needs readback even if its HTTP response failed.

## Session reuse and decision point

Run a fresh CLI process to read the identity and basket using the cached session. After natural session expiry, confirm that a read returns an authentication/challenge error without starting another browser or mutation. Run explicit local login and verify identity/basket again. A later supervised read on another occasion gives better evidence than immediate reuse alone.

If login cannot establish identity, ordinary browser use works but direct HTTP replay is consistently challenged, or verified basket writes remain unreliable, stop after a bounded pilot. Record sanitized endpoint shapes, response status/content type, the operation and observed website state. Never store token-bearing headers, passwords, MFA codes, cookies, HARs or full account screenshots in the repository. Explain that evidence before replacing authentication or transport. Preserve the useful request shapes and sanitized fixtures.

No step authorizes placing an order, submitting payment, amending an existing order or booking/changing a slot. All checkout and payment stays manual on Sainsbury's website.
