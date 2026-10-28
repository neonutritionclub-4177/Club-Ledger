# Supabase-only setup and deployment

Club Ledger uses Supabase Auth, Postgres, Row Level Security, Realtime, and an
Edge Function. Firebase is not used. Vercel only hosts the static PWA.

## 1. Prepare Supabase

1. Create or open your Supabase project.
2. In **SQL Editor**, run the complete contents of `supabase/schema.sql`.
   The script creates the tables, security policies, and owner-approval RPC.
   For an existing installation, also run
   `supabase/migrations/20261028000000_admin_club_reports_access.sql`. It
   restores the authenticated table grants used by owner ledger sync and
   permits platform admins to read (but not edit) club ledgers for reporting.
   It checks `pg_publication` directly and continues if the
   `supabase_realtime` publication is absent.
3. In **Authentication → Providers**, enable **Email** and allow email/password
   signups.
4. In **Authentication → Settings**, turn off email confirmation so customers
   can submit their club registration immediately. Owner requests are created
   automatically by a database trigger, even if confirmation is enabled.
   Users sign in with real email addresses; mobile numbers remain contact and
   matching details.
5. Create a local environment file from the template:

   ```powershell
   Copy-Item .env.example .env.local
   ```

   Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local` using
   the Project URL and anon/publishable key from **Project Settings → API**.
   Vite loads these values for local development and embeds them into the
   browser build. The anon/publishable key is public; never use the
   `service_role` key here.

## 2. Turn on Realtime

Realtime is used to refresh ledgers, customer registrations, and customer
cards across devices.

1. In the Supabase Dashboard, open **Database → Publications** (or
   **Database → Replication**, depending on the dashboard version).
2. Find the `supabase_realtime` publication.
3. Enable these tables for it: `club_ledgers`, `customer_registrations`, and
   `customer_portals`.

If the publication is not listed, use the dashboard's Realtime/Replication
table controls to enable Realtime for those three tables. Do not add a
publication statement to the SQL setup script; some projects do not allow
creating publications from SQL Editor.

## 3. Create the platform administrator

There is no public administrator signup.

1. In **Authentication → Users**, create the administrator account with a
   real email address and a strong, unique password. For convenience, the
   admin login form starts with `neonutritionclub@gmail.com` prefilled; create
   the Supabase Auth user using that email or replace the prefilled email with
   the one you registered.
2. Copy the new user's UUID.
3. In **SQL Editor**, register that UUID as an administrator:

   ```sql
   insert into public.platform_admins (user_uid)
   values ('PASTE-THE-ADMIN-USER-UUID-HERE');
   ```

   This table is not writable through the app. Only a trusted project
   administrator using SQL Editor should add or remove entries.
4. After deploying the app, sign in at
   `https://YOUR-VERCEL-DOMAIN/admin/login`.

   There is deliberately no default admin password in the app, source code,
   GitHub, or Vercel. Set and manage the password only in Supabase Auth. The
   account must also be listed in `platform_admins`; knowing the email and
   password alone does not grant platform-admin access.

## 4. Run the app locally

After creating `.env.local` in section 1, run:

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite. Stop the development server with
**Ctrl+C**. To check the production build locally, use:

```powershell
npm run build
npm run preview
```

## 5. Deploy the Supabase Edge Function

The `manage-account` function securely creates, resets, and removes customer
logins and can add another owner. It also handles platform-admin edits to owner
email/password and profile details. It verifies the caller's Supabase session
and checks platform-admin or club-owner privileges for each operation.

Run these commands from the project directory in Windows PowerShell:

```powershell
npm.cmd run supabase:login
npm.cmd run supabase:link -- --project-ref YOUR-SUPABASE-PROJECT-REF
npm.cmd run supabase:deploy -- --project-ref YOUR-SUPABASE-PROJECT-REF
```

Supabase supplies the function's URL, anon key, and service-role key in its
runtime. Do not add the service-role key to Vercel or commit it to GitHub.
After changing this function, deploy it again. If the app shows
“Failed to send a request to the Edge Function,” confirm you deployed
`manage-account` to the same Supabase project whose URL is configured in
Vercel, then redeploy the frontend and retry.

## 6. Deploy the PWA on Vercel

1. Push the project files, including `package.json` and `package-lock.json`,
   to a GitHub repository.
2. In Vercel, import that repository and select **Vite** as the framework.
   The root `vercel.json` runs `npm install` and `npm run build`, and serves
   the generated `dist` directory.
3. In **Project → Settings → Environment Variables**, add
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for Production (and Preview
   if you use preview deployments). Vercel supplies these to Vite during each
   build after you add them; they are not discovered or filled automatically
   just by deploying. Redeploy after adding or changing them.
