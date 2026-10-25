# Club Ledger — Standalone App (v13)

Installable web-app version of your customer/payment/attendance tracker.
The ledger syncs through Supabase Postgres and is cached on-device
(localStorage) for offline work. Supabase Auth provides sign-in; Supabase
Postgres and Realtime handle club approvals, registrations, the ledger, and
private customer portal snapshots.

Read `SUPABASE-SETUP.md` before deployment. Pack presets, prices, expiry
lengths, and alert thresholds are editable in `js/config.js`. Supabase
credentials are supplied through Vite environment variables. Vite, the
Supabase CLI, and app tests are available through npm.

## Local development

1. Copy `.env.example` to `.env.local` and set the Supabase project URL and
   anon/publishable key.
2. Run `npm install`, then `npm run dev`.
3. Open the local URL printed by Vite. Run `npm test` for the app tests and
   `npm run build` to create the production `dist` folder.

## What's new in v13

### Club-scoped owner and customer registration
- Owner account setup collects owner name, club name, email, mobile number,
  password, and confirmation. Supabase Auth creates the account and stores an owner
  approval request; only platform-admin approval creates the owner profile and
  customer-visible club directory entry.
- Customer login includes a **New customer? Register** link. Customers select
  a club, enter their name/email/mobile/password, and remain pending until an owner
  approves and links them to an existing or new customer record.
- Every club has an isolated Supabase ledger with owner-only row-level
  security. Supabase RLS limits customer registrations and portal cards to the
  owning club or the matching customer.

### Platform-admin owner approval
- The database automatically saves new owner signups as pending requests; they do not create a customer-visible club until approved.
- The platform administrator signs in at `/admin/login` and approves or rejects requests.
- The admin portal groups owner requests into month-wise history, supports filtering, editing owner details/password, archiving/restoring history, and revoking/restoring owner access without deleting club data.
- After owner signup, a dialog asks the applicant to contact the admin using the configured WhatsApp link.
- Admin access is protected by a private Supabase `platform_admins` table and a
  server-checked database function; there is no public admin signup.
- The admin sign-in page pre-fills `neonutritionclub@gmail.com`; the Supabase
  Auth account must be separately created and its UUID allow-listed. There is
  no default password in the app.

### Logins: owners and customers, separate
- Login screen has an **Owner** tab and a **Customer** tab (email + password).
- Sign in with the real email address and password used during registration.
  Mobile number remains the club's contact and matching identifier.
- **Owners** see and edit everything, as before. Add more owners from the
  person icon → Add another owner.
- **Customers** get a private "My Club Card": shakes left, balance, pack dates,
  their own payment history, and a month/year attendance calendar. They can
  change their own password.
- Create a customer's login from their card on the Customers tab → **Create
  login** → send the details on WhatsApp. **Reset password** and **Remove
  login** are on the same card.
- Real protection: Supabase RLS scopes ledger rows to club owners and customer
  portal reads to the signed-in customer.

### Alerts to customers
- **Automatic, in the customer app:** warning at the top of their card when
  2 or fewer shakes are left, when the pack is finished, when the pack is
  expiring soon, or when a balance is pending. Updates live when you mark
  attendance or take a payment.
- **One-tap WhatsApp reminders:** "Remind" button on the Dashboard rows
  (pack renewals due, payment follow-up) and in the Customers report. Message is
  pre-written; the app remembers who you reminded.
- Attendance supports multiple shakes per customer per day and warns before
  exceeding the pack. Orders support quantities and per-unit prices.
- Customer, order, payment, order item, pack, and attendance records retain
  timestamps and soft-deleted entries. Cloud sync resolves both parent and
  nested record conflicts by each record's latest `updatedAt`.

### Better reports (Reports tab → Daily / Monthly / Customers)
- **Daily:** revenue for any day (packs + orders), shakes served, packs started,
  every payment listed, last-14-days chart.
- **Monthly:** total revenue with change vs last month, average per day, best
  day, 6-month chart with values, plus the Club and Orders sections from v9.
- **Customers:** top customers by revenue, most regular visitors, top order
  buyers, **pack renewals** (due now with expected value, and renewed in the
  period). Period: this month / 90 days / all time.

## How packs & shakes work

