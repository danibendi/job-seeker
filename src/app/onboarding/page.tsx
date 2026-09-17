import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SaveForm } from "@/components/save-form";
import { Input, Select } from "@/components/ui/input";
import { saveWorkspaceProfile } from "@/lib/actions";
import { getWorkspace, workspaceCandidateLocked } from "@/lib/workspace";
import { timeZoneOptions } from "@/lib/time";

export const metadata: Metadata = { title: "Set up your workspace" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const workspace = await getWorkspace();
  const candidateLocked = await workspaceCandidateLocked(workspace.candidateId);
  const editing = (await searchParams).edit === "1";
  if (workspace.onboardingCompletedAt && !editing) redirect("/");
  return <div className="login-wrap">
    <div className="card card-pad settings-card" style={{ width: "min(100%, 620px)" }}>
      <div><div className="overline">Job Seeker</div><h1>{editing ? "Workspace identity" : "Make it yours"}</h1><p className="sub">This deployment is for one job seeker. These details stay in your database and are included in agent task context.</p></div>
      <SaveForm action={saveWorkspaceProfile} label={editing ? "Save workspace" : "Finish setup"} pendingLabel="Saving…">
        <div><label className="label" htmlFor="ownerName">Your name</label><Input id="ownerName" name="ownerName" defaultValue={workspace.ownerName} placeholder="Alex Morgan" required /></div>
        <div><label className="label" htmlFor="displayName">Workspace name</label><Input id="displayName" name="displayName" defaultValue={workspace.displayName} placeholder="Alex's job search" required /></div>
        <details><summary className="small">Advanced identity</summary><div style={{ marginTop: 10 }}><label className="label" htmlFor="candidateId">Candidate ID</label>{candidateLocked && <input type="hidden" name="candidateId" value={workspace.candidateId} />}<Input id="candidateId" name={candidateLocked ? undefined : "candidateId"} defaultValue={workspace.candidateId} pattern="[a-z0-9][a-z0-9._-]*" disabled={candidateLocked} required={!candidateLocked} /><p className="small muted">This installation generated a stable isolation ID. {candidateLocked ? "It is locked because collected jobs or agent tasks already use it." : "You usually do not need to change it."}</p></div></details>
        <div><label className="label" htmlFor="assistantLabel">Assistant label</label><Input id="assistantLabel" name="assistantLabel" defaultValue={workspace.assistantLabel} placeholder="Assistant" required /></div>
        <div className="field-grid">
          <div><label className="label" htmlFor="locale">Locale</label><Input id="locale" name="locale" defaultValue={workspace.locale} placeholder="en" required /></div>
          <div><label className="label" htmlFor="timeZone">Time zone</label><Select id="timeZone" name="timeZone" defaultValue={workspace.timeZone}>{timeZoneOptions().map((zone) => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}</Select></div>
        </div>
      </SaveForm>
    </div>
  </div>;
}
