// tools/_e2e-live-env.ts
//
// MUST be the FIRST import in tools/e2e-negotiation-live.ts. Loads the REAL
// .env.local (so supabase.ts constructs a live service-role client at
// module-load) and forces the deterministic mock model provider + paper-money
// mode. Unlike tests/negotiation-harness/setup-env.ts this reaches the LIVE DB
// on purpose — it is an end-to-end check, not a hermetic unit test — but it
// keeps the LLM + payout OFF the network so total external spend stays $0.

import { config } from 'dotenv';

config({ path: '.env.local' });

// Deterministic negotiator (registered in the harness) + paper payouts.
process.env.MODEL_PROVIDER = 'mock';
if (!process.env.PAYMENTS_MODE) process.env.PAYMENTS_MODE = 'paper';
