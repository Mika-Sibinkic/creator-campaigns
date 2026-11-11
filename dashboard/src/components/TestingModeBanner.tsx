// src/components/TestingModeBanner.tsx
//
// Safety notice, shown to everyone — a label must never believe outreach went
// to creators when it was actually redirected. What differs is the detail:
// operators see the redirect address (it is our own inbox, and knowing which
// one is the whole point); the label sees only that delivery is paused, since
// the redirect target is the operator's test inbox and not their business.
//
// Rendered inside the AppShell content column (above the top bar), not at the
// root layout: at the root it sat underneath the fixed sidebar, which hid its
// first words. Pages without the AppShell (onboarding) render it themselves.
'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useIsOperator } from '@/components/OperatorContext';

interface Firm {
  testing_mode: boolean;
  test_recipient_email: string | null;
}

export function TestingModeBanner() {
  const [firm, setFirm] = useState<Firm | null>(null);
  const isOperator = useIsOperator();

  useEffect(() => {
    fetch('/api/firm')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setFirm(d))
      .catch(() => {});
  }, []);

  if (!firm || !firm.testing_mode) return null;

  return (
    <div className="flex items-center justify-between gap-4 border-b border-attention-border bg-attention px-4 py-1.5 text-xs text-attention-fg sm:px-6">
      {isOperator ? (
        <span>
          <strong className="font-semibold">Testing mode.</strong> Outreach goes to{' '}
          <code className="rounded bg-background/60 px-1 py-px">
            {firm.test_recipient_email ?? '(unset)'}
          </code>
          , not to real creators.
        </span>
      ) : (
        <span>
          <strong className="font-semibold">Preview mode.</strong> Messages are drafted and reviewed
          but not delivered to creators.
        </span>
      )}
      <Link href="/settings" className="shrink-0 font-medium underline underline-offset-2 hover:no-underline">
        Settings
      </Link>
    </div>
  );
}
