"use client";

import { useSyncExternalStore } from "react";

function subscribeToHydration() {
  return () => undefined;
}

function readHydratedClientSnapshot() {
  return true;
}

function readHydratedServerSnapshot() {
  return false;
}

export function useBackofficeHydrated() {
  return useSyncExternalStore(
    subscribeToHydration,
    readHydratedClientSnapshot,
    readHydratedServerSnapshot,
  );
}
