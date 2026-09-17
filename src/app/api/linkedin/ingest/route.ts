import { getDb } from "@/db";
import { collectorBearerIsValid, unauthorized } from "@/lib/api-auth";
import { linkedinIngestBatchSchema } from "@/lib/linkedin-ingestion";
import { ingestLinkedinBatch } from "@/lib/linkedin-store";
import { readWorkerJson, workerError, WorkerHttpError } from "@/lib/worker-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  if (!collectorBearerIsValid(request.headers.get("authorization"))) return unauthorized();
  try {
    const batch = linkedinIngestBatchSchema.parse(await readWorkerJson(request));
    if (request.headers.get("idempotency-key")?.trim() !== batch.runKey) throw new WorkerHttpError("Idempotency-Key must match runKey", 400);
    const result = await getDb().transaction((tx) => ingestLinkedinBatch(batch, tx));
    return Response.json(result, { status: result.idempotentReplay ? 200 : 202 });
  } catch (error) { return workerError(error); }
}
