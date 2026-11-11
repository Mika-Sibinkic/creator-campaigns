import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isPlatformOperator } from "@/lib/operator";
import { DesignSystemClient } from "./DesignSystemClient";


export default async function DesignSystemPage() {
  // Open on a dev build (it is a local design tool); operators only in
  // production. Was a second hardcoded copy of one personal address, which also
  // locked the operator out when signing in with another account — OPERATOR_EMAILS
  // is the one list now.
  if (process.env.NODE_ENV === "production") {
    const session = await getSession().catch(() => null);
    if (!isPlatformOperator(session?.user?.email)) {
      notFound();
    }
  }
  return <DesignSystemClient />;
}
