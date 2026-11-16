// The marketing site's PostHog loader (public/analytics.js) and the CTAs it tracks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "../public/analytics.js"), "utf8");
const landing = readFileSync(path.join(here, "../site/index.html"), "utf8");
const config = readFileSync(path.join(here, "../astro.config.mjs"), "utf8");
const APP_KEY = readFileSync(path.join(here, "../../web/components/analytics/posthog-key.ts"), "utf8").match(
  /POSTHOG_PROD_KEY = "([^"]+)"/,
)[1];

/** Runs analytics.js against a fake page on `hostname`; returns what it did. */
function load(hostname) {
  const appended = [];
  const listeners = {};
  const calls = { init: [], capture: [] };
  const window = { location: { hostname } };
  const document = {
    createElement: (tag) => ({ tag }),
    head: { appendChild: (el) => appended.push(el) },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
  };
  window.document = document;
  vm.runInNewContext(source, { window, document });
  const loadLibrary = () => {
    window.posthog = {
      __loaded: false,
      init(key, opts) {
        calls.init.push({ key, opts });
        this.__loaded = true;
      },
      capture: (...args) => calls.capture.push(args),
    };
    appended[0].onload();
  };
  const click = (cta) =>
    listeners.click({ target: { closest: () => (cta ? { getAttribute: () => cta } : null) } });
  return { appended, listeners, calls, loadLibrary, click };
}

describe("analytics.js", () => {
  it("sends nothing off the production hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "overturn-ai.github.io", "overturn.run.evil.example"]) {
      const page = load(host);
      assert.equal(page.appended.length, 0, host);
      assert.equal(page.listeners.click, undefined, host);
    }
  });

  it("loads PostHog on overturn.run into the app's project, without autocapture or recordings", () => {
    const page = load("overturn.run");
    assert.equal(page.appended.length, 1);
    assert.equal(page.appended[0].src, "https://us-assets.i.posthog.com/static/array.js");
    page.loadLibrary();
    assert.equal(page.calls.init.length, 1);
    const { key, opts } = page.calls.init[0];
    assert.equal(key, APP_KEY);
    assert.equal(opts.api_host, "https://us.i.posthog.com");
    assert.equal(opts.capture_pageview, true);
    assert.equal(opts.autocapture, false);
    assert.equal(opts.disable_session_recording, true);
    assert.equal(opts.cross_subdomain_cookie, true);
  });

  it("sends landing_cta_clicked with where for a data-cta click, once PostHog has loaded", () => {
    const page = load("www.overturn.run");
    page.click("hero_start_free"); // before the library loads: dropped, no throw
    assert.equal(page.calls.capture.length, 0);
    page.loadLibrary();
    page.click("hero_start_free");
    page.click(null); // a click outside any CTA
    // JSON round-trip: objects built inside the vm context have that realm's prototypes
    assert.deepEqual(JSON.parse(JSON.stringify(page.calls.capture)), [
      ["landing_cta_clicked", { where: "hero_start_free" }, { transport: "sendBeacon" }],
    ]);
  });
});

describe("landing page", () => {
  const ctas = (html) => [...html.matchAll(/<a [^>]*class="(?:btn|link)[^"]*"[^>]*>/g)].map((m) => m[0]);
  const block = (start, end) =>
    landing.slice(landing.indexOf(start), landing.indexOf(end, landing.indexOf(start)));

  it("tags every hero and quickstart button with a unique data-cta", () => {
    const hero = ctas(block('<div class="ctas">', "</div>"));
    const quickstart = ctas(block('<div class="foot">', "</div>"));
    assert.equal(hero.length, 3);
    assert.equal(quickstart.length, 2);
    const names = [...hero, ...quickstart].map((a) => a.match(/data-cta="([a-z_]+)"/)?.[1]);
    assert.ok(names.every(Boolean), `untagged: ${[...hero, ...quickstart].filter((_, i) => !names[i])}`);
    assert.equal(new Set(names).size, names.length);
  });

  it("loads analytics.js from <head>, outside the scripts copied into the Framer module", () => {
    const head = landing.slice(0, landing.indexOf("<body>"));
    assert.match(head, /<script src="\/docs\/analytics\.js" defer><\/script>/);
  });

  it("loads analytics.js on every docs page", () => {
    assert.match(config, /src: "\/docs\/analytics\.js"/);
  });
});
