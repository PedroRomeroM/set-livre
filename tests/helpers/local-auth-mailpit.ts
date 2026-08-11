import { expect as playwrightExpect } from "@playwright/test";
import { z } from "zod";

export const LOCAL_MAILPIT_ORIGIN = "http://127.0.0.1:54324";

const LOCAL_AUTH_CALLBACK_ORIGIN = "http://127.0.0.1:3000";
const LOCAL_AUTH_CALLBACK_PATH = "/auth/callback";
const MAILPIT_RESPONSE_LIMIT_BYTES = 2_000_000;

const qaAuthEmailSchema = z
  .email()
  .max(254)
  .regex(/^qa_[a-z0-9][a-z0-9._+-]*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
  .refine((value) => value === value.trim() && value === value.toLowerCase());
const mailpitMessageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const mailpitMessageIdsSchema = z
  .array(mailpitMessageIdSchema)
  .min(1)
  .max(200)
  .refine((messageIds) => new Set(messageIds).size === messageIds.length);
const localAuthEmailTypeSchema = z.enum(["recovery", "signup"]);
const mailpitTimestampSchema = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const mailpitMailboxSchema = z.object({
  Address: z.string().max(254),
});
const mailpitMessageSummarySchema = z.object({
  Created: mailpitTimestampSchema,
  ID: mailpitMessageIdSchema,
  Subject: z.string().max(998),
  To: z.array(mailpitMailboxSchema).max(100),
});
const mailpitSearchSchema = z.object({
  messages: z.array(mailpitMessageSummarySchema).max(500),
});
const mailpitMessageSchema = z.object({
  HTML: z.string().max(MAILPIT_RESPONSE_LIMIT_BYTES),
  ID: mailpitMessageIdSchema,
  Subject: z.string().max(998),
  Text: z.string().max(MAILPIT_RESPONSE_LIMIT_BYTES),
  To: z.array(mailpitMailboxSchema).max(100),
});
const mailContentSchema = z.strictObject({
  html: z.string().max(MAILPIT_RESPONSE_LIMIT_BYTES),
  text: z.string().max(MAILPIT_RESPONSE_LIMIT_BYTES),
});

export type LocalAuthEmailType = z.infer<typeof localAuthEmailTypeSchema>;
export type MailpitFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export type LocalAuthEmail = {
  callbackUrl: string;
  messageId: string;
  subject: string;
};

export type FindLocalAuthEmailInput = {
  emailType: LocalAuthEmailType;
  notBefore: Date;
  recipientEmail: string;
};

type WaitForLocalAuthEmailInput = FindLocalAuthEmailInput & {
  timeoutMs?: number;
};

const defaultMailpitFetch: MailpitFetch = (input, init) => fetch(input, init);

function contractError() {
  return new Error("A resposta do Mailpit local não atende ao contrato esperado.");
}

export function assertQaAuthEmail(value: string) {
  const parsed = qaAuthEmailSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("O e-mail de Auth local precisa usar um namespace QA exato e minúsculo.");
  }
  return parsed.data;
}

function assertEmailQuery(input: FindLocalAuthEmailInput) {
  const recipientEmail = assertQaAuthEmail(input.recipientEmail);
  const emailType = localAuthEmailTypeSchema.safeParse(input.emailType);
  const notBeforeEpoch = input.notBefore.getTime();

  if (!emailType.success || !Number.isFinite(notBeforeEpoch)) {
    throw new Error("A consulta de e-mail Auth local é inválida.");
  }

  return {
    emailType: emailType.data,
    notBeforeEpoch,
    recipientEmail,
  };
}

function assertResponseSize(response: Response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) {
    return;
  }

  if (!/^\d{1,10}$/u.test(contentLength)) {
    throw contractError();
  }

  const parsedLength = Number(contentLength);
  if (!Number.isSafeInteger(parsedLength) || parsedLength > MAILPIT_RESPONSE_LIMIT_BYTES) {
    throw contractError();
  }
}

async function requestMailpitJson<T>(url: URL, schema: z.ZodType<T>, fetchImpl: MailpitFetch) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new Error("Não foi possível consultar o Mailpit local.");
  }

  if (!response.ok) {
    throw new Error("O Mailpit local recusou uma consulta segura.");
  }

  assertResponseSize(response);

  let source: string;
  try {
    source = await response.text();
  } catch {
    throw contractError();
  }
  if (source.length > MAILPIT_RESPONSE_LIMIT_BYTES) {
    throw contractError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(source);
  } catch {
    throw contractError();
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw contractError();
  }
  return parsed.data;
}

