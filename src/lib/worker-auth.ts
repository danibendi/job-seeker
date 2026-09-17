import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { derivedHermesCredentials, DERIVED_HERMES_WORKER_ID } from "./derived-worker-auth";

const workerSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/),
  executor: z.enum(["hermes", "codex", "api"]),
  token: z.string().min(32),
});
export type WorkerIdentity = z.infer<typeof workerSchema>;

export function workerRegistry(): WorkerIdentity[] {
  const derived = derivedHermesCredentials();
  const ownerTokens = [process.env.OWNER_MCP_TOKEN, process.env.HERMES_API_TOKEN]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim()).filter(Boolean);
  if (process.env.COMPASS_WORKERS_JSON === undefined) {
    if (!derived.length) return [];
    if (derived.some(value => value.worker === process.env.COMPASS_SCHEDULER_TOKEN)) throw new Error("Invalid worker configuration");
    return [{ id: DERIVED_HERMES_WORKER_ID, executor: "hermes", token: derived[0].worker }];
  }
  try {
    const workers = z.array(workerSchema).max(30).parse(JSON.parse(process.env.COMPASS_WORKERS_JSON));
    const tokens = workers.map((worker) => worker.token);
    if (new Set(workers.map((worker) => worker.id)).size !== workers.length || new Set(tokens).size !== tokens.length || tokens.includes(process.env.COMPASS_SCHEDULER_TOKEN ?? "") || tokens.some((token) => ownerTokens.includes(token)) || derived.some(value => tokens.includes(value.scheduler))) throw new Error();
    return workers;
  } catch { throw new Error("Invalid worker configuration"); }
}

export function bearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}

function matches(a: string, b: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

export function authenticateWorker(request: Request) {
  const token = bearerToken(request);
  if (!token) return null;
  const registry = workerRegistry();
  if (process.env.COMPASS_WORKERS_JSON === undefined && registry.length && derivedHermesCredentials().some(value => matches(token, value.worker))) {
    return { id: DERIVED_HERMES_WORKER_ID, executor: "hermes" as const, token };
  }
  return registry.find((worker) => matches(token, worker.token)) ?? null;
}

export function authenticateScheduler(request: Request) {
  workerRegistry();
  const token = bearerToken(request);
  const configured = process.env.COMPASS_SCHEDULER_TOKEN;
  const ownerTokens = [process.env.OWNER_MCP_TOKEN, process.env.HERMES_API_TOKEN]
    .flatMap((value) => (value ?? "").split(",")).map((value) => value.trim()).filter(Boolean);
  if (configured !== undefined) return Boolean(token && configured.length >= 32 && !ownerTokens.includes(configured) && matches(token, configured));
  return Boolean(token && derivedHermesCredentials().some(value => matches(token, value.scheduler)));
}

export class WorkerHttpError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

export async function readWorkerJson(request: Request, maxBytes = 1_500_000) {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new WorkerHttpError("Payload too large", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw new WorkerHttpError("Payload too large", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(body); } catch { throw new WorkerHttpError("Invalid JSON", 400); }
}

export function workerError(error: unknown) {
  if (error instanceof WorkerHttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError) return Response.json({ error: "Invalid input", issues: error.issues }, { status: 400 });
  // Service errors describe task conflicts. Never return database queries or connection details.
  const message = error instanceof Error ? error.message : "";
  if (/not found|lease|claim|not .*running|cannot|conflict|expired|attempt|already|result|status|retry|cancel|snapshot|evaluation/i.test(message) && !/query:|postgres|select |insert |update /i.test(message)) {
    return Response.json({ error: message.slice(0, 400) }, { status: 409 });
  }
  return Response.json({ error: "Worker operation failed" }, { status: 500 });
}
