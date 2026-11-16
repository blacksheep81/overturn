# Overturn for Front

QA for AI-drafted replies, in the Front sidebar. It watches the composer for the AI draft, diffs it against what the teammate sends, asks for a one-click reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model. It does not matter who wrote the draft.

## What the teammate sees

- **Draft inserted · 112 words** once a reply-sized text lands in the composer in one change (an AI assist or a paste). A composer that already holds a reply when the conversation opens is "found in the composer". "Use the current text as the draft" marks it by hand. If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), that run is the draft.
- A **reason** picker. `reason_pack` is `support` (default) or `claims` (the eight claims codes). The note under the chips is optional.
- On **send**, the reply that left the composer is the capture. Sent as drafted is an approve. Changed is an edit. With `require_reason` on (the default), a changed reply is not recorded until a reason code is picked. The Front plugin SDK has no before-send hook, so Front's own Send button still delivers the message; the panel holds the capture and says why.

Overturn failing never blocks the send. The failure is logged in the panel and the console. The run page links back to `https://app.frontapp.com/open/<conversation id>`.

The thread is listed only after a draft is in the composer. A conversation with no draft is not read. With `scope_tag` set, conversations without that tag are not watched at all.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip`. Host the `dist/app` folder at an https URL.
3. In Front: Settings → Plugins → Add a plugin. Side panel. Endpoint: that URL. Icon: `app/assets/logo.png`.
4. Settings that are not secret are query parameters on the endpoint URL: `agent`, `reason_pack` (`support` or `claims`), `require_reason`, `capture_internal_notes`, `decision_fields` (`fld_123:coverage, fld_456:reserve`), `scope_tag`, `min_draft_chars`. `overturn_base_url` (https, or `http://localhost` for a local API) goes in a `settings.json` next to `index.html`, not in the query string.
5. Each teammate pastes the API key in the panel once. It is stored in the browser against that API origin and is not sent to a different one. Front does not keep a server-side secret the way Zendesk does. A `settings.json` on the host can hold the key too; that file is then as public as the host. Do not put the key in the plugin URL.

## Replay what it captured

```bash
overturn cases list --agent claims-reply
overturn replay --model openai/gpt-4.1-mini --agent claims-reply
```

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin build
```

`src/capture.ts` is the logic (pure, tested). `src/main.ts` is the Front plugin SDK glue. `app/` is the page the sidebar loads. Payload shape: [docs/capture.md](../../docs/capture.md).
