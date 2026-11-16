import type {
  ApplicationComment,
  ApplicationMessage,
  ApplicationPaginationToken,
  MessageComposerContext,
  SingleConversationContext,
} from "@frontapp/plugin-sdk";
import { contextUpdates } from "@frontapp/plugin-sdk";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  DEFAULT_SETTINGS,
  type DecideOnSendInput,
  type DraftDetector,
  decideOnSend,
  decisionFieldsFrom,
  type FrontMessage,
  findSentMessage,
  inScope,
  onSend,
  quickReasons,
  settingsFrom,
  statusLine,
  threadForCapture,
} from "./capture";

const KEY_STORAGE = "overturn.front.apiKey";
const QUERY_KEYS = [
  "overturn_base_url",
  "agent",
  "reason_pack",
  "require_reason",
  "capture_internal_notes",
  "decision_fields",
  "scope_tag",
  "min_draft_chars",
] as const;

class CaptureHttpError extends Error {
  readonly status: number | string;
  constructor(status: number | string) {
    super(`capture ${status}`);
    this.status = status;
  }
}

interface Live {
  conversationId: string | null;
  subject: string | null;
  recipientHandle: string | null;
  recipientName: string | null;
  tags: string[];
  attributes: Array<{ id: string; value: unknown }>;
  teammateEmail: string | null;
  draftId: string | null;
  composerBody: string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date =
    value instanceof Date
      ? value
      : new Date(typeof value === "string" || typeof value === "number" ? value : Number.NaN);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isSingle(ctx: { type: string }): ctx is SingleConversationContext {
  return ctx.type === "singleConversation";
}

function isComposer(ctx: { type: string }): ctx is MessageComposerContext {
  return ctx.type === "messageComposer";
}

async function drain<T, Token>(
  load: (token?: Token) => Promise<{ results: readonly T[]; nextPageToken?: Token }>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let token: Token | undefined;
  for (let page = 0; page < 20; page++) {
    const next = await load(token);
    all.push(...next.results);
    if (next.nextPageToken === undefined) return all;
    const key = String(next.nextPageToken);
    if (seen.has(key)) return all;
    seen.add(key);
    token = next.nextPageToken;
  }
  return all;
}

function fromMessage(message: ApplicationMessage): FrontMessage {
  return {
    id: message.id,
    body: message.content?.body ?? "",
    contentType: message.content?.type ?? "text",
    status: message.status,
    author: message.from.handle || message.from.name || null,
    at: iso(message.date),
    isComment: false,
  };
}

function fromComment(comment: ApplicationComment): FrontMessage {
  return {
    id: comment.id,
    body: comment.content.body,
    contentType: "text",
    status: "outbound",
    author: comment.author.email || comment.author.name || null,
    at: iso(comment.createdAt),
    isComment: true,
  };
}

function recordedFrom(json: unknown): { id: string; output: string } | null {
  if (typeof json !== "object" || json === null || !("items" in json)) return null;
  const { items } = json;
  if (!Array.isArray(items) || items.length === 0) return null;
  const first: unknown = items[0];
  if (typeof first !== "object" || first === null || !("id" in first) || !("output" in first)) return null;
  if (typeof first.id !== "string" || typeof first.output !== "string" || !first.output.trim()) return null;
  return { id: first.id, output: first.output };
}

function isCaptureResult(value: unknown): value is CaptureResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const kindOk = kind === "approve" || kind === "edit" || kind === "reject" || kind === "escalate";
  return kindOk && typeof record.changed === "boolean" && typeof record.deduplicated === "boolean";
}

function querySettings(): Record<string, unknown> {
  const params = new URLSearchParams(location.search);
  const raw: Record<string, unknown> = {};
  for (const key of QUERY_KEYS) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  return raw;
}

let fileKey: string | null = null;

async function fileSettings(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(new URL("settings.json", location.href));
    if (!res.ok) return {};
    const json: unknown = await res.json();
    if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
    const record: Record<string, unknown> = { ...json };
    const key = record.overturn_api_key;
    if (typeof key === "string" && key.trim()) fileKey = key.trim();
    delete record.overturn_api_key;
    return record;
  } catch {
    return {};
  }
}

