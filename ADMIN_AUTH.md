# Administrator authentication

Outlist administrator access is invite-only and uses Supabase email-and-password
authentication. Public signup, registration, passwordless login, and public
password-reset flows are not part of the application. A trusted operator
provisions Auth users and the separate administrator UUID allowlist.

Production administrator password sign-in has been verified. The ingestion
preflight rechecks that an allowlisted administrator exists, the Email provider
is enabled, and public signup is disabled before reporting ingestion ready.

## Authentication and authorization

1. `/admin/login` accepts an email address and password. It has no OTP or Magic
   Link interface.
2. A Next.js Server Action validates the input and calls
   `supabase.auth.signInWithPassword({ email, password })` through the existing
   Supabase SSR client. Credentials are not stored in application tables,
   localStorage, or logs.
3. Supabase SSR writes the session to HTTP-only cookies, marked `secure` in
   production. The scoped Next.js 16 `src/proxy.ts` refreshes an expiring
   session with `auth.getClaims()` and forwards updated cookies. Proxy refreshes
   sessions; it does not grant administrator access.
4. After sign-in, the server verifies the cookie-backed identity with
   `auth.getClaims()`, takes the verified UUID from `sub`, and checks for that
   exact UUID in `public.admin_users` with the server-only privileged client.
   A missing or unverifiable row clears the new session and returns the same
   generic credentials error. Email, user metadata, and browser state never
   grant access.
5. The admin layout, dashboard, project routes, and every protected Server
   Action independently call `getAdminIdentity()` or `requireAdmin()`. Each
   check performs a fresh allowlist lookup. Editorial database functions also
   require the service role and recheck current allowlist membership.
6. Sign out calls Supabase Auth from a Server Action, clears Auth cookies, and
   redirects to `/admin/login`.

The login route is the only route exempted from the dynamic admin layout. Proxy
overwrites the internal route header from the request path. Admin pages use
dynamic rendering and `Cache-Control: private, no-store`. The existing RLS,
grants, allowlist table, and database publication safeguards are unchanged.

Modules that read `SUPABASE_SECRET_KEY` are server-only. The secret key is used
for the allowlist lookup and other existing server-only operations; it is
never sent to the browser. Passwords, session tokens, and secret keys must not
be printed in logs or committed files.

## Supabase configuration

In local `supabase/config.toml`, public signup is disabled. The Supabase email
provider must remain enabled for email/password sign-in. The read-only
ingestion and launch preflight checks the hosted settings below. If preflight
reports a mismatch, review it in **Authentication → Sign In / Providers**:

- Enable the Email provider for password authentication.
- Disable **Allow new users to sign up**. Do not use public signup to provision
  an administrator.
- Keep email confirmation enabled. Only a trusted operator should mark an
  account confirmed after verifying that the intended administrator controls
  the email address through an established, trusted channel.

Password login does not use an email template, SMTP delivery, Site URL, or
redirect callback. The application does not implement OTP, Magic Link,
registration, or password-reset routes.

For local development, copy `.env.example` to `.env.local`, then set the local
values shown by `supabase status`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key>
SUPABASE_SECRET_KEY=<local secret key>
```

Never put the secret key in a `NEXT_PUBLIC_` variable. Local Auth test users in
the disposable browser suite receive random per-run passwords; those tests do
not use Mailpit.

## Provision a trusted administrator

Provisioning requires both a Supabase Auth user and a row containing its exact
Auth UUID in `public.admin_users`. Do not use a public signup form, a migration,
or an app-side registration action.

1. Verify the person's identity and that they control the exact email address
   through a trusted process before marking the Auth email as confirmed. Do
   not treat a supplied email address by itself as proof of ownership.
2. In the intended project's Supabase Dashboard, open **Authentication →
   Users** and create the user with the verified email and a unique, strong
   password. Keep the email unconfirmed until step 1 is complete. Alternatively,
   use the Auth Admin API from a trusted server environment:

   ```ts
   const { data, error } = await supabase.auth.admin.createUser({
     email: verifiedEmail,
     password: strongUniquePassword,
     email_confirm: true, // only after the email owner has been verified
   });
   ```

   The Auth Admin API and secret key must remain server-side. Do not log or
   persist the password. The operator must not set `email_confirm: true` for an
   unverified identity.
3. Copy the returned Auth `id`. In the Dashboard SQL Editor or another trusted
   database administration workflow, add that exact UUID:

   ```sql
   insert into public.admin_users (user_id)
   values ('<verified-auth-user-uuid>');
   ```

   The foreign key rejects UUIDs that do not belong to an Auth user. Never
   insert email addresses or invented UUIDs into the allowlist.
4. Give the administrator their initial password through a separate secure
   channel, then verify that the account can sign in and reaches `/admin`.
   Keep `public.admin_users` private; do not add allowlist data to migrations
   or application seed data.

## Reset an administrator password

There is no public reset endpoint or email-based recovery flow in this MVP. A
trusted operator can reset an administrator password after verifying the
person's identity through the established administrative process:

1. Generate a unique strong password in an approved password manager.
2. In **Authentication → Users**, set the password for the exact Auth user, or
   call the Auth Admin API from a trusted server-only environment:

   ```ts
   const { error } = await supabase.auth.admin.updateUserById(
     verifiedAuthUserUuid,
     { password: newStrongPassword },
   );
   ```

3. Deliver the temporary password through a separate secure channel. Never
   place it in SQL, app tables, source control, logs, or a browser. For a
   suspected compromise, also revoke the user's existing Auth sessions using
   the trusted Auth administration workflow.

## Revoke or replace access

To revoke administrator authorization, delete the matching row through the
Dashboard SQL Editor or another privileged database workflow:

```sql
delete from public.admin_users
where user_id = '<auth-user-uuid>';
```

The next protected request performs a fresh lookup and denies access even if
the Auth session remains valid. This does not delete the Auth user. To replace
an administrator, verify and provision the replacement account, add its UUID,
verify access, then revoke the old UUID and invalidate its Auth sessions. If a
secret key may have been exposed, rotate it in Supabase and update the server
environment.

## Verification

Vitest mocks Supabase Auth and PostgREST. The focused unit coverage checks
password sign-in, invalid credentials, missing and malformed input, non-
allowlisted denial, logout, fresh allowlist checks, and server-action
authorization. pgTAP continues to verify ordinary roles cannot read or change
`admin_users`.

The separate `auth-e2e` CI job provisions disposable local Auth users with
random passwords, inserts selected UUIDs into the local allowlist, starts a
production Next.js server, and exercises password sign-in, generic failures,
protected routes, session cookies, allowlist revocation, editorial actions,
and logout in Chromium. It requires Docker and resets only its disposable
local Supabase stack; it does not use hosted credentials. Do not run that job
when Docker or local PostgreSQL use is disallowed.

## References

- [Supabase password-based Auth](https://supabase.com/docs/guides/auth/passwords)
- [Supabase Auth Admin `createUser`](https://supabase.com/docs/reference/javascript/auth-admin-createuser)
- [Supabase Auth Admin `updateUserById`](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid)
- [Supabase Auth general configuration](https://supabase.com/docs/guides/auth/general-configuration)
- [Supabase SSR authentication](https://supabase.com/docs/guides/auth/server-side)
- [Next.js Proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Next.js Server Actions](https://nextjs.org/docs/app/getting-started/mutating-data)
- [Playwright authentication](https://playwright.dev/docs/auth)
