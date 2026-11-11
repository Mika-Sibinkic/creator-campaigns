// Public landing for creators finishing (or bouncing out of) payout setup.
// Creators are not app users — this page must render without a session and
// say something warm and specific for each arrival path.

const MESSAGES: Record<string, { title: string; body: string }> = {
  default: {
    title: 'Payout setup complete',
    body: "You're all set. Your payment goes out automatically, and the promo pack lands in your inbox right after. Nothing else to do.",
  },
  'already-set-up': {
    title: "You're already set up",
    body: 'Your payout details are in and your payment is on its way. Keep an eye on your inbox for the promo pack.',
  },
  done: {
    title: 'This payout is already handled',
    body: 'Looks like this payment has already been set up or sent. If something seems off, just reply to the email that brought you here.',
  },
  invalid: {
    title: 'This link is not active',
    body: "This payout link isn't valid anymore. Reply to the email that brought you here and we'll send a fresh one.",
  },
  'try-later': {
    title: 'One moment',
    body: "We couldn't open payout setup just now. Give it a minute and click the link in your email again.",
  },
};

export default async function PayoutCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const msg = MESSAGES[status ?? 'default'] ?? MESSAGES.default;
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md rounded-lg border p-8 text-center">
        <h1 className="text-xl font-semibold">{msg.title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{msg.body}</p>
      </div>
    </main>
  );
}
