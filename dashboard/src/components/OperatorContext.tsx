"use client";

// Operator context — is the signed-in person operator staff, or the label?
//
// Drives whether developer surfaces render: the reply simulator, testing-mode
// switches, mock-data toggles, payment-mode chips, raw ids, scraper debug.
// Cosmetic only. The server gate is `requireOperator()` in src/lib/operator.ts
// and it runs whether or not the client bothered to hide the button.
//
// Defaults to false and stays false until /api/me answers, so a slow or failed
// request shows the label-facing UI rather than flashing operator chrome.

import { createContext, useContext, useEffect, useState } from "react";

export interface Me {
  email: string | null;
  firm_id: string;
  workspace_name: string | null;
  role: string;
  operator: boolean;
}

const MeContext = createContext<Me | null>(null);

export function OperatorProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        if (!cancelled && d) setMe(d);
      })
      .catch(() => {
        /* silent — absence of an answer means "not an operator" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The signed-in identity, or null until /api/me answers. */
export function useMe(): Me | null {
  return useContext(MeContext);
}

/** True only once /api/me has confirmed operator status. */
export function useIsOperator(): boolean {
  return useContext(MeContext)?.operator === true;
}

/**
 * Render children only for operators.
 *
 * Use for whole blocks; `useIsOperator()` for conditional props. Renders
 * nothing (not a placeholder) so the label's layout has no operator-shaped
 * hole in it.
 */
export function OperatorOnly({ children }: { children: React.ReactNode }) {
  return useIsOperator() ? <>{children}</> : null;
}
