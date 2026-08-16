"use client";

import { OwnerRouteError } from "@/domains/owners/components/owner-route-state";

export default function NewStudioError({
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  return <OwnerRouteError reset={reset} />;
}
