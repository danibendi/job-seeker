import { WORKER_OFFLINE_MS } from "./assistant-status";

/**
 * Executors that have registered workers and no online, unpaused worker to
 * claim their work (when contact records are supplied; otherwise every
 * registered worker is paused). Queued work for them cannot start until a
 * paused worker is resumed or an offline sibling returns; another online,
 * unpaused worker of the same executor keeps its work moving. A pause left for
 * an executor with no registered worker does not count: resuming it would not
 * start anything.
 */
export function heldExecutors(
  pauses: ReadonlyArray<{ workerId: string; executor: string }>,
  registry: ReadonlyArray<{ id: string; executor: string }>,
  contacts?: ReadonlyArray<{ workerId: string; lastSeenAt: Date }>,
  now = new Date(),
) {
  const paused = new Set(pauses.map((pause) => pause.workerId));
  const contactByWorker = contacts
    ? new Map(contacts.map((contact) => [contact.workerId, contact.lastSeenAt]))
    : null;
  const isOnline = (workerId: string) => {
    if (!contactByWorker) return true;
    const lastSeenAt = contactByWorker.get(workerId);
    return lastSeenAt !== undefined && now.getTime() - lastSeenAt.getTime() < WORKER_OFFLINE_MS;
  };
  return [...new Set(pauses.map((pause) => pause.executor))].filter((executor) => {
    const workers = registry.filter((worker) => worker.executor === executor);
    return workers.length > 0 && !workers.some((worker) => !paused.has(worker.id) && isOnline(worker.id));
  });
}
