import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  decisionFieldsFrom,
  type FrontMessage,
  findSentMessage,
  inScope,
  onSend,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
  threadForCapture,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const plainDraft =
  "Hi Dana,\nThanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.";

const conversation: ConversationSnapshot = {
  id: "cnv_48213",
  subject: "Roof leak after storm",
  recipientHandle: "dana@example.com",
  recipientName: "Dana",
  messages: [
    {
      id: "msg_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      contentType: "html",
      status: "inbound",
      author: "dana@example.com",
      at: "2026-10-01T10:00:00.000Z",
      isComment: false,
    },
    {
      id: "com_2",
      body: "HO-3, no prior claims.",
      contentType: "text",
      status: "outbound",
      author: "ray@carrier.com",
      at: "2026-10-01T11:00:00.000Z",
      isComment: true,
    },
  ],
  fields: {},
  url: "https://app.frontapp.com/open/cnv_48213",
  tags: ["billing"],
};

const captured: CaptureResult = {
  runId: "0199a0d0-0000-7000-8000-000000000001",
  stepId: "0199a0d0-0000-7000-8000-000000000002",
  kind: "approve",
  changed: false,
  changedFields: [],
  correction: {
    id: "0199a0d0-0000-7000-8000-000000000003",
    projectId: "0199a0d0-0000-7000-8000-000000000004",
    runId: "0199a0d0-0000-7000-8000-000000000001",
    stepId: "0199a0d0-0000-7000-8000-000000000002",
    kind: "approve",
    correctedOutput: null,
    note: null,
    reasonCode: null,
    actor: null,
    source: "capture",
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  case: null,
  deduplicated: false,
};

describe("settings", () => {
  it("parses the plugin parameters", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "fld_1:coverage, fld_2:reserve,fld_3",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "fld_1", label: "coverage" },
      { id: "fld_2", label: "reserve" },
      { id: "fld_3", label: "fld_3" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips: support by default, claims when a claims team opts in", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    const claims = quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code);
    expect(claims).toEqual([
      "wrong_coverage_decision",
      "missed_exclusion",
      "reserve_too_low",
      "reserve_too_high",
      "wrong_amount_or_date",
      "missing_required_step",
      "tone_wording",
      "policy_exception",
    ]);
    const support = quickReasons(settingsFrom({})).map((r) => r.code);
    expect(support).toContain("wrong_answer");
    expect(support).toContain("should_escalate");
    expect(support).not.toContain("reserve_too_low");
    expect(support).toContain("tone_wording");
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("falls back to defaults, with require_reason on, and refuses a non-https base url", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
    expect(settingsFrom({ overturn_base_url: "http://evil.example/capture" }).baseUrl).toBe(
      "https://api.overturn.run",
    );
    expect(settingsFrom({ overturn_base_url: "http://localhost:3000/" }).baseUrl).toBe(
      "http://localhost:3000",
    );
    expect(settingsFrom({ overturn_base_url: "javascript:alert(1)" }).baseUrl).toBe(
      "https://api.overturn.run",
    );
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull();
  });

  it("a composer that already holds a reply on load is a preloaded draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });

  it("a paste after a pause while a short greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("context and html", () => {
  it("strips html and maps Front messages oldest first", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00.000Z",
      },
      {
        role: "note",
        author: "ray@carrier.com",
        content: "HO-3, no prior claims.",
        at: "2026-10-01T11:00:00.000Z",
      },
    ]);
    const newestFirst: ConversationSnapshot = {
      ...conversation,
      messages: [...conversation.messages].reverse(),
    };
    expect(contextFrom(newestFirst).map((m) => m.role)).toEqual(["customer", "note"]);
  });

  it("drops the message that was just sent from the thread the draft was answering", () => {
    const sent: FrontMessage = {
      id: "msg_9",
      body: "Sent reply",
      contentType: "text",
      status: "outbound",
      author: "ray@carrier.com",
      at: "2026-10-01T12:00:00.000Z",
      isComment: false,
    };
    expect(threadForCapture([...conversation.messages, sent], sent).map((m) => m.id)).toEqual([
      "msg_1",
      "com_2",
    ]);
  });
});

describe("decision fields", () => {
  it("reads the named Front custom fields and serializes dates", () => {
    const fields = decisionFieldsFrom(
      [
        { id: "fld_1", value: "covered" },
        { id: "fld_2", value: new Date("2026-10-02T00:00:00.000Z") },
        { id: "fld_9", value: "ignored" },
      ],
      [
        { id: "fld_1", label: "coverage" },
        { id: "fld_2", label: "loss_date" },
        { id: "fld_missing", label: "reserve" },
      ],
    );
    expect(fields).toEqual({
      coverage: "covered",
      loss_date: "2026-10-02T00:00:00.000Z",
      reserve: null,
    });
  });
});

