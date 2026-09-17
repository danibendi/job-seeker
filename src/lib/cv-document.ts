export type CvBlock =
  | { kind: "name"; text: string; raw: string }
  | { kind: "headline"; text: string; raw: string }
  | { kind: "contact"; text: string; raw: string }
  | { kind: "section"; text: string; raw: string }
  | { kind: "entry-title"; text: string; raw: string }
  | { kind: "entry-sub"; text: string; raw: string }
  | { kind: "competency"; label: string; text: string; raw: string }
  | { kind: "bullet"; text: string; raw: string }
  | { kind: "paragraph"; text: string; raw: string };

const HEADING = /^#{1,3}\s+(.+?)\s*#*$/;
const CONTACT = /(@|\+\d[\d\s()-]{6,}|linkedin\.com|\bwww\.|https?:\/\/)/i;
const YEAR = /\b(19|20)\d{2}\b|\bpresent\b|\bcurrent\b/i;
const EXPERIENCE = /experience|employment|career|history|positions|projects/i;
const COMPETENCY = /competenc|skills|expertise|tools|technolog/i;
const LISTLIKE = /education|certification|languages|awards|publications|training|volunteer/i;

function isEntryTitle(text: string, next: string | undefined) {
  if (!next || text.length > 110 || /[.:]$/.test(text)) return false;
  return /\s\|\s|\s[–—-]\s/.test(next) && YEAR.test(next);
}

export function parseCvDocument(content: string): CvBlock[] {
  const paragraphs = content.split(/\n\s*\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const blocks: CvBlock[] = [];
  let section: string | null = null;
  let seenName = false;
  let headlineDone = false;
  let index = 0;
  while (index < paragraphs.length) {
    const raw = paragraphs[index];
    const heading = raw.match(HEADING);
    if (heading) {
      if (!seenName) { blocks.push({ kind: "name", text: heading[1], raw }); seenName = true; }
      else { section = heading[1]; blocks.push({ kind: "section", text: heading[1], raw }); }
      index += 1;
      continue;
    }
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((line) => /^[-*•]\s+/.test(line))) {
      for (const line of lines) blocks.push({ kind: "bullet", text: line.replace(/^[-*•]\s+/, ""), raw: line });
      index += 1;
      continue;
    }
    const text = lines.join(" ");
    if (!section) {
      if (CONTACT.test(text)) blocks.push({ kind: "contact", text, raw });
      else if (!headlineDone) { blocks.push({ kind: "headline", text, raw }); headlineDone = true; }
      else blocks.push({ kind: "contact", text, raw });
      index += 1;
      continue;
    }
    if (/^[-*•]\s+/.test(text)) { blocks.push({ kind: "bullet", text: text.replace(/^[-*•]\s+/, ""), raw }); index += 1; continue; }
    if (EXPERIENCE.test(section)) {
      if (isEntryTitle(text, paragraphs[index + 1])) {
        blocks.push({ kind: "entry-title", text, raw });
        blocks.push({ kind: "entry-sub", text: paragraphs[index + 1].replace(/\s+/g, " "), raw: paragraphs[index + 1] });
        index += 2;
        continue;
      }
      blocks.push({ kind: "bullet", text, raw });
      index += 1;
      continue;
    }
    if (COMPETENCY.test(section)) {
      const match = text.match(/^([^:]{2,60}):\s+(.+)$/s);
      if (match) blocks.push({ kind: "competency", label: match[1], text: match[2], raw });
      else blocks.push({ kind: "bullet", text, raw });
      index += 1;
      continue;
    }
    if (LISTLIKE.test(section)) { blocks.push({ kind: "bullet", text, raw }); index += 1; continue; }
    blocks.push({ kind: "paragraph", text, raw });
    index += 1;
  }
  return blocks;
}

/** Accepts a bare Drive file id or a Drive/Docs share link and returns the file id, or null. */
export function driveFileId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{10,200}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname)) return null;
    const id = url.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? url.searchParams.get("id");
    return id && /^[a-zA-Z0-9_-]{10,200}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function cvDocumentUrls(input: string | null | undefined) {
  const id = driveFileId(input);
  return id ? { open: `https://drive.google.com/file/d/${id}/view`, preview: `https://drive.google.com/file/d/${id}/preview` } : null;
}
