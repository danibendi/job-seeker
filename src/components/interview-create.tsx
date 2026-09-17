"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { addInterview } from "@/lib/actions";
import { InterviewFields } from "@/components/interview-fields";
import { Sheet } from "@/components/sheet";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";

export function InterviewCreate({ jobs, timeZone }: { jobs: { id: string; label: string }[]; timeZone?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button className="btn-primary btn-sm" type="button" onClick={() => setOpen(true)}><Plus aria-hidden />Add</Button>
    <Sheet open={open} onClose={() => setOpen(false)} title="Add interview" initialFocus="select">
      <form action={addInterview} className="field-group">
        <div><label className="label" htmlFor="new-interview-job">Role</label><Select id="new-interview-job" name="jobId" required defaultValue="">
          <option value="" disabled>Choose a role</option>
          {jobs.map((job) => <option value={job.id} key={job.id}>{job.label}</option>)}
        </Select></div>
        <InterviewFields idPrefix="new-interview" defaultTimeZone={timeZone} />
        <div className="sheet-actions"><Button className="btn-secondary" type="button" onClick={() => setOpen(false)}>Cancel</Button><SubmitButton className="btn-primary" pendingLabel="Creating…">Create</SubmitButton></div>
      </form>
    </Sheet>
  </>;
}
