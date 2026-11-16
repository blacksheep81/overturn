/**
 * OVERTURN-WEB-1: React #418 on app.overturn.run/login. The server has no hostname, so it gets no
 * PostHog key and rendered bare children; the browser on the production host gets the production
 * key and rendered a <Suspense> boundary around them. Different trees, so hydration failed on every
 * production page load. The provider must render the same markup whether or not a key resolves.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

async function renderProvider(envKey: string | undefined): Promise<string> {
  vi.resetModules();
  if (envKey === undefined) vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
  else vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", envKey);
  const { PostHogProvider } = await import("../components/analytics/PostHogProvider");
  return renderToString(createElement(PostHogProvider, null, createElement("main", null, "page")));
}

describe("PostHogProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the same markup with and without a PostHog key", async () => {
    const withoutKey = await renderProvider(undefined); // server render on the production host
    const withKey = await renderProvider("phc_test"); // what the browser renders there
    expect(withKey).toBe(withoutKey);
  });
});
