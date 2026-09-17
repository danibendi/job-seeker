import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { automationRuns, eventsOutbox } from "@/db/schema";
import { bearerIsValid, unauthorized } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!bearerIsValid(request.headers.get("authorization"))) return unauthorized();
  const db = getDb();
  const runKey = `outbox_poller:${new Date().toISOString().slice(0, 10)}`;
  const [[row], [heartbeat]] = await Promise.all([
    db.select({ pending: sql<number>`count(*)::int` }).from(eventsOutbox).where(and(isNull(eventsOutbox.ackedAt))),
    db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.runKey, runKey)).limit(1),
  ]);
  return Response.json({ pending: row?.pending ?? 0, heartbeatNeeded: !heartbeat });
}
