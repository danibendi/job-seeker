import "server-only";
import { agentTasks } from "@/db/schema";
export function publicAgentTask(task: Omit<typeof agentTasks.$inferSelect, "claimTokenHash"> & { claimTokenHash?: string | null }) {
  const { claimTokenHash, ...visible } = task;
  void claimTokenHash;
  return visible;
}
