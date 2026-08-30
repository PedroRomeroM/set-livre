"use client";

const backofficeSessionChannel = "set-livre-backoffice-session-v1";
const backofficeSessionEvent = "set-livre:backoffice-session-changed";

export function notifyBackofficeSessionChanged() {
  window.dispatchEvent(new Event(backofficeSessionEvent));
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(backofficeSessionChannel);
  channel.postMessage("changed");
  channel.close();
}

export function subscribeToBackofficeSessionChanges(listener: () => void) {
  const handleLocalChange = () => listener();
  window.addEventListener(backofficeSessionEvent, handleLocalChange);
  if (typeof BroadcastChannel === "undefined") {
    return () => window.removeEventListener(backofficeSessionEvent, handleLocalChange);
  }

  const channel = new BroadcastChannel(backofficeSessionChannel);
  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    channel.close();
    window.removeEventListener(backofficeSessionEvent, handleLocalChange);
  };
}