function decodeHtmlAttribute(value: string) {
  return value.replace(
    /&(#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|amp|apos|quot);/giu,
    (entity, encoded: string) => {
      const normalized = encoded.toLowerCase();
      if (normalized === "amp") {
        return "&";
      }
      if (normalized === "apos") {
        return "'";
      }
      if (normalized === "quot") {
        return '"';
      }

      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint < 32 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function callbackCandidate(value: string, emailType: LocalAuthEmailType) {
  const decoded = decodeHtmlAttribute(value).replace(/[),.;]+$/u, "");
  if (!decoded.startsWith(`${LOCAL_AUTH_CALLBACK_ORIGIN}${LOCAL_AUTH_CALLBACK_PATH}`)) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return undefined;
  }

  if (
    parsed.origin !== LOCAL_AUTH_CALLBACK_ORIGIN ||
    parsed.pathname !== LOCAL_AUTH_CALLBACK_PATH ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    !parsed.hash.startsWith("#")
  ) {
    return undefined;
  }

  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const fragmentKeys = [...fragment.keys()];
  const tokenHash = fragment.get("token_hash");
  if (
    fragmentKeys.length !== 2 ||
    !fragmentKeys.every((key) => key === "token_hash" || key === "type") ||
    fragment.getAll("token_hash").length !== 1 ||
    fragment.getAll("type").length !== 1 ||
    tokenHash === null ||
    tokenHash.length < 20 ||
    tokenHash.length > 512 ||
    fragment.get("type") !== emailType
  ) {
    return undefined;
  }

  return parsed.toString();
}

function mailLinkCandidates(html: string, text: string) {
  const candidates: string[] = [];
  for (const match of html.matchAll(
    /\bhref\s*=\s*(?:"([^"\r\n]{1,4096})"|'([^'\r\n]{1,4096})')/giu,
  )) {
    const value = match[1] ?? match[2];
    if (value !== undefined) {
      candidates.push(value);
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']{1,4096}/giu)) {
    const value = match[0];
    if (value !== "") {
      candidates.push(value);
    }
  }
  return candidates;
}

export function extractLocalAuthCallbackLink(
  content: { html: string; text: string },
  emailType: LocalAuthEmailType,
) {
  const parsedContent = mailContentSchema.safeParse(content);
  const parsedType = localAuthEmailTypeSchema.safeParse(emailType);
  if (!parsedContent.success || !parsedType.success) {
    throw new Error("Não foi possível interpretar o callback do e-mail Auth local.");
  }

  const callbacks = new Set<string>();
  for (const candidate of mailLinkCandidates(parsedContent.data.html, parsedContent.data.text)) {
    const callback = callbackCandidate(candidate, parsedType.data);
    if (callback !== undefined) {
      callbacks.add(callback);
    }
  }

  if (callbacks.size !== 1) {
    throw new Error("O e-mail Auth local não contém um único callback permitido.");
  }
  const callback = callbacks.values().next().value;
  if (callback === undefined) {
    throw new Error("O e-mail Auth local não contém um callback permitido.");
  }
  return callback;
}

function mailpitSearchUrl(recipientEmail: string) {
  const url = new URL("/api/v1/search", LOCAL_MAILPIT_ORIGIN);
  url.searchParams.set("limit", "200");
  url.searchParams.set("query", `to:${recipientEmail}`);
  return url;
}

function mailpitMessageUrl(messageId: string) {
  return new URL(`/api/v1/message/${encodeURIComponent(messageId)}`, LOCAL_MAILPIT_ORIGIN);
}

async function deleteLocalAuthMessageIds(messageIds: readonly string[], fetchImpl: MailpitFetch) {
  const parsedMessageIds = mailpitMessageIdsSchema.safeParse(messageIds);
  if (!parsedMessageIds.success) {
    throw new Error("Os identificadores dos e-mails Auth locais são inválidos.");
  }

  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/v1/messages", LOCAL_MAILPIT_ORIGIN), {
      body: JSON.stringify({ IDs: parsedMessageIds.data }),
      headers: {
        accept: "text/plain",
        "content-type": "application/json",
      },
      method: "DELETE",
    });
  } catch {
    throw new Error("Não foi possível remover os e-mails Auth locais exatos.");
  }
  if (!response.ok) {
    throw new Error("O Mailpit recusou a remoção dos e-mails Auth locais exatos.");
  }
}

