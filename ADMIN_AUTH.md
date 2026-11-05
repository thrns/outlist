# Administrator authentication

Outlist administrator access is invite-only and uses Supabase email one-time
passwords (OTP). The application does not expose account registration,
password sign-in, social sign-in, or password reset. New accounts and changes to
the administrator allowlist are trusted administrative operations.

## Authentication lifecycle

1. An administrator enters an email address at `/admin/login`.
2. A Next.js Server Action calls `signInWithOtp` with `shouldCreateUser: false`.
   The response is the same whether Auth accepts or rejects the address, so the
   page does not reveal account existence.
3. The administrator enters the emailed code. The Server Action validates the
   email and code with Zod, then calls `verifyOtp` with `type: "email"`.
4. Supabase SSR stores the resulting session in HTTP-only cookies. The Next.js
   16 `src/proxy.ts` refreshes sessions with `auth.getClaims()` only on `/admin` and
   `/admin/*`, forwarding updated request and response cookies.
5. The server admin layout and `/admin` page independently call
   `getAdminIdentity()` / `requireAdmin()`. These verify claims with
   `getClaims()`, take the UUID from the verified `sub`, and query
   `public.admin_users` through the server-only Supabase secret client.
   A matching UUID row is required on each protected request. Email, user
   metadata, and client-side state do not grant access.
6. The visible Sign out form submits a Server Action with POST. It calls
   Supabase `signOut()`, clears Supabase Auth cookies, and redirects to
   `/admin/login`.

The Proxy refreshes cookies; it is not the authorization boundary. Every page
under `src/app/admin/` is guarded by the dynamic server layout, and protected
Server Actions or Route Handlers must call `requireAdmin()` themselves before
performing work. The login route is explicitly exempted from the layout gate by
an internal request header that Proxy derives from the request path and
overwrites on every matching request. Protected pages send
`Cache-Control: private, no-store` and are dynamically rendered.

Every module that reads `SUPABASE_SECRET_KEY` is server-only. Only the
privileged client sends the key to Supabase, and it uses it only for the exact
allowlist lookup. The key is never sent to the browser.
`public.admin_users` remains private under its existing RLS and grants;
ordinary `anon` and `authenticated` roles cannot read or change it.

## Start local Supabase

Local Auth and email delivery require a Docker-compatible runtime. From the
repository root:

```bash
bun install --frozen-lockfile
bun run supabase start
bun run supabase status
```

Copy `.env.example` to `.env.local` and use the local API URL, publishable key,
and secret key printed by `supabase status`:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key>
SUPABASE_SECRET_KEY=<local secret key>
```

The local project config disables public account creation and points the
Supabase Auth Magic Link template at
`supabase/templates/admin-otp.html`. That template includes `{{ .Token }}` so
`signInWithOtp` sends a code that can be entered in the app. After changing the
template configuration, restart the local stack:

```bash
bun run supabase stop
bun run supabase start
bun run dev
```

The local Supabase CLI captures Auth emails in Mailpit. Open the Inbucket URL
shown by `bun run supabase status` (normally `http://127.0.0.1:54324`) to read
test OTP messages. Local delivery does not send real email.

## Provision the first administrator

Provisioning has two separate, trusted steps. Never use the public login form,
a signup endpoint, browser code, or a migration to create an administrator.

1. In local Supabase Studio (the URL printed by `bun run supabase status`), use
   the Auth Users administrative UI to create the user with the intended email
   and a confirmed email address. In a trusted server-side administrative
   workflow, the equivalent Supabase Auth Admin API call is
   `auth.admin.createUser({ email, email_confirm: true })`. Use the secret key
   only in that trusted workflow, never in a browser or committed script.
2. Copy the returned Auth user UUID. It is the Auth `id`, not the email and not
   a UUID invented by the operator.
3. In the local Studio SQL Editor, run the following as the database owner,
   replacing the placeholder with that exact Auth UUID:

   ```sql
   insert into public.admin_users (user_id)
   values ('<auth-user-uuid>');
   ```

   The table has a foreign key to `auth.users`; a nonexistent UUID will fail.
4. Start Outlist, open `/admin/login`, enter the provisioned email, and use the
   code in Mailpit. The admin page checks the UUID allowlist entry again on
   every request.

Do not add administrator identities to migration or seed SQL. Do not enable
public signup to simplify provisioning.

## Remove or replace access

To revoke access, delete the matching row using the Studio SQL Editor or another
privileged database administration workflow:

```sql
delete from public.admin_users
where user_id = '<auth-user-uuid>';
```

