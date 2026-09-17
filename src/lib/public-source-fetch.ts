import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { z } from "zod";

const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const FETCH_DEADLINE_MS = 10_000;
const MIN_VACANCY_TEXT = 500;

export const trustedPublicSourceReceiptSchema = z.object({
  receipt_id: z.uuid(),
  authority: z.literal("server_direct_fetch"),
  task_id: z.uuid(),
  attempt: z.number().int().min(1),
  initial_url: z.url().max(4000),
  final_url: z.url().max(4000),
  checked_at: z.iso.datetime({ offset: true }),
  http_status: z.literal(200),
  content_type: z.string().max(200),
  body_sha256: z.string().length(64),
  body_bytes: z.number().int().min(1).max(MAX_BODY_BYTES),
  expected_title: z.string().min(1).max(500),
  expected_company: z.string().min(1).max(300),
  static_html_vacancy_shaped: z.literal(true),
  soft_closed: z.literal(false),
  title_matched: z.literal(true),
  company_matched: z.literal(true),
  apply_signal: z.literal(true),
  vacancy_section_signal_count: z.number().int().min(2).max(10),
});

export type TrustedPublicSourceReceipt = z.infer<typeof trustedPublicSourceReceiptSchema>;

export class PublicSourceFetchError extends Error {}

function publicHttpsUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicSourceFetchError("Source URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash) {
    throw new PublicSourceFetchError("Source verification requires HTTPS on port 443 without credentials or fragments");
  }
  const unbracketedHostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(unbracketedHostname)) throw new PublicSourceFetchError("Source verification requires a public DNS hostname");
  if (url.href.length > 4000) throw new PublicSourceFetchError("Source URL is too long");
  return url;
}

export function isGloballyRoutableAddress(value: string) {
  if (!ipaddr.isValid(value)) return false;
  let address = ipaddr.parse(value);
  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) address = address.toIPv4Address();
  return address.range() === "unicast";
}

function timeRemaining(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new PublicSourceFetchError("Source verification timed out");
  return remaining;
}

