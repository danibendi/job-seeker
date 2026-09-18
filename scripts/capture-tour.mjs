#!/usr/bin/env node

// Optional maintainer tool. Install Playwright separately; the app does not need it.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const job = "00000003-0000-4000-8000-000000000001";
const interview = "00000007-0000-4000-8000-000000000001";
const pages = [
  { name: "dashboard", route: "/", text: "Review next" },
  { name: "pipeline", route: "/pipeline?stage=active&min=0", text: "Add a job manually" },
  { name: "pipeline-board", route: "/pipeline?view=board&min=0", text: "Add a job manually" },
  { name: "job-detail", route: `/jobs/${job}`, text: "Why it fits" },
  { name: "cv", route: "/cv", text: "Create a CV variant" },
  { name: "interviews", route: "/interviews", text: "2 coming up" },
  { name: "interview-prep", route: `/interviews/${interview}`, text: "Questions to ask" },
  { name: "activity", route: "/activity?tab=tasks", text: "Waiting on agents" },
  { name: "requests", route: "/activity?tab=requests", text: "Ask about the search", placeholder: true, open: "Answer" },
  { name: "search-history", route: "/activity?tab=runs", text: "Last search", allDetails: true },
  { name: "insights", route: "/insights", text: "Insights" },
  { name: "agencies", route: "/agencies", text: "Agencies", firstDetails: true },
  { name: "watchlist", route: "/watchlist?kind=company", text: "Watchlist", firstDetails: true },
  { name: "search-preferences", route: "/settings?tab=search", text: "Search" },
  { name: "locations", route: "/settings?tab=locations", text: "Where" },
  { name: "schedule", route: "/settings?tab=schedule", text: "Schedule" },
  { name: "mobile-dashboard", route: "/", text: "Review next", mobile: true },
];

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: JOB_SEEKER_DEMO_CAPTURE=true JOB_SEEKER_LOGIN_PASSWORD=<from-secret-store> node scripts/capture-tour.mjs\nOptional: JOB_SEEKER_DEMO_URL (default http://localhost:3000), JOB_SEEKER_TOUR_OUTPUT (default docs/screenshots), JOB_SEEKER_PLAYWRIGHT_MODULE, JOB_SEEKER_CHROME_PATH. Seed the fictional demo first; see examples/demo/README.md.");
    return;
  }
  if (process.env.JOB_SEEKER_DEMO_CAPTURE !== "true") throw new Error("Explicit fictional-demo capture opt-in is required.");
  if (!process.env.JOB_SEEKER_LOGIN_PASSWORD) throw new Error("Provide the disposable app's login password through the environment.");
  const origin = new URL(process.env.JOB_SEEKER_DEMO_URL || "http://localhost:3000");
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Demo URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  const modulePath = process.env.JOB_SEEKER_PLAYWRIGHT_MODULE;
  const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : "playwright");
  const output = path.resolve(process.env.JOB_SEEKER_TOUR_OUTPUT || "docs/screenshots");
  const browser = await chromium.launch({
    ...(process.env.JOB_SEEKER_CHROME_PATH ? { executablePath: process.env.JOB_SEEKER_CHROME_PATH } : {}),
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce", locale: "en-GB", timezoneId: "Europe/London" });
    // The app bundles its fonts. No external assets or example links are needed.
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", () => errors.push("browser error"));
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}`); });
    await page.goto(new URL("/login", origin).href);
    await page.getByLabel("Password", { exact: true }).fill(process.env.JOB_SEEKER_LOGIN_PASSWORD);
    await page.getByRole("button", { name: "Open Job Seeker", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.getByRole("heading", { name: /Alex Morgan/ }).waitFor();
    // Resolve the pending review from the real dashboard, so screenshots show the
    // same saved proposal a person reaches through the app.
    const reviewLink = page.locator('a[href^="/cv?tailoring="]').first();
    if (!await reviewLink.count()) throw new Error("Expected the fictional pending CV proposal.");
    pages.find((entry) => entry.name === "cv").route = await reviewLink.getAttribute("href");
    await mkdir(output, { recursive: true });
    for (const entry of pages) {
      await page.setViewportSize(entry.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
      const response = await page.goto(new URL(entry.route, origin).href, { waitUntil: "networkidle" });
      if (!response?.ok()) throw new Error(`Could not open ${entry.name}.`);
      const target = entry.placeholder ? page.getByPlaceholder(entry.text) : page.getByText(entry.text, { exact: true }).first();
      await target.waitFor();
      if (entry.open) await page.locator("summary").filter({ hasText: entry.open }).first().click();
      if (entry.firstDetails) await page.locator("main details > summary").first().click();
      if (entry.allDetails) for (const summary of await page.locator("main details > summary").all()) await summary.click();
      if (entry.name === "agencies") {
        for (const label of ["Active", "Contacted", "To contact"]) {
          await page.locator("main .pill").filter({ hasText: new RegExp(`^${label}$`) }).waitFor();
        }
      }
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) throw new Error(`Horizontal page overflow in ${entry.name}.`);
      await page.screenshot({ path: path.join(output, `${entry.name}.png`), animations: "disabled" });
      console.log(`Captured ${entry.name}.`);
    }
    if (errors.length) throw new Error(`Browser verification found ${errors.length} error(s).`);
    console.log(`Tour captured: ${pages.length} screenshots; no browser errors or horizontal page overflow.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  // Avoid dumping browser traces, pages, cookies, or environment contents.
  console.error(`Tour capture failed: ${error.message.split("\n")[0]}`);
  process.exitCode = 1;
});
