export type FeedbackReasonRow = {
  reasons: string[] | null;
};

export function aggregateFeedbackReasons(rows: FeedbackReasonRow[]) {
  const counts = new Map<string, number>();

  for (const row of rows) {
    for (const rawReason of row.reasons ?? []) {
      const reason = rawReason.trim();
      if (!reason) continue;
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  return Array.from(counts, ([reason, count]) => ({ reason, count })).sort(
    (left, right) => right.count - left.count || left.reason.localeCompare(right.reason),
  );
}
