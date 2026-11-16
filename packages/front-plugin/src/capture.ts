import type { CaptureAnswer, CaptureCreate, CaptureMessage, CaptureResult } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** One Front message or internal comment, already pulled out of the plugin SDK. */
export interface FrontMessage {
  id?: string;
  body: string;
  contentType: "html" | "text" | string;
  /** Front message status. Comments are internal notes and set `isComment`. */
  status: "inbound" | "outbound" | string;
  author?: string | null;
  /** ISO-8601, when Front gave us one. */
  at?: string | null;
  isComment: boolean;
}

/** What the plugin knows about the conversation. The thread is filled only after a draft exists. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  recipientHandle: string | null;
  recipientName: string | null;
  /** Oldest or newest; `contextFrom` sorts oldest first. */
  messages: FrontMessage[];
  /** Decision fields the admin named, by label. */
  fields: Record<string, unknown>;
  url: string | null;
  tags: string[];
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Block recording a changed reply until the teammate picks a reason. */
  requireReason: boolean;
  /** Also capture an internal comment, not only a sent reply. */
  captureInternalNotes: boolean;
  /** `fld_123:coverage, fld_9:reserve` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft. */
  minDraftChars: number;
  /** When set, only conversations carrying this tag are watched. */
  scopeTag: string | null;
  /** Which quick-pick reasons the teammate sees. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/**
 * https, plus loopback http for a local API. The plugin URL's query string cannot set this;
 * only settings.json on the host can, so a rewritten query cannot point the key at another site.
 */
export function safeBaseUrl(raw: string | null): string {
  if (!raw) return DEFAULT_SETTINGS.baseUrl;
  const trimmed = raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return DEFAULT_SETTINGS.baseUrl;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return trimmed;
  return DEFAULT_SETTINGS.baseUrl;
}

/** Parses plugin settings (query string, settings.json, or a manifest-shaped record). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: safeBaseUrl(str("overturn_base_url")),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** Query keys an admin may set on the plugin URL. The API base URL is not one of them. */
export const SETTINGS_QUERY_KEYS = [
  "agent",
  "reason_pack",
  "require_reason",
  "capture_internal_notes",
  "decision_fields",
  "scope_tag",
  "min_draft_chars",
] as const;

export function settingsFromQuery(search: string): Record<string, unknown> {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw: Record<string, unknown> = {};
  for (const key of SETTINGS_QUERY_KEYS) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  return raw;
}

/** The pasted key is stored with the API origin it was entered for, and is not sent anywhere else. */
export function encodeStoredApiKey(key: string, origin: string): string {
  return JSON.stringify({ key, origin });
}

export function decodeStoredApiKey(raw: string | null, origin: string): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("key" in parsed) || !("origin" in parsed))
      return null;
    if (typeof parsed.key !== "string" || typeof parsed.origin !== "string") return null;
    if (parsed.origin !== origin) return null;
    const key = parsed.key.trim();
    return key ? key : null;
  } catch {
    return null;
  }
}

/** With a scope tag, conversations without it are never read, not even the composer. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a paste),
 * not typed. The teammate can mark the current text by hand, and a drafting agent that
 * recorded its run is found by `fr:<conversation id>`.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const windowMs = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > windowMs);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function messageRole(m: FrontMessage): CaptureMessage["role"] {
  if (m.isComment) return "note";
  return m.status === "outbound" ? "agent" : "customer";
}

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  const mapped = conversation.messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => stripHtml(m.body).trim())
    .map(({ m, i }) => ({
      i,
      message: {
        role: messageRole(m),
        author: m.author ?? null,
        content: stripHtml(m.body),
        at: m.at ?? null,
      },
    }));
  mapped.sort((a, b) => {
    if (a.message.at && b.message.at && a.message.at !== b.message.at) {
      return a.message.at < b.message.at ? -1 : 1;
    }
    return a.i - b.i;
  });
  return mapped.map((row) => row.message);
}

/** The sent reply is the answer, not part of the thread the draft was answering. */
export function threadForCapture(
  messages: readonly FrontMessage[],
  sent: FrontMessage | null,
): FrontMessage[] {
  if (!sent) return [...messages];
  return messages.filter((m) => m !== sent && (!sent.id || m.id !== sent.id));
}

