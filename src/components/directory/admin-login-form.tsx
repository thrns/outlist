"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { adminPasswordSignInSchema } from "@/lib/auth/schemas";
import {
  signInAdmin,
  type AdminAuthActionResult,
} from "@/app/admin/login/actions";

export function AdminLoginForm() {
  const router = useRouter();
  const [feedback, setFeedback] = useState<AdminAuthActionResult | null>(null);
  const [emailError, setEmailError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const parsed = adminPasswordSignInSchema.safeParse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    if (!parsed.success) {
      const issues = parsed.error.flatten().fieldErrors;
      setEmailError(issues.email?.[0] ?? "");
      setPasswordError(issues.password?.[0] ?? "");
      setFeedback(null);
      return;
    }

    setEmailError("");
    setPasswordError("");
    setFeedback(null);
    startTransition(async () => {
      const result = await signInAdmin(parsed.data);
      setFeedback(result);
      if (result.status === "authenticated") {
        form.reset();
        router.replace("/admin");
        router.refresh();
      }
    });
  }

  return (
    <main className="container page">
      <div className="crumb">
        <span>Outlist</span>
        <span aria-hidden="true">/</span>
        <span>Administrator sign in</span>
      </div>
      <div className="form-layout" style={{ maxWidth: 890, margin: "34px auto 0" }}>
        <section className="form-card">
          <div className="eyebrow muted">Invite-only access</div>
          <h1 className="page-title">Administrator sign in</h1>
          <p className="muted" style={{ lineHeight: 1.7, marginTop: 0 }}>
            Sign in with the email address and password provisioned for Outlist
            administration.
          </p>

          <form onSubmit={submit} noValidate>
            <div className="form-field">
              <label className="field-label" htmlFor="admin-email">
                Email address
              </label>
              <input
                autoComplete="username"
                className="input"
                id="admin-email"
                inputMode="email"
                maxLength={254}
                name="email"
                onChange={() => {
                  setEmailError("");
                  setFeedback(null);
                }}
                required
                type="email"
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? "admin-email-error" : undefined}
              />
              {emailError && (
                <p className="error" id="admin-email-error" role="alert">
                  {emailError}
                </p>
              )}
            </div>

            <div className="form-field">
              <label className="field-label" htmlFor="admin-password">
                Password
              </label>
              <input
                autoComplete="current-password"
                className="input"
                id="admin-password"
                maxLength={1024}
                name="password"
                onChange={() => {
                  setPasswordError("");
                  setFeedback(null);
                }}
                required
                type="password"
                aria-invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? "admin-password-error" : undefined}
              />
              {passwordError && (
                <p className="error" id="admin-password-error" role="alert">
                  {passwordError}
                </p>
              )}
            </div>

            {feedback && feedback.status !== "authenticated" && (
              <p className="error" role="alert">
                {feedback.message}
              </p>
            )}

            <Button disabled={pending} type="submit">
              {pending ? "Signing in…" : "Sign In"}
            </Button>
          </form>
        </section>

        <aside className="guide-box">
          <h2>Administrator access</h2>
          <ol>
            <li>Only trusted accounts provisioned by a site administrator can sign in.</li>
            <li>Access is granted only to Auth user UUIDs on the administrator allowlist.</li>
            <li>Contact the site administrator if you need access or a password reset.</li>
          </ol>
        </aside>
      </div>
    </main>
  );
}