export async function findLocalAuthEmailOnce(
  input: FindLocalAuthEmailInput,
  fetchImpl: MailpitFetch = defaultMailpitFetch,
): Promise<LocalAuthEmail | undefined> {
  const query = assertEmailQuery(input);
  const search = await requestMailpitJson(
    mailpitSearchUrl(query.recipientEmail),
    mailpitSearchSchema,
    fetchImpl,
  );
  const summaries = search.messages
    .filter(
      (message) =>
        Date.parse(message.Created) >= query.notBeforeEpoch &&
        message.To.some((mailbox) => mailbox.Address === query.recipientEmail),
    )
    .sort((left, right) => Date.parse(right.Created) - Date.parse(left.Created));

  let foundExactMessageWithoutCallback = false;
  for (const summary of summaries) {
    const message = await requestMailpitJson(
      mailpitMessageUrl(summary.ID),
      mailpitMessageSchema,
      fetchImpl,
    );
    if (
      message.ID !== summary.ID ||
      !message.To.some((mailbox) => mailbox.Address === query.recipientEmail)
    ) {
      throw contractError();
    }

    try {
      return {
        callbackUrl: extractLocalAuthCallbackLink(
          { html: message.HTML, text: message.Text },
          query.emailType,
        ),
        messageId: message.ID,
        subject: message.Subject,
      };
    } catch {
      foundExactMessageWithoutCallback = true;
    }
  }

  if (foundExactMessageWithoutCallback) {
    throw new Error("O e-mail Auth local exato não contém o callback esperado.");
  }
  return undefined;
}

export async function waitForLocalAuthEmail(
  input: WaitForLocalAuthEmailInput,
  fetchImpl: MailpitFetch = defaultMailpitFetch,
) {
  const query = assertEmailQuery(input);
  const timeoutMs = input.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("O timeout da espera pelo e-mail Auth local é inválido.");
  }

  let found: LocalAuthEmail | undefined;
  await playwrightExpect
    .poll(
      async () => {
        found = await findLocalAuthEmailOnce(
          {
            emailType: query.emailType,
            notBefore: new Date(query.notBeforeEpoch),
            recipientEmail: query.recipientEmail,
          },
          fetchImpl,
        );
        return found !== undefined;
      },
      {
        intervals: [100, 250, 500],
        message: "O e-mail Auth local exato deve chegar ao Mailpit.",
        timeout: timeoutMs,
      },
    )
    .toBe(true);

  if (found === undefined) {
    throw new Error("O Mailpit local não retornou o e-mail Auth esperado.");
  }
  return found;
}

export async function deleteExactLocalAuthEmail(
  input: { messageId: string; recipientEmail: string },
  fetchImpl: MailpitFetch = defaultMailpitFetch,
) {
  const recipientEmail = assertQaAuthEmail(input.recipientEmail);
  const messageId = mailpitMessageIdSchema.safeParse(input.messageId);
  if (!messageId.success) {
    throw new Error("O identificador do e-mail Auth local é inválido.");
  }

  const message = await requestMailpitJson(
    mailpitMessageUrl(messageId.data),
    mailpitMessageSchema,
    fetchImpl,
  );
  if (
    message.ID !== messageId.data ||
    !message.To.some((mailbox) => mailbox.Address === recipientEmail)
  ) {
    throw new Error("O e-mail Auth local não corresponde ao destinatário exato.");
  }

  await deleteLocalAuthMessageIds([messageId.data], fetchImpl);
}

export async function deleteAllExactLocalAuthEmails(
  input: { recipientEmail: string },
  fetchImpl: MailpitFetch = defaultMailpitFetch,
) {
  const recipientEmail = assertQaAuthEmail(input.recipientEmail);
  const search = await requestMailpitJson(
    mailpitSearchUrl(recipientEmail),
    mailpitSearchSchema,
    fetchImpl,
  );
  const summaries = search.messages.filter((message) =>
    message.To.some((mailbox) => mailbox.Address === recipientEmail),
  );
  const summaryIds = summaries.map((summary) => summary.ID);
  if (new Set(summaryIds).size !== summaryIds.length) {
    throw contractError();
  }

  const verifiedMessageIds: string[] = [];
  for (const summary of summaries) {
    const message = await requestMailpitJson(
      mailpitMessageUrl(summary.ID),
      mailpitMessageSchema,
      fetchImpl,
    );
    if (
      message.ID !== summary.ID ||
      !message.To.some((mailbox) => mailbox.Address === recipientEmail)
    ) {
      throw new Error("O e-mail Auth local não corresponde ao destinatário exato.");
    }
    verifiedMessageIds.push(message.ID);
  }

  if (verifiedMessageIds.length === 0) {
    return 0;
  }
  await deleteLocalAuthMessageIds(verifiedMessageIds, fetchImpl);
  return verifiedMessageIds.length;
}
