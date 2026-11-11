// src/app/api/csp-report/route.ts
//
// INF-11: receiver for `Content-Security-Policy-Report-Only` violations.
// Browsers POST a JSON report when something on the page violates the
// policy declared in middleware.ts. We log the first 2000 characters.
//
// Public and CSRF-exempt in middleware, since browsers post it with no
// session, so it is rate-limited like the other public routes.
import { NextRequest, NextResponse } from 'next/server';
import { tieredLimit, rateLimited } from '@/lib/rate-limit';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const limit = tieredLimit(req, 'public');
  if (!limit.ok) {
    const r = rateLimited(limit.resetAt);
    return NextResponse.json(r.body, r.init);
  }
  // Read text once: browsers send `application/csp-report` or JSON, both parseable.
  const text = await req.text().catch(() => '');
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    report = '<unparseable body>';
  }
  console.warn('[csp-report]', JSON.stringify(report).slice(0, 2000));
  return new NextResponse(null, { status: 204 });
}
