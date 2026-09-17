function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Normalize the provider's explicit application status, including legacy captures.
 * Description prose remains evidence for the evaluator, not a status keyword scan.
 */
export function linkedinSnapshotIsClosed(snapshot: unknown): boolean {
  const evidence = record(record(snapshot)?.snapshotEvidence);
  if (evidence?.closed === true) return true;
  return typeof evidence?.applicantMetadata === "string"
    && /\bno longer accepting applications\b/i.test(evidence.applicantMetadata);
}

export function prepareLinkedinSnapshot(snapshot: unknown): unknown {
  const source = record(snapshot);
  if (!source || !linkedinSnapshotIsClosed(source)) return snapshot;
  return { ...source, snapshotEvidence: { ...record(source.snapshotEvidence), closed: true } };
}