The next protected request performs a fresh lookup and denies access even if
the Auth session remains valid. This does not delete the Auth user. For a
compromised account, also revoke its sessions or ban/delete it using the Auth
administrative workflow. To replace an administrator, create and verify the
replacement Auth user, add the replacement UUID, verify access, then revoke the
old UUID and invalidate the old account's sessions. Rotate the Supabase secret
key if it may have been exposed, and update the server environment.

## Hosted Supabase setup

For each hosted project:

1. Apply the committed database migrations through the approved deployment
   process.
2. Disable **Allow new users to sign up** in Authentication settings. Also
   confirm no alternate public Auth flow is enabled for account creation.
3. Configure the Auth **Magic Link** email template to contain `{{ .Token }}`
   (and not only `{{ .ConfirmationURL }}`); the OTP must match the email
   template used by this app.
4. Set the Site URL to the deployed app origin and review the allowed redirect
   URL list. The OTP form flow does not need an email-link callback.
5. Configure a production SMTP provider, sender identity, SPF/DKIM/DMARC, and
   delivery monitoring. Supabase's built-in SMTP is intended for testing and
   restricts delivery to authorized team addresses.
6. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and
   `SUPABASE_SECRET_KEY` in the server deployment environment. Keep the secret
   key out of all `NEXT_PUBLIC_` variables, client code, logs, and source
   control.
7. Create the administrator through the hosted Supabase Auth administrative
   UI or a trusted Auth Admin API workflow, obtain the Auth UUID, and insert
   that UUID into `public.admin_users` through the SQL Editor or another
   privileged database operation.

Use production Auth rate limits for sign-in requests and token verification,
keep OTP expiry short, monitor SMTP abuse and delivery, and consider CAPTCHA or
additional request throttling if the admin login is exposed to the public
internet. Disable email click tracking for authentication messages. Do not
raise Auth rate limits to work around a delivery problem.

Supabase Auth reports a rejected OTP as `otp_expired` with the shared message
“Token has expired or is invalid,” so the interface shows a combined
invalid-or-expired state and lets the user request a fresh code.

## Scope and verification limits

The admin dashboard is still a local browser demonstration. Approvals,
rejections, featured and visibility toggles, submissions, and mock sync actions
modify only the current browser's `localStorage`; they do not update production
tables or call repository providers.

Unit tests mock Supabase Auth and PostgREST calls. pgTAP checks ordinary-role
access to `admin_users`. The `auth-e2e` CI job additionally starts a disposable
local Supabase stack, applies the committed migrations, provisions temporary
confirmed users through the Auth Admin API, inserts their real UUIDs into the
allowlist, starts the production Next.js server, reads actual OTPs from
Mailpit, and exercises the browser login, authorization, revocation, and logout
flows with Chromium. It also checks anonymous and forged-header requests,
unknown-email behavior, incorrect and expired OTPs, public-directory
availability, SSR cookie attributes, and protected response cache headers.

To run the same integration suite locally, install Chromium once and run:

```bash
bunx playwright install chromium
bun run test:auth-e2e
```

This command requires a Docker-compatible runtime and a stopped local Supabase
stack. It starts Supabase, resets the local database from migrations, uses
temporary `.example.com` identities, then removes their Auth users, allowlist
rows, and Mailpit messages and stops the stack with its volumes removed. It
does not use hosted credentials. The runner suppresses Supabase CLI output so
local keys and OTPs are not written to logs; browser traces, screenshots, and
videos are disabled.

This verifies the local Supabase Auth and PostgreSQL integration, local Mailpit
delivery, and the production Next.js browser flow. It does not verify hosted
Supabase project settings, administrator provisioning in a hosted project, or
delivery through a hosted SMTP provider. Hosted SMTP delivery remains outside
M0-03; Mailpit success is not evidence of production email deliverability.

## References

- [Supabase SSR authentication](https://supabase.com/docs/guides/auth/server-side)
- [Supabase Next.js SSR client](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)
- [Supabase `signInWithOtp`](https://supabase.com/docs/reference/javascript/auth-signinwithotp)
- [Supabase `verifyOtp`](https://supabase.com/docs/reference/javascript/auth-verifyotp)
- [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Local email templates and Mailpit](https://supabase.com/docs/guides/local-development/customizing-email-templates)
- [Supabase SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp)
- [Next.js Proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Next.js Server Actions](https://nextjs.org/docs/app/getting-started/mutating-data)
- [Playwright authentication and browser contexts](https://playwright.dev/docs/auth)
- [Mailpit API](https://mailpit.axllent.org/docs/api-v1/)