async function resolvePinnedAddress(hostname: string, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PublicSourceFetchError("Source DNS lookup timed out")), timeRemaining(deadline));
        timer.unref?.();
      }),
    ]);
    if (!addresses.length || addresses.some((entry) => !isGloballyRoutableAddress(entry.address))) {
      throw new PublicSourceFetchError("Source hostname did not resolve exclusively to public addresses");
    }
    return addresses;
  } catch (error) {
    if (error instanceof PublicSourceFetchError) throw error;
    throw new PublicSourceFetchError("Source hostname could not be resolved");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pinnedLookup(hostname: string, addresses: Awaited<ReturnType<typeof resolvePinnedAddress>>): LookupFunction {
  return ((requested: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    if (requested !== hostname) {
      callback(new Error("Pinned source hostname mismatch"));
      return;
    }
    const requestedFamily = options?.family === 4 || options?.family === 6 ? options.family : 0;
    const selected = addresses.find((entry) => !requestedFamily || entry.family === requestedFamily);
    if (!selected) {
      callback(new Error("Pinned source address family is unavailable"));
      return;
    }
    if (options?.all) callback(null, [selected]);
    else callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

type FetchedPage = { finalUrl: URL; status: number; contentType: string; body: Buffer };

async function fetchPinnedHtml(initialUrl: URL, deadline: number, redirects = 0): Promise<FetchedPage> {
  const addresses = await resolvePinnedAddress(initialUrl.hostname, deadline);
  timeRemaining(deadline);
  const body = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; data: Buffer }>((resolve, reject) => {
    let settled = false;
    const timers: { absolute?: ReturnType<typeof setTimeout> } = {};
    const finish = () => {
      if (timers.absolute) clearTimeout(timers.absolute);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error instanceof PublicSourceFetchError ? error : new PublicSourceFetchError("Source request failed"));
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: initialUrl.hostname,
      port: 443,
      path: `${initialUrl.pathname}${initialUrl.search}`,
      method: "GET",
      agent: false,
      servername: initialUrl.hostname,
      rejectUnauthorized: true,
      lookup: pinnedLookup(initialUrl.hostname, addresses),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "JobSeekerSourceVerifier/1.0",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const declared = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        response.destroy();
        fail(new PublicSourceFetchError("Source page exceeds the verification size limit"));
        return;
      }
      const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") {
        response.destroy();
        fail(new PublicSourceFetchError("Source page used an unsupported content encoding"));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          response.destroy();
          fail(new PublicSourceFetchError("Source page exceeds the verification size limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        finish();
        resolve({ status: response.statusCode ?? 0, headers: response.headers, data: Buffer.concat(chunks) });
      });
      response.on("error", fail);
    });
    timers.absolute = setTimeout(() => request.destroy(new PublicSourceFetchError("Source verification timed out")), Math.max(0, deadline - Date.now()));
    timers.absolute.unref?.();
    request.setTimeout(Math.max(1, deadline - Date.now()), () => request.destroy(new PublicSourceFetchError("Source verification timed out")));
    request.on("error", fail);
    request.end();
  });

  if ([301, 302, 303, 307, 308].includes(body.status)) {
    if (redirects >= MAX_REDIRECTS) throw new PublicSourceFetchError("Source URL redirected too many times");
    const location = Array.isArray(body.headers.location) ? body.headers.location[0] : body.headers.location;
    if (!location) throw new PublicSourceFetchError("Source redirect did not provide a destination");
    const redirected = publicHttpsUrl(new URL(location, initialUrl).href);
    if (redirected.hostname !== initialUrl.hostname) throw new PublicSourceFetchError("Source redirect changed hostname");
    return fetchPinnedHtml(redirected, deadline, redirects + 1);
  }
  const contentType = String(body.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  return { finalUrl: initialUrl, status: body.status, contentType, body: body.data };
}

function decodeEntities(value: string) {
  const codePoint = (raw: string, radix: number) => {
    const parsed = Number.parseInt(raw, radix);
    return parsed <= 0x10ffff && !(parsed >= 0xd800 && parsed <= 0xdfff) ? String.fromCodePoint(parsed) : " ";
  };
  return value
    .replace(/&#(\d{1,7});/g, (_, code) => codePoint(code, 10))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => codePoint(code, 16))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function normalizedText(value: string) {
  return decodeEntities(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function visibleStaticText(html: string) {
  return decodeEntities(html
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[^]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

const SOFT_CLOSED = /\b(page|job|vacancy|position|posting)\s+(?:is\s+)?(?:not found|no longer available|unavailable|closed|expired|has been filled)|\bno longer accepting applications\b|\bwe (?:could not|couldn't) find (?:this|that) job\b/i;
const APPLY_SIGNAL = /\bapply(?: now| for (?:this|the) (?:job|role|position))?\b/i;
const VACANCY_SECTIONS = [
  /\bresponsibilit(?:y|ies)\b/i,
  /\brequirements?\b/i,
  /\bqualifications?\b/i,
  /\b(?:job description|about (?:the|this) (?:job|role|position))\b/i,
  /\b(?:what you(?:'|’)ll do|what you will do)\b/i,
  /\b(?:skills|experience)\b/i,
];

export function inspectStaticVacancyHtml(html: string, expectedTitle: string, expectedCompany: string) {
  const visible = visibleStaticText(html);
  if (visible.length < MIN_VACANCY_TEXT) throw new PublicSourceFetchError("Source HTML is too small to establish a vacancy page");
  if (SOFT_CLOSED.test(visible)) throw new PublicSourceFetchError("Source HTML indicates that the vacancy is unavailable or closed");
  const searchable = normalizedText(visible);
  const title = normalizedText(expectedTitle);
  const company = normalizedText(expectedCompany);
  if (!title || !company) throw new PublicSourceFetchError("Submitted vacancy identity must contain searchable text");
  const paddedSearchable = ` ${searchable} `;
  const titleMatched = paddedSearchable.includes(` ${title} `);
  const companyMatched = paddedSearchable.includes(` ${company} `);
  const applySignal = APPLY_SIGNAL.test(visible);
  const vacancySectionSignalCount = VACANCY_SECTIONS.filter((pattern) => pattern.test(visible)).length;
  if (!titleMatched || !companyMatched || !applySignal || vacancySectionSignalCount < 2) {
    throw new PublicSourceFetchError("Source HTML does not match the submitted employer vacancy identity and shape");
  }
  return { titleMatched, companyMatched, applySignal, vacancySectionSignalCount };
}

export async function verifyPublicSource(input: {
  taskId: string;
  attempt: number;
  url: string;
  expectedTitle: string;
  expectedCompany: string;
  now?: Date;
}): Promise<TrustedPublicSourceReceipt> {
  const initialUrl = publicHttpsUrl(input.url);
  const fetched = await fetchPinnedHtml(initialUrl, Date.now() + FETCH_DEADLINE_MS);
  if (fetched.status !== 200) throw new PublicSourceFetchError(`Source page returned HTTP ${fetched.status || "error"}`);
  if (!new Set(["text/html", "application/xhtml+xml"]).has(fetched.contentType)) throw new PublicSourceFetchError("Source response is not HTML");
  const html = fetched.body.toString("utf8");
  const inspection = inspectStaticVacancyHtml(html, input.expectedTitle, input.expectedCompany);
  return trustedPublicSourceReceiptSchema.parse({
    receipt_id: randomUUID(),
    authority: "server_direct_fetch",
    task_id: input.taskId,
    attempt: input.attempt,
    initial_url: initialUrl.href,
    final_url: fetched.finalUrl.href,
    checked_at: (input.now ?? new Date()).toISOString(),
    http_status: 200,
    content_type: fetched.contentType,
    body_sha256: createHash("sha256").update(fetched.body).digest("hex"),
    body_bytes: fetched.body.length,
    expected_title: input.expectedTitle,
    expected_company: input.expectedCompany,
    static_html_vacancy_shaped: true,
    soft_closed: false,
    title_matched: true,
    company_matched: true,
    apply_signal: true,
    vacancy_section_signal_count: inspection.vacancySectionSignalCount,
  });
}