4. Open the deployed URL. The rewrite rules in `vercel.json` route
   `/admin/login` and other app paths to the Vite single-page app. If a route
   still shows Vercel's 404 page, verify the latest GitHub commit was deployed,
   the Vercel project root is the repository root, and the output directory is
   `dist`, then redeploy.

Vite embeds `VITE_` variables into public browser code at build time. Only use
the Supabase anon/publishable key; never set the `service_role` key as a
`VITE_` variable. The Edge Function receives its privileged keys from Supabase.

No Firebase setup or Firebase domain allowlisting is needed.

### If owner signup or admin login fails

- **Owner dashboard says “permission denied for table club_ledgers,” or new
  customer registrations do not appear in the owner approval list:** Run the
  latest `supabase/schema.sql` or the
  `20261028000000_admin_club_reports_access.sql` migration in Supabase SQL
  Editor, then sign out and back in. The migration restores authenticated
  ledger/registration table grants while keeping ledger access limited by
  owner/admin row-level security policies.
- **Admin reports cannot load:** Verify the administrator UUID is in
  `public.platform_admins`, then apply the same migration. Admin report access
  is read-only and covers all registered clubs; the club selector also allows
  viewing one club at a time.
- **Owner signup:** Confirm Email/password signups are enabled and the latest
  `supabase/schema.sql` has been run. The schema installs a trigger that saves
  the owner request automatically as part of Auth account creation; no manual
  SQL insert is needed for new signups. An Auth validation or rate-limit
  failure still means the account and request were not created.
- **“Too many tries” during owner signup:** Stop retrying and let Supabase's
  auth/email limit reset. Check **Authentication → Settings** and turn off
  email confirmation before retrying. Use a real email address with a valid
  format; the app no longer invents an email from the phone number.
- **Check for an incomplete owner signup:** Run this in Supabase SQL Editor.

  ```sql
  select
    u.id,
    u.email,
    u.email_confirmed_at,
    r.status as owner_request_status
  from auth.users u
  left join public.owner_requests r on r.user_uid = u.id::text
  where lower(u.email) = lower('OWNER-EMAIL@example.com')
  order by u.created_at desc;
  ```

  If a user created before the trigger was installed has no matching request,
  the trigger cannot backfill it. Add that one existing request once using its
  Auth UUID and the correct owner details:

  ```sql
  insert into public.owner_requests
    (user_uid, owner_name, club_name, mobile, email, status)
  values
    ('PASTE-EXISTING-AUTH-USER-UUID', 'OWNER NAME', 'CLUB NAME',
     '+91 MOBILE NUMBER', 'OWNER-EMAIL@example.com', 'pending');
  ```

  New signups after installing the trigger do not need this manual insert.
- **Admin page shows Vercel 404:** Deploy the commit containing the current
  `vercel.json` rewrite rules. The admin route is part of the app; it is not a
  separate Vercel serverless backend.
- **Admin credentials rejected:** Create the admin user in Supabase
  **Authentication → Users** and add that user's exact UUID to
  `public.platform_admins` using the SQL in section 3.

## 7. Owner and customer registration

- Owners register with name, club name, email, mobile number, and password.
  The database automatically adds their request to the admin queue. Their
  request stays pending until a platform admin approves it in `/admin/login`.
- The admin portal displays requests and approvals month-wise. Admins can edit
  owner name, club name, mobile, login email, and optionally set a new
  password. Admins can archive/restore history entries and revoke/restore
  owner access. Revoking removes the owner's membership and hides the club
  from customer signup, but preserves the club and ledger data; restoring
  access makes the existing data available again. Archive is reversible and
  does not delete the owner's Auth account or records.
- Customers choose an approved club, enter their name, email, and mobile
  number, and wait for that club's owner to link their registration to a ledger
  record.
- Club owners can create customer logins from customer records. Account
  management runs through the deployed Edge Function.
- Existing logins created with phone-derived or placeholder email addresses
  are not converted automatically. Have the owner remove and recreate a
  customer login with the customer's real email; owners with incomplete signup
  attempts should register again using a real email address.

Keep the Supabase RLS policies from `schema.sql` enabled. Do not grant clients
access to the Supabase service-role key.

## Moving from Firebase

Firebase passwords cannot be transferred to Supabase. As requested, owners and
customers must create new Supabase accounts. Before switching, owners should
download a Club Ledger JSON backup and keep it safely. After a new owner account
has been approved, restore that backup from the app's **Backup & restore**
screen. Existing Firebase-only account and registration records are not
automatically imported. When restoring an older backup, legacy customer-login
links are removed; customers must register again or receive a new login from
their owner.
