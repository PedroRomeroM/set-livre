import { describe, expect, it, vi } from "vitest";

import {
  captureLocalAuthEmailFence,
  deleteAllExactLocalAuthEmails,
  deleteExactLocalAuthEmail,
  extractLocalAuthCallbackLink,
  findLocalAuthEmailOnce,
  LOCAL_MAILPIT_ORIGIN,
  type MailpitFetch,
  waitForLocalAuthEmail,
} from "../helpers/local-auth-mailpit";

const recipientEmail = "qa_worker_auth_signup@set-livre.local";
const callbackToken = "unit-callback-token-that-must-stay-redacted";
const signupCallback = `http://127.0.0.1:3000/auth/callback#token_hash=${callbackToken}&type=signup`;
const createdAt = "2026-08-11T08:30:00Z";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function messageSummary(
  overrides: Partial<{
    Created: string;
    ID: string;
    Subject: string;
    To: { Address: string }[];
  }> = {},
) {
  return {
    Created: createdAt,
    ID: "mailpit-message-001",
    Subject: "Confirme seu e-mail",
    To: [{ Address: recipientEmail }],
    ...overrides,
  };
}

function messageDetail(
  overrides: Partial<{
    HTML: string;
    ID: string;
    Subject: string;
    Text: string;
    To: { Address: string }[];
  }> = {},
) {
  return {
    HTML: `<a href="${signupCallback.replaceAll("&", "&amp;")}">Confirmar</a>`,
    ID: "mailpit-message-001",
    Subject: "Confirme seu e-mail",
    Text: signupCallback,
    To: [{ Address: recipientEmail }],
    ...overrides,
  };
}

function capturedError(action: () => unknown) {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw new Error("O teste recebeu uma falha que não é Error.");
  }
  throw new Error("O teste esperava uma falha.");
}

async function capturedAsyncError(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw new Error("O teste recebeu uma falha assíncrona que não é Error.");
  }
  throw new Error("O teste esperava uma falha assíncrona.");
}

