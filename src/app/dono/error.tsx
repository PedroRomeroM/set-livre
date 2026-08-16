"use client";

import { OwnerRouteError } from "@/domains/owners/components/owner-route-state";

export default function OwnerError({
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  return <OwnerRouteError reset={reset} />;
}