/** Front hands bodies back as HTML when the composer is in HTML mode. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** Values of the decision fields named in settings. Dates become ISO strings so the payload is JSON. */
export function decisionFieldsFrom(
  attributes: readonly { id: string; value: unknown }[],
  spec: readonly { id: string; label: string }[],
): Record<string, unknown> {
  if (spec.length === 0) return {};
  const byId = new Map(attributes.map((a) => [a.id, a.value]));
  return Object.fromEntries(
    spec.map((f) => {
      const value = byId.has(f.id) ? byId.get(f.id) : null;
      const resolved = value === undefined ? null : value;
      return [f.label, resolved instanceof Date ? resolved.toISOString() : resolved];
    }),
  );
}

function latest(messages: readonly FrontMessage[]): FrontMessage | null {
  let best: FrontMessage | null = null;
  for (const m of messages) {
    if (!best) {
      best = m;
      continue;
    }
    if (m.at && (!best.at || m.at > best.at)) best = m;
  }
  return best;
}

function isOutgoing(m: FrontMessage, includeComments: boolean): boolean {
  if (!stripHtml(m.body).trim()) return false;
  if (m.isComment) return includeComments;
  return m.status === "outbound";
}

/**
 * Which message is the reply that just left the composer.
 * `previousIds` is the thread as it was when the draft appeared (null when that read failed).
 * A brand-new outbound id wins. Otherwise the outbound whose text is the composer and whose
 * time is after the draft — Front sometimes keeps the id when a draft becomes a message.
 */
export function findSentMessage(input: {
  previousIds: ReadonlySet<string> | null;
  messages: readonly FrontMessage[];
  composerText: string;
  draftAtMs: number;
  includeComments: boolean;
}): FrontMessage | null {
  const outgoing = input.messages.filter((m) => isOutgoing(m, input.includeComments));
  const previousIds = input.previousIds;
  const fresh = previousIds === null ? [] : outgoing.filter((m) => !m.id || !previousIds.has(m.id));
  if (fresh.length > 0) return latest(fresh);
  const composer = normalizeCaptureText(stripHtml(input.composerText));
  const threshold = new Date(input.draftAtMs - 2000).toISOString();
  const matched = outgoing.filter((m) => {
    if (!m.at || m.at < threshold) return false;
    return normalizeCaptureText(stripHtml(m.body)) === composer;
  });
  return latest(matched);
}

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

export interface DecideOnSendInput {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the reply was sent; with the draft's `at`, how long it sat in front of the reviewer. */
  now?: number;
}

/** What to do when the teammate sends. Pure: the plugin glue only forwards the answer. */
export function decideOnSend(input: DecideOnSendInput): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [`draft:${draft.origin}`, send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata: { requester: conversation.recipientHandle ?? conversation.recipientName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

export function reasonBlockMessage(changedFields: readonly string[]): string {
  const what = changedFields.length > 0 ? changedFields.join(", ") : "reply";
  return `Overturn: pick why you changed the ${what} in the Overturn panel (one click).`;
}

export function captureFailureNotice(error: unknown): string {
  let status = "network";
  if (typeof error === "object" && error !== null && "status" in error) {
    const value = error.status;
    if (typeof value === "number" || typeof value === "string") status = String(value);
  }
  return `Overturn could not save this correction (${status}).`;
}

export type SendOutcome =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "blocked"; message: string; changedFields: string[] }
  | { action: "captured"; result: CaptureResult; changed: boolean }
  | { action: "capture-failed"; notice: string };

/**
 * Run the send decision. A missing reason blocks. A failed POST is logged and does not throw,
 * so the teammate's send is never stuck on Overturn.
 */
export async function onSend(
  input: DecideOnSendInput,
  post: (body: CaptureCreate) => Promise<CaptureResult>,
  log: (message: string) => void = (message) => {
    console.error(message);
  },
): Promise<SendOutcome> {
  const decision = decideOnSend(input);
  if (decision.action === "skip") return { action: "skip", why: decision.why };
  if (decision.action === "need-reason") {
    return {
      action: "blocked",
      changedFields: decision.changedFields,
      message: reasonBlockMessage(decision.changedFields),
    };
  }
  try {
    const result = await post(decision.body);
    return { action: "captured", result, changed: decision.changed };
  } catch (error) {
    const notice = captureFailureNotice(error);
    log(notice);
    return { action: "capture-failed", notice };
  }
}

/** Short status line for the sidebar. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = stripHtml(d.text).split(/\s+/).filter(Boolean).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the teammate clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
