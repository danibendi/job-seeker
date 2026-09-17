import { createHash } from "node:crypto";
import { slugify } from "./format";

export const COMPANY_NAME_MAX_LENGTH = 300;
export const COMPANY_SLUG_MAX_LENGTH = 240;

export function normalizeCompanyIdentity(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function companyDisplayName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function companyDisplayNameFitsStorage(value: string) {
  const length = companyDisplayName(value).length;
  return length >= 1 && length <= COMPANY_NAME_MAX_LENGTH;
}

/** Base slug preserves existing URLs; hash suffixes distinguish names that share that slug. */
export function companySlugCandidates(value: string) {
  const name = companyDisplayName(value);
  const base = slugify(name) || "company";
  const hash = createHash("sha256").update(normalizeCompanyIdentity(name)).digest("hex");
  return [base, ...[12, 20, 32, 64].map((length) => {
    const suffix = hash.slice(0, length);
    return `${base.slice(0, COMPANY_SLUG_MAX_LENGTH - suffix.length - 1)}-${suffix}`;
  })];
}
