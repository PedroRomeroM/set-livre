"use client";

import { IdentityRouteError } from "@/domains/identity/components/route-state";

export default function RegistrationError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <IdentityRouteError reset={reset} />;
}