function storedKey(): string | null {
  try {
    const value = localStorage.getItem(KEY_STORAGE);
    return value?.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function currentKey(): string | null {
  return storedKey() ?? fileKey;
}

let settings: AppSettings = DEFAULT_SETTINGS;
let detector: DraftDetector = createDraftDetector({ minDraftChars: DEFAULT_SETTINGS.minDraftChars });
let latestCtx: { type: string } | null = null;
let latest: Live | null = null;
let currentId: string | null = null;
let seenDraftId: string | null = null;
let knownIds: Set<string> | null = null;
let snapshotFor: string | null = null;
let recordedFor: string | null = null;
let fieldsFrozen = false;
let draftFields: Record<string, unknown> = {};
let lastBody = "";
let reasonCode: string | null = null;
let pending: DecideOnSendInput | null = null;
let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
let pollTimer: number | null = null;

function stopPoll(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function resetConversation(id: string): void {
  currentId = id;
  seenDraftId = null;
  knownIds = null;
  snapshotFor = null;
  recordedFor = null;
  fieldsFrozen = false;
  draftFields = {};
  lastBody = "";
  lastResult = null;
  detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  stopPoll();
}

function toLive(ctx: SingleConversationContext | MessageComposerContext): Live {
  if (ctx.type === "singleConversation") {
    const conversation = ctx.conversation;
    return {
      conversationId: conversation.id,
      subject: conversation.subject ?? null,
      recipientHandle: conversation.recipient?.handle ?? null,
      recipientName: conversation.recipient?.name ?? null,
      tags: conversation.tags.map((tag) => tag.name),
      attributes: conversation.customFieldAttributes.map((attribute) => ({
        id: attribute.id,
        value: attribute.value,
      })),
      teammateEmail: ctx.teammate.email,
      draftId: conversation.draftId ?? null,
      composerBody: null,
    };
  }
  const conversation = ctx.conversation;
  return {
    conversationId: conversation?.id ?? null,
    subject: conversation?.subject ?? ctx.draft.subject ?? null,
    recipientHandle: conversation?.recipient?.handle ?? null,
    recipientName: conversation?.recipient?.name ?? null,
    tags: conversation?.tags.map((tag) => tag.name) ?? [],
    attributes:
      conversation?.customFieldAttributes.map((attribute) => ({
        id: attribute.id,
        value: attribute.value,
      })) ?? [],
    teammateEmail: ctx.teammate.email,
    draftId: ctx.draft.id,
    composerBody: ctx.draft.content.body,
  };
}

type ReadableContext = SingleConversationContext | MessageComposerContext;

async function loadMessages(ctx: ReadableContext): Promise<ApplicationMessage[]> {
  return drain<ApplicationMessage, ApplicationPaginationToken>((token) => ctx.listMessages(token));
}

async function loadComments(ctx: ReadableContext): Promise<ApplicationComment[]> {
  return drain<ApplicationComment, ApplicationPaginationToken>((token) => ctx.listComments(token));
}

async function postCapture(body: CaptureCreate): Promise<CaptureResult> {
  const key = currentKey();
  if (!key) throw new CaptureHttpError("no-key");
  const res = await fetch(`${settings.baseUrl}/v1/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new CaptureHttpError(res.status);
  const json: unknown = await res.json();
  if (!isCaptureResult(json)) throw new CaptureHttpError("bad-response");
  return json;
}

function shell(): ConversationSnapshot {
  const live = latest;
  return {
    id: live?.conversationId ?? "cnv_pending",
    subject: live?.subject ?? null,
    recipientHandle: live?.recipientHandle ?? null,
    recipientName: live?.recipientName ?? null,
    messages: [],
    fields: {},
    url: live?.conversationId ? `https://app.frontapp.com/open/${live.conversationId}` : null,
    tags: live?.tags ?? [],
  };
}

async function main(): Promise<void> {
  const file = await fileSettings();
  settings = settingsFrom({ ...file, ...querySettings() });
  detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app");
  if (!root) return;
  const status = el("div", { class: "status" }, "Waiting for a draft");
  const hint = el("div", { class: "hint" }, "");
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  const keyInput = el("input", {
    class: "key",
    type: "password",
    autocomplete: "off",
    placeholder: currentKey() ? "API key saved — paste to replace" : "Overturn API key",
    "aria-label": "Overturn API key",
  }) as HTMLInputElement;

  const render = (): void => {
    if (pending) {
      status.textContent = "Changed reply needs a reason";
      return;
    }
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const refreshHint = (): void => {
    if (pending) return;
    const draft = detector.current();
    if (!draft) {
      hint.textContent = "";
      return;
    }
    const decision = decideOnSend({
      conversation: shell(),
      draft,
      draftFields,
      send: { text: lastBody, type: "publicReply", fields: draftFields },
      reasonCode,
      reason: "",
      actor: latest?.teammateEmail ?? null,
      settings,
    });
    hint.textContent = decision.action === "need-reason" ? "Pick why you changed it before you send." : "";
  };

  const finish = async (input: DecideOnSendInput): Promise<void> => {
    const outcome = await onSend({ ...input, reasonCode, reason: reason.value }, postCapture);
    if (outcome.action === "blocked") {
      pending = input;
      hint.textContent = outcome.message;
      chips[0]?.focus();
      render();
      return;
    }
    pending = null;
    hint.textContent = "";
    if (outcome.action === "skip") {
      detector.set(null);
      knownIds = null;
      snapshotFor = null;
      fieldsFrozen = false;
      render();
      return;
    }
    if (outcome.action === "capture-failed") {
      note.textContent = outcome.notice;
      detector.set(null);
      knownIds = null;
      snapshotFor = null;
      fieldsFrozen = false;
      draftFields = {};
      render();
      return;
    }
    lastResult = {
      kind: outcome.result.kind,
      changed: outcome.result.changed,
      dedup: outcome.result.deduplicated,
    };
    const title = outcome.result.case?.title;
    note.textContent = outcome.result.changed && title ? `Case: ${title}` : "";
    reason.value = "";
    reasonCode = null;
    for (const chip of chips) chip.classList.remove("on");
    detector.set(null);
    knownIds = null;
    snapshotFor = null;
    fieldsFrozen = false;
    draftFields = {};
    render();
  };

  for (const option of quickReasons(settings)) {
    const chip = el("button", { type: "button", class: "chip", "data-code": option.code }, option.label);
    chip.addEventListener("click", () => {
      reasonCode = reasonCode === option.code ? null : option.code;
      for (const other of chips) other.classList.toggle("on", other.dataset.code === reasonCode);
      if (pending) {
        void finish(pending);
        return;
      }
      refreshHint();
    });
    chips.push(chip);
    quick.appendChild(chip);
  }

  keyInput.addEventListener("change", () => {
    const value = keyInput.value.trim();
    if (!value) return;
    try {
      localStorage.setItem(KEY_STORAGE, value);
    } catch (error) {
      console.error("Overturn could not store the API key in this browser.", error);
    }
    keyInput.value = "";
    keyInput.placeholder = "API key saved — paste to replace";
  });

  mark.addEventListener("click", () => {
    void (async () => {
      const ctx = latestCtx;
      if (ctx && isSingle(ctx) && ctx.conversation.draftId) {
        try {
          const draft = await ctx.fetchDraft(ctx.conversation.draftId);
          if (draft?.content.body) lastBody = draft.content.body;
        } catch (error) {
          console.error("Overturn could not read the Front draft.", error);
        }
      }
      if (!lastBody.trim()) return;
      detector.set({ text: lastBody, origin: "manual", at: Date.now() });
      lastResult = null;
      fieldsFrozen = true;
      if (latest) draftFields = decisionFieldsFrom(latest.attributes, settings.decisionFields);
      render();
      refreshHint();
    })();
  });

  root.append(status, hint, quick, reason, mark, note, keyInput);

  const setWatching = (on: boolean): void => {
    quick.hidden = !on;
    reason.hidden = !on;
    mark.hidden = !on;
    hint.hidden = !on;
  };

  const acceptBody = (live: Live, body: string): void => {
    lastBody = body;
    const found = detector.onComposer(body);
    if (!detector.current()) {
      render();
      return;
    }
    if (found) lastResult = null;
    if (!fieldsFrozen) {
      draftFields = decisionFieldsFrom(live.attributes, settings.decisionFields);
      fieldsFrozen = true;
    }
    if (live.conversationId && latestCtx && (isSingle(latestCtx) || isComposer(latestCtx))) {
      void attachRecorded(live.conversationId);
      void ensureSnapshot(live.conversationId, latestCtx);
    }
    render();
    refreshHint();
  };

  async function attachRecorded(conversationId: string): Promise<void> {
    if (recordedFor === conversationId) return;
    const key = currentKey();
    const current = detector.current();
    if (!key || !current || current.origin === "manual") return;
    recordedFor = conversationId;
    try {
      const url = `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`fr:${conversationId}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (!res.ok) return;
      const found = recordedFrom(await res.json());
      const still = detector.current();
      if (!found || !still || still.origin === "manual" || currentId !== conversationId) return;
      detector.set({ text: found.output, origin: "recorded", runId: found.id, at: still.at });
      render();
    } catch (error) {
      console.error("Overturn could not look up a recorded draft.", error);
    }
  }

  async function ensureSnapshot(conversationId: string, ctx: ReadableContext): Promise<void> {
    if (knownIds || snapshotFor === conversationId || !detector.current()) return;
    snapshotFor = conversationId;
    try {
      const messages = await loadMessages(ctx);
      if (currentId !== conversationId) return;
      knownIds = new Set(messages.map((message) => message.id));
    } catch (error) {
      snapshotFor = null;
      console.error("Overturn could not read the Front conversation.", error);
    }
  }

  async function onDraftClosed(live: Live, ctx: ReadableContext): Promise<void> {
    const draft = detector.current();
    const composer = lastBody;
    const ids = knownIds;
    const frozenFields = draftFields;
    if (!draft || !live.conversationId) return;
    let messages: FrontMessage[];
    try {
      messages = (await loadMessages(ctx)).map(fromMessage);
    } catch (error) {
      console.error("Overturn could not read the Front conversation.", error);
      return;
    }
    try {
      messages.push(...(await loadComments(ctx)).map(fromComment));
    } catch (error) {
      console.error("Overturn could not read Front comments.", error);
    }
    const sent = findSentMessage({
      previousIds: ids,
      messages,
      composerText: composer,
      draftAtMs: draft.at,
      includeComments: settings.captureInternalNotes,
    });
    if (!sent) {
      if (detector.current() === draft) detector.set(null);
      knownIds = null;
      snapshotFor = null;
      fieldsFrozen = false;
      render();
      return;
    }
    const fields = decisionFieldsFrom(live.attributes, settings.decisionFields);
    const snapshot: ConversationSnapshot = {
      id: live.conversationId,
      subject: live.subject,
      recipientHandle: live.recipientHandle,
      recipientName: live.recipientName,
      messages: threadForCapture(messages, sent),
      fields,
      url: `https://app.frontapp.com/open/${live.conversationId}`,
      tags: live.tags,
    };
    await finish({
      conversation: snapshot,
      draft,
      draftFields: settings.decisionFields.length > 0 ? frozenFields : {},
      send: {
        text: sent.body,
        type: sent.isComment ? "internalNote" : "publicReply",
        fields,
      },
      reasonCode,
      reason: reason.value,
      actor: live.teammateEmail,
      settings,
      now: Date.now(),
    });
  }

  function pullDraft(): void {
    const ctx = latestCtx;
    if (!ctx || !isSingle(ctx) || !ctx.conversation.draftId) return;
    const conversationId = ctx.conversation.id;
    void ctx
      .fetchDraft(ctx.conversation.draftId)
      .then((draft) => {
        if (!latest || latest.conversationId !== conversationId || draft?.content.body === undefined) return;
        acceptBody(latest, draft.content.body);
      })
      .catch((error: unknown) => {
        console.error("Overturn could not read the Front draft.", error);
      });
  }

  function startPoll(): void {
    stopPoll();
    pullDraft();
    pollTimer = window.setInterval(pullDraft, 800);
  }

  function handle(ctx: { type: string }): void {
    latestCtx = ctx;
    if (!isSingle(ctx) && !isComposer(ctx)) {
      stopPoll();
      if (!pending) setWatching(false);
      status.textContent = pending
        ? "Changed reply needs a reason"
        : ctx.type === "multiConversations"
          ? "Open one conversation."
          : "Waiting for a draft";
      return;
    }
    const live = toLive(ctx);
    latest = live;
    if (!live.conversationId) {
      if (live.composerBody !== null) acceptBody(live, live.composerBody);
      else render();
      return;
    }
    if (live.conversationId !== currentId) resetConversation(live.conversationId);
    if (!inScope(live.tags, settings)) {
      stopPoll();
      if (!pending) setWatching(false);
      status.textContent = pending
        ? "Changed reply needs a reason"
        : `Not watching: no "${settings.scopeTag}" tag`;
      return;
    }
    setWatching(true);
    if (pending) render();
    if (live.draftId) {
      seenDraftId = live.draftId;
      if (pollTimer === null && isSingle(ctx)) startPoll();
      if (live.composerBody !== null) acceptBody(live, live.composerBody);
      return;
    }
    if (seenDraftId) {
      seenDraftId = null;
      stopPoll();
      void onDraftClosed(live, ctx);
      return;
    }
    render();
  }

  try {
    contextUpdates.subscribe((ctx) => {
      try {
        handle(ctx);
      } catch (error) {
        console.error("Overturn hit an error and got out of the way.", error);
      }
    });
  } catch (error) {
    status.textContent = "Open this panel inside Front.";
    console.error(error);
  }
}

void main();
