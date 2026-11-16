// PostHog for the marketing site and docs. Loaded by the landing page (site/index.html, which
// www.overturn.run mounts from Framer as framer/landing.js) and by every docs page on
// docs.overturn.run. Same project as app.overturn.run (apps/web/components/analytics/posthog-key.ts);
// the project token is public and write-only. Only the production hosts report, so local builds and
// previews send nothing. The cookie is first-party on .overturn.run, so a visitor who clicks
// "Start free" is the same person in the app's funnel (CLAUDE.md "Funnel"; docs/privacy).
(() => {
  var KEY = "phc_vWUxkGb2jZG3mjQfnSXN7XEqpVS5kaGtHJurf5sSc8ED";
  var HOSTS = ["overturn.run", "www.overturn.run", "docs.overturn.run"];
  if (HOSTS.indexOf(window.location.hostname) === -1) return;
  // Framer can mount the landing page more than once; one loader and one click listener per page
  if (window.__ovAnalytics) return;
  window.__ovAnalytics = true;

  var s = document.createElement("script");
  s.src = "https://us-assets.i.posthog.com/static/array.js";
  s.async = true;
  s.onload = () => {
    window.posthog.init(KEY, {
      api_host: "https://us.i.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      // the funnel uses explicit events only. These are off here rather than left to the project's remote
      // config, which can switch them on: autocapture (clicked elements' text), heatmaps and dead clicks
      // (click positions and selectors), web vitals and network timing, exceptions, surveys.
      autocapture: false,
      enable_heatmaps: false,
      capture_dead_clicks: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_surveys: true,
      // recordings are allowed for app.overturn.run only (project setting), so do not load the recorder
      disable_session_recording: true,
      persistence: "localStorage+cookie",
      cross_subdomain_cookie: true,
    });
  };
  document.head.appendChild(s);

  // <a data-cta="hero_start_free"> -> landing_cta_clicked { where: "hero_start_free" }, same event
  // and property as track.landingCta in the app. sendBeacon so the event survives the navigation.
  document.addEventListener("click", (e) => {
    var el = e.target?.closest ? e.target.closest("[data-cta]") : null;
    var ph = window.posthog;
    if (!el || !ph?.__loaded) return;
    ph.capture("landing_cta_clicked", { where: el.getAttribute("data-cta") }, { transport: "sendBeacon" });
  });
})();
