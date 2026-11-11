"use client";

// /settings/contract/builder: the guided contract builder. Same audience and
// gate as the contract card on Settings (any signed-in member of the firm;
// every API it calls is session-gated and scoped to session.firm_id).

import { AppShell } from "@/components/AppShell";
import { PAGE_GUTTER } from "@/components/page";
import { ContractBuilder } from "@/components/contract-builder/ContractBuilder";
import { cn } from "@/lib/utils";

export default function ContractBuilderPage() {
  return (
    <AppShell title="Contract builder" back={{ href: "/settings", label: "Settings" }} width="narrow">
      <div className={cn("mx-auto w-full max-w-3xl pb-16 pt-6", PAGE_GUTTER)}>
        <ContractBuilder />
      </div>
    </AppShell>
  );
}
