/**
 * Executors that have registered workers, all of them paused. Queued work for
 * them cannot start until the owner resumes one; another available worker of
 * the same executor keeps its work moving. A pause left for an executor with
 * no registered worker does not count: resuming it would not start anything.
 */
export function heldExecutors(
  pauses: ReadonlyArray<{ workerId: string; executor: string }>,
  registry: ReadonlyArray<{ id: string; executor: string }>,
) {
  const paused = new Set(pauses.map((pause) => pause.workerId));
  return [...new Set(pauses.map((pause) => pause.executor))].filter((executor) => {
    const workers = registry.filter((worker) => worker.executor === executor);
    return workers.length > 0 && workers.every((worker) => paused.has(worker.id));
  });
}
