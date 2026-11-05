"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  adminEmailSchema,
  adminOtpSchema,
} from "@/lib/auth/schemas";
import {
  requestAdminOtp,
  verifyAdminOtp,
  type AdminAuthActionResult,
} from "@/app/admin/login/actions";

type Step = "email" | "code";

export function AdminLoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [feedback, setFeedback] = useState<AdminAuthActionResult | null>(null);
  const [emailError, setEmailError] = useState("");
  const [tokenError, setTokenError] = useState("");
  const [pending, startTransition] = useTransition();

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = adminEmailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? "Enter a valid email address.");
      setFeedback(null);
      return;
    }

    setEmailError("");
    setFeedback(null);
    startTransition(async () => {
      const result = await requestAdminOtp({ email: parsed.data });
      setFeedback(result);
      if (result.status === "requested") setStep("code");
    });
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = adminOtpSchema.safeParse(token);
    if (!parsed.success) {
      setTokenError(parsed.error.issues[0]?.message ?? "Enter the one-time code.");
      setFeedback(null);
      return;
    }

    setTokenError("");
    setFeedback(null);
    startTransition(async () => {
      const result = await verifyAdminOtp({ email, token: parsed.data });
      setFeedback(result);
      if (result.status === "authenticated") {
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
            Use the email address provisioned for Outlist administration. We’ll
            send a one-time code if the account is eligible.
          </p>

          {step === "email" ? (
            <form onSubmit={submitEmail} noValidate>
              <div className="form-field">
                <label className="field-label" htmlFor="admin-email">
                  Email address
                </label>
                <input
                  autoComplete="email"
                  className="input"
                  id="admin-email"
                  inputMode="email"
                  maxLength={254}
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                  aria-invalid={Boolean(emailError)}
                  aria-describedby={emailError ? "admin-email-error" : undefined}
                />
                {emailError && (
                  <p className="error" id="admin-email-error" role="alert">
                    {emailError}
                  </p>
                )}
              </div>
              <Button disabled={pending} type="submit">
                {pending ? "Sending request…" : "Send one-time code"}
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} noValidate>
              {feedback?.status === "requested" && (
                <p className="alert-inline" role="status">
                  {feedback.message}
                </p>
              )}
              <div className="form-field">
                <label className="field-label" htmlFor="admin-code">
                  One-time code
                </label>
                <input
                  autoComplete="one-time-code"
                  autoFocus
                  className="input"
                  id="admin-code"
                  inputMode="numeric"
                  maxLength={8}
                  name="token"
                  onChange={(event) => {
                    setToken(event.target.value.replace(/\D/g, "").slice(0, 8));
                    setTokenError("");
                    setFeedback(null);
                  }}
                  pattern="[0-9]{6,8}"
                  required
                  type="text"
                  value={token}
                  aria-invalid={Boolean(tokenError || feedback?.status === "invalid" || feedback?.status === "invalid_or_expired")}
                  aria-describedby={
                    tokenError || feedback?.status === "invalid" || feedback?.status === "invalid_or_expired"
                      ? "admin-code-error"
                      : undefined
                  }
                />
                {(tokenError || feedback?.status === "invalid" || feedback?.status === "invalid_or_expired") && (
                  <p className="error" id="admin-code-error" role="alert">
                    {tokenError || feedback?.message}
                  </p>
                )}
              </div>
              {feedback &&
                ["configuration_error", "service_error", "not_authorized"].includes(
                  feedback.status,
                ) && (
                  <p className="alert-inline" role="alert">
                    {feedback.message}
                  </p>
                )}
              <div className="form-actions">
                <Button disabled={pending} type="submit">
                  {pending ? "Verifying…" : "Verify code"}
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => {
                    setToken("");
                    setFeedback(null);
                    setStep("email");
                  }}
                  type="button"
                  variant="outline"
                >
                  Use another email
                </Button>
              </div>
            </form>
          )}

          {step === "email" &&
            ["configuration_error", "service_error"].includes(feedback?.status ?? "") && (
            <p className="alert-inline" role="alert" style={{ marginTop: 18 }}>
              {feedback?.message}
            </p>
          )}
        </section>

        <aside className="guide-box">
          <h2>Administrator access</h2>
          <ol>
            <li>Only accounts provisioned by a site administrator can sign in.</li>
            <li>Use the one-time code from your email before it expires.</li>
            <li>Contact the site administrator if you need access.</li>
          </ol>
        </aside>
      </div>
    </main>
  );
}
