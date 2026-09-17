import { describe, expect, it } from "vitest";
import { inspectStaticVacancyHtml, isGloballyRoutableAddress, verifyPublicSource } from "../src/lib/public-source-fetch";

function vacancyHtml(extra = "") {
  return `<html><head><title>Senior Project Manager at Example Corp</title></head><body><main><h1>Senior Project Manager</h1><p>Example Corp</p><button>Apply now</button><h2>Responsibilities</h2><p>${"Own delivery and coordinate technical stakeholders. ".repeat(20)}</p><h2>Requirements</h2><p>${"Program leadership and software delivery experience. ".repeat(20)}</p>${extra}</main></body></html>`;
}

describe("trusted public source fetch boundaries", () => {
  it("accepts only ordinary globally routable addresses, including mapped-address normalization", () => {
    expect(isGloballyRoutableAddress("8.8.8.8")).toBe(true);
    expect(isGloballyRoutableAddress("2606:4700:4700::1111")).toBe(true);
    for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1"]) {
      expect(isGloballyRoutableAddress(address), address).toBe(false);
    }
  });

  it("rejects IPv4 and bracketed IPv6 URL literals before any request", async () => {
    const base = { taskId: "22222222-2222-4222-8222-222222222222", attempt: 1, expectedTitle: "Role", expectedCompany: "Employer" };
    await expect(verifyPublicSource({ ...base, url: "https://127.0.0.1/job" })).rejects.toThrow(/public DNS hostname/);
    await expect(verifyPublicSource({ ...base, url: "https://[::1]/job" })).rejects.toThrow(/public DNS hostname/);
  });

  it("requires matching vacancy-shaped static HTML and rejects explicit soft-closed pages", () => {
    expect(inspectStaticVacancyHtml(vacancyHtml(), "Senior Project Manager", "Example Corp")).toMatchObject({ titleMatched: true, companyMatched: true, applySignal: true });
    expect(() => inspectStaticVacancyHtml(vacancyHtml("<p>This job is no longer available.</p>"), "Senior Project Manager", "Example Corp")).toThrow(/unavailable or closed/);
    expect(() => inspectStaticVacancyHtml(vacancyHtml(), "Different Role", "Example Corp")).toThrow(/identity and shape/);
    expect(() => inspectStaticVacancyHtml(vacancyHtml(), "Senior Project Manager", "ample")).toThrow(/identity and shape/);
    expect(() => inspectStaticVacancyHtml(vacancyHtml(), "Senior Project Manager", "---")).toThrow(/searchable text/);
  });

  it("does not accept identity text found only in scripts or comments", () => {
    const unrelated = vacancyHtml()
      .replaceAll("Senior Project Manager", "Accountant")
      .replaceAll("Example Corp", "Other Employer")
      .replace("</body>", '<script>window.cachedJob = "Senior Project Manager at Example Corp"</script><!-- Senior Project Manager at Example Corp --></body>');
    expect(() => inspectStaticVacancyHtml(unrelated, "Senior Project Manager", "Example Corp")).toThrow(/identity and shape/);
  });
});