describe("local Auth Mailpit helper", () => {
  it("extracts one entity-encoded callback without changing its token", () => {
    expect(
      extractLocalAuthCallbackLink(
        {
          html: `<a href="${signupCallback.replaceAll("&", "&#38;")}">Confirmar</a>`,
          text: signupCallback,
        },
        "signup",
      ),
    ).toBe(signupCallback);
  });

  it.each([
    `https://127.0.0.1:3000/auth/callback#token_hash=${callbackToken}&type=signup`,
    `http://localhost:3000/auth/callback#token_hash=${callbackToken}&type=signup`,
    `http://127.1:3000/auth/callback#token_hash=${callbackToken}&type=signup`,
    `http://2130706433:3000/auth/callback#token_hash=${callbackToken}&type=signup`,
    `http://0x7f000001:3000/auth/callback#token_hash=${callbackToken}&type=signup`,
    `http://operator@127.0.0.1:3000/auth/callback#token_hash=${callbackToken}&type=signup`,
    `http://127.0.0.1:3001/auth/callback#token_hash=${callbackToken}&type=signup`,
    `http://127.0.0.1:3000/auth/callback/extra#token_hash=${callbackToken}&type=signup`,
    `http://127.0.0.1:3000/auth/callback#token_hash=${callbackToken}&type=recovery`,
    `http://127.0.0.1:3000/auth/callback?token_hash=${callbackToken}&type=signup`,
    `http://127.0.0.1:3000/auth/callback#token_hash=${callbackToken}&type=signup&returnTo=%2F`,
    `http://127.0.0.1:3000/auth/callback#token_hash=${callbackToken}&token_hash=duplicate&type=signup`,
  ])("rejects a callback outside the exact local contract without exposing it", (candidate) => {
    const message = capturedError(() =>
      extractLocalAuthCallbackLink(
        { html: `<a href="${candidate}">Abrir</a>`, text: "" },
        "signup",
      ),
    );

    expect(message).toBe("O e-mail Auth local não contém um único callback permitido.");
    expect(message).not.toContain(callbackToken);
    expect(message).not.toContain(candidate);
  });

  it("rejects ambiguity without exposing either callback", () => {
    const secondToken = "second-token-that-must-stay-redacted";
    const secondCallback = `http://127.0.0.1:3000/auth/callback#token_hash=${secondToken}&type=signup`;
    const message = capturedError(() =>
      extractLocalAuthCallbackLink(
        {
          html: `<a href="${signupCallback}">Um</a><a href="${secondCallback}">Dois</a>`,
          text: "",
        },
        "signup",
      ),
    );

    expect(message).not.toContain(callbackToken);
    expect(message).not.toContain(secondToken);
  });

  it("captures only existing message IDs for the exact recipient", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        messages: [
          messageSummary({
            ID: "wrong-recipient",
            To: [{ Address: "qa_worker_other@set-livre.local" }],
          }),
          messageSummary({ ID: "existing-message" }),
        ],
      }),
    );

    await expect(captureLocalAuthEmailFence({ recipientEmail }, fetchMock)).resolves.toEqual({
      existingMessageIds: ["existing-message"],
      recipientEmail,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses an exact recipient and an ID fence without comparing independent clocks", async () => {
    const fetchMock = vi.fn(async (input: URL) => {
      if (input.pathname === "/api/v1/search") {
        return jsonResponse({
          messages: [
            messageSummary({
              ID: "wrong-recipient",
              To: [{ Address: "qa_worker_other@set-livre.local" }],
            }),
            messageSummary({ ID: "existing-message" }),
            messageSummary({
              Created: "2026-08-11T07:00:00Z",
              ID: "new-message-from-container-clock",
            }),
          ],
        });
      }
      return jsonResponse(messageDetail({ ID: "new-message-from-container-clock" }));
    });
    const fetchImpl: MailpitFetch = fetchMock;

    await expect(
      findLocalAuthEmailOnce(
        {
          emailType: "signup",
          fence: { existingMessageIds: ["existing-message"], recipientEmail },
        },
        fetchImpl,
      ),
    ).resolves.toEqual({
      callbackUrl: signupCallback,
      messageId: "new-message-from-container-clock",
      subject: "Confirme seu e-mail",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const searchUrl = fetchMock.mock.calls[0]?.[0];
    expect(searchUrl?.origin).toBe(LOCAL_MAILPIT_ORIGIN);
    expect(searchUrl?.pathname).toBe("/api/v1/search");
    expect(searchUrl?.searchParams.get("query")).toBe(`to:${recipientEmail}`);
    expect(fetchMock.mock.calls[1]?.[0].pathname).toBe(
      "/api/v1/message/new-message-from-container-clock",
    );
  });

  it("polls until the exact message exists without putting the callback in the assertion value", async () => {
    let searches = 0;
    const fetchMock = vi.fn(async (input: URL) => {
      if (input.pathname === "/api/v1/search") {
        searches += 1;
        return jsonResponse({ messages: searches === 1 ? [] : [messageSummary()] });
      }
      return jsonResponse(messageDetail());
    });

    await expect(
      waitForLocalAuthEmail(
        {
          emailType: "signup",
          fence: { existingMessageIds: [], recipientEmail },
          timeoutMs: 1_000,
        },
        fetchMock,
      ),
    ).resolves.toMatchObject({ messageId: "mailpit-message-001" });
    expect(searches).toBe(2);
  });

  it("deletes only the confirmed message ID for the exact recipient", async () => {
    const fetchMock = vi.fn(async (input: URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response("ok", { status: 200 });
      }
      return jsonResponse(messageDetail());
    });

    await deleteExactLocalAuthEmail(
      { messageId: "mailpit-message-001", recipientEmail },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const deletion = fetchMock.mock.calls[1];
    expect(deletion?.[0].origin).toBe(LOCAL_MAILPIT_ORIGIN);
    expect(deletion?.[0].pathname).toBe("/api/v1/messages");
    expect(deletion?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({ IDs: ["mailpit-message-001"] });
  });

  it("never deletes when the message recipient is not the exact QA email", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(messageDetail({ To: [{ Address: "qa_worker_other@set-livre.local" }] })),
    );

    await expect(
      deleteExactLocalAuthEmail({ messageId: "mailpit-message-001", recipientEmail }, fetchMock),
    ).rejects.toThrow("não corresponde ao destinatário exato");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an empty exact mailbox cleanup as idempotent", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ messages: [] }));

    await expect(deleteAllExactLocalAuthEmails({ recipientEmail }, fetchMock)).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reopens and removes every message for the exact QA recipient", async () => {
    const firstMessageId = "mailpit-message-cleanup-001";
    const secondMessageId = "mailpit-message-cleanup-002";
    const fetchMock = vi.fn(async (input: URL, init?: RequestInit) => {
      if (input.pathname === "/api/v1/search") {
        return jsonResponse({
          messages: [
            messageSummary({ ID: firstMessageId }),
            messageSummary({ ID: secondMessageId }),
            messageSummary({
              ID: "different-recipient",
              To: [{ Address: "qa_worker_other@set-livre.local" }],
            }),
          ],
        });
      }
      if (init?.method === "DELETE") {
        return new Response("ok", { status: 200 });
      }
      const messageId = input.pathname.endsWith(firstMessageId) ? firstMessageId : secondMessageId;
      return jsonResponse(messageDetail({ ID: messageId }));
    });

    await expect(deleteAllExactLocalAuthEmails({ recipientEmail }, fetchMock)).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const deletion = fetchMock.mock.calls[3];
    expect(deletion?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(deletion?.[1]?.body))).toEqual({
      IDs: [firstMessageId, secondMessageId],
    });
  });

  it("never removes a message whose reopened recipient diverges", async () => {
    const fetchMock = vi.fn(async (input: URL, init?: RequestInit) => {
      if (input.pathname === "/api/v1/search") {
        return jsonResponse({ messages: [messageSummary()] });
      }
      if (init?.method === "DELETE") {
        throw new Error("delete-must-not-run");
      }
      return jsonResponse(messageDetail({ To: [{ Address: "qa_worker_other@set-livre.local" }] }));
    });

    await expect(deleteAllExactLocalAuthEmails({ recipientEmail }, fetchMock)).rejects.toThrow(
      "destinatário exato",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts provider failures during residual mailbox cleanup", async () => {
    const providerSecret = "residual-mailpit-provider-secret";
    const fetchMock = vi.fn(async (input: URL) => {
      if (input.pathname === "/api/v1/search") {
        return jsonResponse({ messages: [messageSummary()] });
      }
      return new Response(providerSecret, { status: 500 });
    });

    const message = await capturedAsyncError(() =>
      deleteAllExactLocalAuthEmails({ recipientEmail }, fetchMock),
    );
    expect(message).not.toContain(providerSecret);
    expect(message).not.toContain(recipientEmail);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces invalid provider payloads and HTTP bodies with redacted errors", async () => {
    const providerSecret = "provider-body-secret-that-must-stay-redacted";
    const invalidPayloadFetch: MailpitFetch = async () =>
      jsonResponse({ messages: providerSecret });
    const refusedFetch: MailpitFetch = async () => new Response(providerSecret, { status: 500 });
    const input = {
      emailType: "signup" as const,
      fence: { existingMessageIds: [], recipientEmail },
    };

    const invalidPayloadMessage = await capturedAsyncError(() =>
      findLocalAuthEmailOnce(input, invalidPayloadFetch),
    );
    const refusedMessage = await capturedAsyncError(() =>
      findLocalAuthEmailOnce(input, refusedFetch),
    );

    expect(invalidPayloadMessage).not.toContain(providerSecret);
    expect(refusedMessage).not.toContain(providerSecret);
    expect(invalidPayloadMessage).not.toContain(callbackToken);
    expect(refusedMessage).not.toContain(callbackToken);
  });
});
