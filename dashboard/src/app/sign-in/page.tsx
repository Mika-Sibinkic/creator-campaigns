// src/app/sign-in/page.tsx
//
// Clerk-hosted sign-in. Clerk handles email delivery + the OTP/link UI; on
// success we route through /auth/clerk-bootstrap, which allowlist-gates and
// provisions firm_members before landing the user in the dashboard.
"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { Crosshair } from "lucide-react";

function SignInInner() {
  const params = useSearchParams();
  const notAllowed = params.get("error") === "not_allowed";

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0 bg-[radial-gradient(circle_at_30%_20%,var(--accent)/30%,transparent_60%)]"
      />
      <div className="relative z-10 w-full max-w-sm space-y-8">
        <div className="space-y-3 text-center">
          <div className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <Crosshair className="size-6 text-primary" />
          </div>
          <h1 className="heading-chrome text-2xl">Creator Campaigns</h1>
          <div aria-hidden className="mx-auto h-px w-10 bg-brand-accent" />
        </div>

        {notAllowed && (
          <div
            role="alert"
            className="rounded-lg border border-status-payout-pending bg-status-payout-pending/60 p-4 text-sm"
          >
            <div className="font-medium text-status-payout-pending-fg">
              Sign-in disabled for this email
            </div>
            {/* An outsider sees this before anything else, so it must be
                actionable without knowing who runs the company. Naming the
                operator here also handed a stranger a real person to social
                -engineer against. */}
            <div className="mt-1 text-muted-foreground">
              Creator Campaigns is invite-only. If you should have access, ask whoever
              set up your workspace to add this address, then sign in again.
            </div>
          </div>
        )}

        <div className="flex justify-center">
          <SignIn
            routing="hash"
            forceRedirectUrl="/auth/clerk-bootstrap"
            signUpForceRedirectUrl="/auth/clerk-bootstrap"
          />
        </div>

        {/* No claim about payment mode here. This is a client component on an
            unauthenticated page, so it cannot read the server's resolved
            PAYMENTS_MODE — the old hardcoded "paper-money testing mode" line
            was simply wrong (a deployment may run stripe_test) and it was the
            first thing a visitor saw. Payment mode is stated where it is true and
            server-resolved: the approvals card and /settings. */}
        <p className="text-center text-xs text-muted-foreground">
          Invite-only access
        </p>
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
