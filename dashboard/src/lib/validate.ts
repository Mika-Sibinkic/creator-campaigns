// src/lib/validate.ts
//
// SEC-2: tiny helper to read+validate a JSON body in route handlers.
//
// Returns either the parsed/typed value, or a NextResponse the caller can
// return directly (400 on bad JSON, 422 on schema failure with formatted
// issues).
//
// Usage:
//   import { readJson } from '@/lib/validate';
//   import { CreateCampaignBody } from '@/lib/zod-schemas';
//
//   export async function POST(req: NextRequest) {
//     const body = await readJson(req, CreateCampaignBody);
//     if (body instanceof NextResponse) return body;     // validation failed
//     // body is now typed + validated
//     ...
//   }
import { z } from 'zod';
import { NextResponse } from 'next/server';

export async function readJson<T>(
  req: Request,
  schema: z.ZodSchema<T>
): Promise<T | NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_failed', issues: z.treeifyError(parsed.error) },
      { status: 422 }
    );
  }
  return parsed.data;
}
