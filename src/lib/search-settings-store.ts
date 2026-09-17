import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { searchSettings } from "@/db/schema";
import { settingsFromRow } from "@/lib/data";
import { stableJsonHash } from "@/lib/agent-task-contract";
import { DEFAULT_SEARCH_SETTINGS, effectiveSearchPolicy, type EffectiveSearchPolicy, type SearchSettingsValues } from "@/lib/settings";
import { WORKSPACE_ID } from "@/lib/workspace-values";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Creates the canonical row when necessary, then locks it for the transaction.
 * Policy admission and settings writers use this as their common serialization point.
 */
export async function lockSearchSettings(tx: Tx): Promise<SearchSettingsValues> {
  await tx.insert(searchSettings).values({ id: WORKSPACE_ID, ...DEFAULT_SEARCH_SETTINGS }).onConflictDoNothing({ target: searchSettings.id });
  const [row] = await tx.select().from(searchSettings).where(eq(searchSettings.id, WORKSPACE_ID)).for("update").limit(1);
  if (!row) throw new Error("Search settings row could not be locked");
  return settingsFromRow(row);
}

export type EffectiveSearchPolicySnapshot = {
  settings: SearchSettingsValues;
  effectivePolicy: EffectiveSearchPolicy;
  policyHash: string;
};

function policySnapshot(settings: SearchSettingsValues): EffectiveSearchPolicySnapshot {
  const effectivePolicy = effectiveSearchPolicy(settings);
  return { settings, effectivePolicy, policyHash: stableJsonHash(effectivePolicy) };
}

export async function loadEffectiveSearchPolicy(tx: Tx): Promise<EffectiveSearchPolicySnapshot> {
  const [row] = await tx.select().from(searchSettings).where(eq(searchSettings.id, WORKSPACE_ID)).limit(1);
  return policySnapshot(settingsFromRow(row));
}

export async function lockEffectiveSearchPolicy(tx: Tx): Promise<EffectiveSearchPolicySnapshot> {
  return policySnapshot(await lockSearchSettings(tx));
}
