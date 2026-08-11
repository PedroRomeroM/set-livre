"use client";

import { IdentityRouteError } from "@/domains/identity/components/route-state";

export default function LoginError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <IdentityRouteError reset={reset} />;
}
