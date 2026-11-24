/**
 * Executors whose every registered worker is paused. Queued work for them
 * cannot start until the owner resumes one; another available worker of the
 * same executor keeps its work moving.
 */
export function heldExecutors(
  pauses: ReadonlyArray<{ workerId: string; executor: string }>,
  registry: ReadonlyArray<{ id: string; executor: string }>,
) {
  const paused = new Set(pauses.map((pause) => pause.workerId));
  return [...new Set(pauses.map((pause) => pause.executor))].filter((executor) =>
    registry.filter((worker) => worker.executor === executor).every((worker) => paused.has(worker.id)));
}
