"use client";

const backofficeSessionChannel = "set-livre-backoffice-session-v1";
const backofficeSessionEvent = "set-livre:backoffice-session-changed";
let peerSessionChannel: BroadcastChannel | undefined;
const activityListeners = new Set<() => void>();

export function notifyBackofficeActivityCompleted() {
  for (const listener of activityListeners) listener();
}

export function subscribeToBackofficeActivity(listener: () => void) {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

function getPeerSessionChannel() {
  if (typeof BroadcastChannel === "undefined") return undefined;
  peerSessionChannel ??= new BroadcastChannel(backofficeSessionChannel);
  return peerSessionChannel;
}

export function notifyBackofficePeerSessionsChanged() {
  getPeerSessionChannel()?.postMessage("changed");
}

export function notifyBackofficeSessionChanged() {
  window.dispatchEvent(new Event(backofficeSessionEvent));
  notifyBackofficePeerSessionsChanged();
}

export function subscribeToBackofficeSessionChanges(listener: () => void) {
  const handleLocalChange = () => listener();
  window.addEventListener(backofficeSessionEvent, handleLocalChange);
  const channel = getPeerSessionChannel();
  if (channel === undefined) {
    return () => window.removeEventListener(backofficeSessionEvent, handleLocalChange);
  }

  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    window.removeEventListener(backofficeSessionEvent, handleLocalChange);
  };
}
