import type { BackofficeSession } from "@set-livre/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcileSuccessfulBackofficeReauthentication } from "../../apps/backoffice/src/domains/backoffice/components/access-role-actions";
import { backofficeQueryKeys } from "../../apps/backoffice/src/domains/backoffice/components/query-keys";
import {
  notifyBackofficePeerSessionsChanged,
  subscribeToBackofficeSessionChanges,
} from "../../apps/backoffice/src/domains/backoffice/components/session-events";

const currentSession = {
  authenticated: true,
  authorizationVersion: 4,
  email: "admin@example.test",
  expiresAt: "2026-09-04T20:00:00.000Z",
  runtimeUnlockExpiresAt: "2026-09-04T19:05:00.000Z",
  scope: "10000000-0000-4000-8000-000000000001",
  strongAuthenticationExpiresAt: "2026-09-04T18:00:00.000Z",
} satisfies BackofficeSession;

const reauthenticatedSession = {
  ...currentSession,
  expiresAt: "2026-09-04T20:30:00.000Z",
  runtimeUnlockExpiresAt: null,
  strongAuthenticationExpiresAt: "2026-09-04T19:10:00.000Z",
} satisfies BackofficeSession;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("backoffice access reauthentication session", () => {
  it("publishes the exact successful session before notifying peer tabs", () => {
    const queryClient = new QueryClient();
    const sessionKey = backofficeQueryKeys.session(currentSession.scope);
    const observedAtNotification: BackofficeSession[] = [];
    const notifyPeerSessionsChanged = vi.fn(() => {
      const observed = queryClient.getQueryData<BackofficeSession>(sessionKey);
      if (observed !== undefined) observedAtNotification.push(observed);
    });
    const recomposeSession = vi.fn();
    queryClient.setQueryData(sessionKey, currentSession);

    expect(
      reconcileSuccessfulBackofficeReauthentication({
        currentSession,
        nextSession: reauthenticatedSession,
        notifyPeerSessionsChanged,
        queryClient,
        recomposeSession,
      }),
    ).toBe("published");

    expect(queryClient.getQueryData(sessionKey)).toEqual(reauthenticatedSession);
    expect(queryClient.getQueryData(sessionKey)).not.toEqual(currentSession);
    expect(observedAtNotification).toEqual([reauthenticatedSession]);
    expect(notifyPeerSessionsChanged).toHaveBeenCalledOnce();
    expect(recomposeSession).not.toHaveBeenCalled();
  });

  it("broadcasts a successful reauthentication to peer tabs without notifying its own shell", () => {
    const channelNames: string[] = [];
    const dispatchEvent = vi.fn();
    const listener = vi.fn();
    const postMessage = vi.fn();
    const messageListeners = new Set<() => void>();
    class PeerChannel {
      constructor(name: string) {
        channelNames.push(name);
      }

      addEventListener(type: string, callback: () => void) {
        if (type === "message") messageListeners.add(callback);
      }

      postMessage(message: unknown) {
        postMessage(message);
      }

      removeEventListener(type: string, callback: () => void) {
        if (type === "message") messageListeners.delete(callback);
      }
    }
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, dispatchEvent, removeEventListener });
    vi.stubGlobal("BroadcastChannel", PeerChannel);

    const unsubscribe = subscribeToBackofficeSessionChanges(listener);
    notifyBackofficePeerSessionsChanged();

    expect(channelNames).toEqual(["set-livre-backoffice-session-v1"]);
    expect(postMessage).toHaveBeenCalledWith("changed");
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();

    for (const peerMessage of messageListeners) peerMessage();
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    expect(messageListeners).toHaveLength(0);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it.each([
    {
      cachedSession: undefined,
      label: "the current session key was removed",
      nextSession: reauthenticatedSession,
    },
    {
      cachedSession: { ...currentSession, authorizationVersion: 5 },
      label: "authorization changed while the request was in flight",
      nextSession: reauthenticatedSession,
    },
    {
      cachedSession: currentSession,
      label: "the response belongs to another scope",
      nextSession: {
        ...reauthenticatedSession,
        scope: "20000000-0000-4000-8000-000000000002",
      },
    },
    {
      cachedSession: currentSession,
      label: "the response carries another authorization version",
      nextSession: { ...reauthenticatedSession, authorizationVersion: 5 },
    },
  ] satisfies readonly {
    cachedSession: BackofficeSession | undefined;
    label: string;
    nextSession: Extract<BackofficeSession, { authenticated: true }>;
  }[])("recomposes without publishing when $label", ({ cachedSession, nextSession }) => {
    const queryClient = new QueryClient();
    const sessionKey = backofficeQueryKeys.session(currentSession.scope);
    const notifyPeerSessionsChanged = vi.fn();
    const recomposeSession = vi.fn();
    if (cachedSession !== undefined) queryClient.setQueryData(sessionKey, cachedSession);

    expect(
      reconcileSuccessfulBackofficeReauthentication({
        currentSession,
        nextSession,
        notifyPeerSessionsChanged,
        queryClient,
        recomposeSession,
      }),
    ).toBe("session-boundary");

    expect(queryClient.getQueryData(sessionKey)).toEqual(cachedSession);
    expect(notifyPeerSessionsChanged).not.toHaveBeenCalled();
    expect(recomposeSession).toHaveBeenCalledOnce();
  });
});
