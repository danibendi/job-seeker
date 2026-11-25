#!/usr/bin/env node
/**
 * Queue the fictional LinkedIn evaluation cases into a running demo installation.
 *
 * The listings go through the app's real collector endpoint, which stores each
 * snapshot and queues one `linkedin_evaluate` task for the configured
 * evaluation executor. Use only a disposable database seeded with the
 * fictional demo workspace. Nothing here starts a worker, model or browser.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

const DEMO_CANDIDATE = "demo-alex-morgan";
const CONFIRMATION = "I_UNDERSTAND_THIS_REQUIRES_THE_FICTIONAL_DEMO_DATABASE";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class DemoEvaluationError extends Error {}

function requireSettings() {
  if (process.env.JOB_SEEKER_DEMO_EVALUATIONS !== CONFIRMATION) {
    throw new DemoEvaluationError(`Set JOB_SEEKER_DEMO_EVALUATIONS=${CONFIRMATION} to queue the fictional evaluation cases.`);
  }
  if (process.env.JOB_SEEKER_DISPOSABLE_DATABASE !== "true") {
    throw new DemoEvaluationError("Set JOB_SEEKER_DISPOSABLE_DATABASE=true only for a disposable demo database.");
  }
  const appUrl = new URL(process.env.JOB_SEEKER_DEMO_URL ?? "http://127.0.0.1:3000");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname)) {
    throw new DemoEvaluationError("The demo application must run on loopback.");
  }
  const token = process.env.LINKEDIN_COLLECTOR_TOKEN;
  if (!process.env.DATABASE_URL || !token) {
    throw new DemoEvaluationError("DATABASE_URL and LINKEDIN_COLLECTOR_TOKEN must come from the demo's protected environment file.");
  }
  return { appUrl, token };
}

export function ingestBatch(cases, { candidateId, runKey, observedAt }) {
  return {
    schemaVersion: 1,
    candidateId,
    runKey,
    generatedAt: observedAt,
    items: cases.map((item, index) => ({
      candidateId,
      source: "linkedin",
      jobId: item.listing.jobId,
      canonicalUrl: `https://www.linkedin.com/jobs/view/${item.listing.jobId}/`,
      title: item.listing.title,
      company: item.listing.company,
      location: item.listing.location,
      workMode: item.listing.workMode,
      lane: "fictional-demo",
      resultRank: index + 1,
      collectorRunKey: runKey,
      firstObservedAt: observedAt,
      funnelState: "snapshot_ready",
      snapshot: {
        description: item.snapshot.description,
        sourceUrl: `https://www.linkedin.com/jobs/view/${item.listing.jobId}/`,
        workModeText: item.listing.workMode,
        closed: false,
        fictional: true,
      },
      titleDecision: { decision: "defer_to_evaluator", method: "fictional_fixture" },
      detailDecision: { decision: "evaluate_full_evidence", method: "fictional_fixture" },
    })),
  };
}

async function main() {
  const { appUrl, token } = requireSettings();
  const corpus = JSON.parse(await readFile(path.join(root, "examples/demo/linkedin-evaluation-cases.json"), "utf8"));
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [workspace] = await sql`select candidate_id from workspaces where id = 'owner'`;
    if (workspace?.candidate_id !== DEMO_CANDIDATE) {
      throw new DemoEvaluationError("Refused: this database does not hold the fictional demo workspace.");
    }
    const [execution] = await sql`select evaluation_executor from agent_execution_settings where id = 'owner'`;
    const observedAt = new Date().toISOString();
    const batch = ingestBatch(corpus.cases, { candidateId: DEMO_CANDIDATE, runKey: `demo-evaluations:${observedAt}`, observedAt });
    const response = await fetch(new URL("/api/linkedin/ingest", appUrl), {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": batch.runKey },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new DemoEvaluationError(`The app refused the fictional batch (HTTP ${response.status}).`);
    console.log(JSON.stringify({
      queuedEvaluationTasks: Array.isArray(body.evaluationTaskIds) ? body.evaluationTaskIds.length : 0,
      evaluationExecutor: execution?.evaluation_executor ?? "unassigned",
      cases: corpus.cases.map((item) => ({ id: item.id, title: item.listing.title, expected: item.reference.status })),
    }, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof DemoEvaluationError ? error.message : "Queuing the fictional evaluations failed; no credentials or database details were printed.");
    process.exitCode = 1;
  });
}