Every customer has a **current pack**: a number of shakes + a cost (e.g. 30
shakes for ₹7500, or 10 shakes for ₹3000, or 1 shake for a walk-in's day rate).

- Each shake marked on the **Attendance** tab is counted against their current
  pack — no fixed calendar, so daily visitors and once-every-3-days visitors
  both get tracked correctly.
- **Balance due** = pack cost − payments made since that pack started.
- When shakes run low (≤2) or hit 0, the customer shows up under
  **"Pack renewals due"** on the Dashboard. Tap **Renew** to start their
  next pack (new shake count + new cost — handles registration → monthly
  upgrades, monthly renewals, or a walk-in coming back).
- Old packs move into **"Previous packs"** on the customer's card — full
  history is kept.

### Adding an existing customer who's mid-pack
When adding someone who already has a pack running, fill in the actual
**Remaining shakes** count. Their visit history before today wasn't tracked,
so this keeps their balance accurate.

## Orders (retail / wholesale sales) — v8

A separate **Orders** tab for one-off product sales — not tied to the pack
system. Use this for retail/wholesale customers buying individual products
(walk-ins, bulk buyers, anyone outside the regular shake-pack flow).

- Tap **+** → enter customer name, date, and add as many line items as
  needed (product name + price each + quantity). Total is calculated automatically.
- Optionally record a payment made at the time of sale.
- Every order keeps a **full payment history** — tap **Add payment** any
  time they pay more (full or partial). Balance updates live after each
  payment.
- Orders with a balance > 0 show under **Pending** (oldest first) and also
  appear on the Dashboard under **"Orders — pending payments"**, so nothing
  gets forgotten even weeks later.
- The header's **"Total due"** combines pack balances and order balances.

## 1. Deploy the app

### Vercel (recommended)
1. Import the project repository into Vercel, or run `vercel` from this folder.
2. Set the framework preset to **Vite**. Build and output settings are in
   `vercel.json`.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Vercel Project
   Settings → Environment Variables, then deploy.
4. Open the resulting HTTPS URL on both owner phones and sign in.

This is a static Vite PWA backed by Supabase. Vercel injects the configured
environment variables during the build; adding them to Vercel is a one-time
project setup, not automatic detection. See `SUPABASE-SETUP.md` for details.

### Netlify Drop (alternative)
1. Go to https://app.netlify.com/drop on your computer
2. Run `npm run build`, then drag the generated `dist` folder onto the page
3. Netlify gives you a live URL (e.g. `https://random-name.netlify.app`)
4. Open that URL on your phone

**Updating later:** drag the folder onto the same Netlify project page again
to redeploy with new changes.

For Netlify builds, set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` in the site's environment-variable settings before
building. The Vercel `/admin/login` rewrite is configured in `vercel.json`;
use Vercel for that route.

## 2. Add it to your phone home screen

### Android (Chrome)
1. Open your app URL in Chrome
2. Tap the **⋮** menu → **Add to Home screen** (or use the "Install app" banner)
3. Confirm — you'll get a Club Ledger icon like any other app

### iPhone (Safari)
1. Open your app URL in Safari
2. Tap the **Share** icon (square with arrow) at the bottom
3. Tap **Add to Home Screen**
4. Confirm — you'll get a Club Ledger icon

Once added, it opens full-screen with no browser bar.

## 3. Live sync across phones (owners)

The header shows a small status dot:
- 🟢 **Synced** — this phone's data matches the cloud
- 🟡 **Syncing…** — sending/receiving an update
- 🔴 **Offline** — no internet right now; the app keeps working off the
  on-device cache and will sync once back online

Any owner phone logged in sees the same data, updated live. Customers see only
their own card.

## 4. Backup your data

Even with sync, keep occasional backups in case of accidental deletes.

- Tap the download icon (top right of the app) → **Download backup**
- This saves a `.json` file with customers, packs, payments, attendance,
  orders, and retained soft-deleted records
- To restore: same menu → **Restore from backup** → pick the file

**Do this weekly.** Save the backup file to Google Drive / WhatsApp to yourself.

## Tests

Run the dependency-free regression suite with `node --test tests/app-smoke.test.js`.

## Files in this folder
- `index.html` — the app shell and UI
- `js/config.js` — editable Supabase, club, pack, and alert settings
- `tests/app-smoke.test.js` — dependency-free regression tests for core workflows
- `supabase/schema.sql` — Supabase tables, owner/customer RLS, and approval RPC
- `supabase/functions/manage-account/` — trusted owner-managed account operations
- `SUPABASE-SETUP.md` — Supabase Auth, schema, admin, Functions, and deployment setup
- `vercel.json` — static-site settings for deploying this PWA on Vercel
- `manifest.json` — makes it installable (PWA)
- `sw.js` — service worker, lets it work offline after first load
- `icon-*.png` — app icons
