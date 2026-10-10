import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfirmEmailLink } from "./confirm-email-link";

// The URL carries the emailed token until the screen strips it: no referrer
// ever leaves this page with it.
export const metadata: Metadata = { referrer: "no-referrer" };

export default function ConfirmPage() {
  return (
    <Suspense>
      <ConfirmEmailLink />
    </Suspense>
  );
}