describe("findSentMessage", () => {
  const composer = "An adjuster will contact you within 2 business days.";
  const sent: FrontMessage = {
    id: "msg_9",
    body: `<p>${composer}</p>`,
    contentType: "html",
    status: "outbound",
    author: "ray@carrier.com",
    at: "2026-10-01T12:00:02.000Z",
    isComment: false,
  };
  const prior = conversation.messages[0]!;

  it("the new outbound message is what was sent", () => {
    expect(
      findSentMessage({
        previousIds: new Set(["msg_1", "com_2"]),
        messages: [prior, sent],
        composerText: composer,
        draftAtMs: Date.parse("2026-10-01T12:00:00.000Z"),
        includeComments: false,
      })?.id,
    ).toBe("msg_9");
  });

  it("closing the composer without a new outbound is a discard", () => {
    expect(
      findSentMessage({
        previousIds: new Set(["msg_1", "com_2"]),
        messages: [...conversation.messages],
        composerText: composer,
        draftAtMs: Date.parse("2026-10-01T12:00:00.000Z"),
        includeComments: false,
      }),
    ).toBeNull();
  });

  it("matches the composer when the sent message reused an id we had already seen", () => {
    expect(
      findSentMessage({
        previousIds: new Set(["msg_1", "msg_9"]),
        messages: [prior, sent],
        composerText: `<p>${composer}</p>`,
        draftAtMs: Date.parse("2026-10-01T12:00:00.000Z"),
        includeComments: false,
      })?.id,
    ).toBe("msg_9");
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1 };
  const base = {
    conversation,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, on internal notes, and on empty sends", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "x", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "x", type: "internalNote", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", type: "publicReply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged posts source front and fr:<conversation id>", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body).toMatchObject({
      source: "front",
      externalId: "fr:cnv_48213",
      agent: "support-reply",
      actor: "ray@carrier.com",
      subject: "Roof leak after storm",
      reason: null,
      reasonCode: null,
      draftRunId: null,
      url: "https://app.frontapp.com/open/cnv_48213",
      tags: ["draft:inserted", "public-reply"],
      metadata: { requester: "dana@example.com" },
    });
    expect(d.body.draft).toEqual({ text: plainDraft });
    expect(d.body.sent).toEqual({ text: plainDraft });
    expect(d.body.sent.fields).toBeUndefined();
    expect(d.body.context).toHaveLength(2);
    expect(d.body.context[0]).toEqual({
      role: "customer",
      author: "dana@example.com",
      content: "Water came through the ceiling.\nPhotos attached.",
      at: "2026-10-01T10:00:00.000Z",
    });
    expect(typeof d.body.secondsToSend).toBe("number");
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason blocks a changed send until a reason code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("covered", "not covered");
    const blocked = decideOnSend({
      ...base,
      settings,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });
    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "exclusion",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");
    const ok = decideOnSend({
      ...base,
      settings,
      reasonCode: "missed_exclusion",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("missed_exclusion");
    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    expect(unchanged.action).toBe("capture");
    if (unchanged.action === "capture") expect(unchanged.body.reasonCode).toBeNull();
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: [{ id: "fld_1", label: "coverage" }] };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      draftFields: { coverage: "covered" },
      send: { text: draftText, type: "publicReply", fields: { coverage: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["coverage"]);
    expect(d.body.draft).toEqual({ text: plainDraft, fields: { coverage: "covered" } });
    expect(d.body.sent).toEqual({ text: plainDraft, fields: { coverage: "denied" } });
  });

  it("records how long the draft sat in front of the expert", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "inserted", at: 10_000 },
      now: 14_250,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
    expect(d.body.tags).toEqual(["draft:recorded", "public-reply"]);
  });
});

describe("onSend", () => {
  const input = {
    conversation,
    draft: { text: draftText, origin: "inserted" as const, at: 1 },
    draftFields: {},
    send: { text: draftText.replace("covered", "not covered"), type: "publicReply" as const, fields: {} },
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: DEFAULT_SETTINGS,
    now: 2_000,
  };

  it("holds a changed reply until a reason code is picked and does not post", async () => {
    const posted: CaptureCreate[] = [];
    const outcome = await onSend(input, async (body) => {
      posted.push(body);
      return captured;
    });
    expect(outcome).toEqual({
      action: "blocked",
      changedFields: [],
      message: "Overturn: pick why you changed the reply in the Overturn panel (one click).",
    });
    expect(posted).toEqual([]);
  });

  it("a failed capture logs and resolves, so the send is not blocked", async () => {
    const lines: string[] = [];
    const outcome = await onSend(
      { ...input, settings: { ...DEFAULT_SETTINGS, requireReason: false } },
      async () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
      (line) => lines.push(line),
    );
    expect(outcome).toEqual({
      action: "capture-failed",
      notice: "Overturn could not save this correction (503).",
    });
    expect(lines).toEqual(["Overturn could not save this correction (503)."]);
  });

  it("posts the capture when the reply can go out", async () => {
    const outcome = await onSend(
      { ...input, reasonCode: "missed_exclusion", settings: DEFAULT_SETTINGS },
      async () => captured,
    );
    expect(outcome.action).toBe("captured");
  });
});

describe("statusLine", () => {
  it("says when a draft was inserted", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ text: "<p>one two</p>", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 2 words",
    );
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
  });
});
