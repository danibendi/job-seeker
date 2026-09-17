import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Video } from "lucide-react";
import { AppBar } from "@/components/app-bar";
import { AskAssistant } from "@/components/ask-assistant";
import { Disclosure } from "@/components/disclosure";
import { InterviewFields } from "@/components/interview-fields";
import { Markdown } from "@/components/markdown";
import { QaList } from "@/components/qa-list";
import { SubmitButton } from "@/components/submit-button";
import { Input, Textarea } from "@/components/ui/input";
import { addInterviewer, saveInterviewPrep, updateInterview } from "@/lib/actions";
import { getInterviewDetail } from "@/lib/data";
import { formatDateTimeInput, formatTime, formatWeekday, humanize } from "@/lib/format";
import { safeHttpUrl } from "@/lib/safe-url";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const data = await getInterviewDetail((await params).id);
  return { title: data ? `Interview · ${data.company.name}` : "Interview" };
}

const defaultChecklist = [
  { id: "research", label: "Review the company and interviewer brief", done: false },
  { id: "stories", label: "Choose two STAR examples", done: false },
  { id: "questions", label: "Prepare questions to ask", done: false },
  { id: "tech", label: "Test the meeting link, camera, and audio", done: false },
  { id: "followup", label: "Plan the post-interview thank-you note", done: false },
];

export default async function InterviewPage({ params }: { params: Promise<{ id: string }> }) {
  const id = (await params).id;
  const data = await getInterviewDetail(id);
  if (!data) notFound();
  const { interview, job, company } = data;
  const localSchedule = formatDateTimeInput(interview.scheduledAt, interview.timeZone);
  const meetingUrl = safeHttpUrl(interview.locationOrLink);
  const checklist = interview.checklist.length ? interview.checklist : defaultChecklist;
  const doneCount = checklist.filter((item) => item.done).length;
  const brief = data.briefs[0];
  const suggestions = [
    `How does ${company.name} usually run a ${humanize(interview.stage).toLowerCase()}?`,
    "Which three questions am I most likely to get?",
    "What should I ask them at the end?",
    "Summarise the role in five bullet points for my prep",
  ];

  return <>
    <AppBar title={company.name} back={`/jobs/${job.id}`} />
    <section className="hero">
      <div className="overline">{humanize(interview.stage)} · {humanize(interview.outcome)}</div>
      <h1 style={{ marginTop: 6 }}>{formatWeekday(interview.scheduledAt, interview.timeZone)}, {formatTime(interview.scheduledAt, interview.timeZone)}</h1>
      <p className="sub">{job.title} · {interview.timeZone}</p>
      <div className="cluster" style={{ marginTop: 14 }}>
        {meetingUrl ? <a className="btn btn-primary btn-sm" href={meetingUrl} target="_blank" rel="noreferrer"><Video aria-hidden />Join</a> : interview.locationOrLink ? <span className="pill">{interview.locationOrLink}</span> : null}
        <Link className="btn btn-secondary btn-sm" href={`/jobs/${job.id}`}>Open role</Link>
      </div>
    </section>

    <section className="section">
      <form action={saveInterviewPrep} className="card card-pad stack" style={{ gap: 12 }}>
        <input type="hidden" name="interviewId" value={id} />
        <div className="between"><h2 style={{ fontSize: 17 }}>Prep</h2><span className="pill brand">{doneCount}/{checklist.length}</span></div>
        <div>{checklist.map((item) => <label className="check" key={item.id}><input type="checkbox" name="checklist" value={item.id} defaultChecked={item.done} /><span>{item.label}</span></label>)}</div>
        <div><label className="label" htmlFor="questions">Questions to ask</label><Textarea id="questions" name="questionsMd" defaultValue={interview.questionsMd ?? ""} placeholder={"What does success look like after 90 days?"} style={{ minHeight: 72 }} /></div>
        <div><label className="label" htmlFor="post-notes">Afterwards</label><Textarea id="post-notes" name="postInterviewNotesMd" defaultValue={interview.postInterviewNotesMd ?? ""} placeholder="What stood out, what to follow up on" style={{ minHeight: 72 }} /></div>
        <div><SubmitButton className="btn-primary btn-sm" pendingLabel="Saving…">Save</SubmitButton></div>
      </form>
    </section>

    <section className="section">
      <div className="section-head"><h2>Assistant brief</h2></div>
      {brief ? <Disclosure title="Read the brief" open><Markdown content={brief.contentMd} /></Disclosure> : <div className="card card-pad small muted">No brief has been written yet.</div>}
    </section>

    <section className="section">
      <div className="section-head"><h2>People</h2></div>
      {data.interviewers.length > 0 && <div style={{ marginBottom: 8 }}>{data.interviewers.map((person) => {
        const profileUrl = safeHttpUrl(person.linkedinUrl);
        return <Disclosure key={person.id} title={person.name} meta={person.roleTitle ?? undefined}>
          {profileUrl && <a className="link small" href={profileUrl} target="_blank" rel="noreferrer">Profile <ExternalLink size={12} style={{ display: "inline", verticalAlign: -1 }} aria-hidden /></a>}
          <Markdown className="compact" content={person.researchMd} fallback="No research has been saved for this person." />
        </Disclosure>;
      })}</div>}
      <Disclosure title="Add a person">
        <form action={addInterviewer} className="field-grid">
          <input type="hidden" name="interviewId" value={id} />
          <div><label className="label" htmlFor="person-name">Name</label><Input id="person-name" name="name" required /></div>
          <div><label className="label" htmlFor="person-role">Role <span className="opt">optional</span></label><Input id="person-role" name="roleTitle" /></div>
          <div className="wide"><label className="label" htmlFor="person-url">Profile URL <span className="opt">optional</span></label><Input id="person-url" name="linkedinUrl" type="url" /></div>
          <div className="wide"><SubmitButton className="btn-primary btn-sm" pendingLabel="Adding…">Add</SubmitButton></div>
        </form>
      </Disclosure>
    </section>

    <section className="section">
      <div className="section-head"><h2>Ask assistant</h2></div>
      <div className="card card-pad stack" style={{ gap: 12 }}>
        <AskAssistant jobId={job.id} suggestions={suggestions} placeholder="Ask something specific about this interview" />
        <QaList requests={data.requests.filter((request) => !/^Tailor my CV/i.test(request.text))} limit={4} />
      </div>
    </section>

    <section className="section">
      <Disclosure title="Edit or reschedule">
        <form action={updateInterview}>
          <input type="hidden" name="interviewId" value={id} />
          <InterviewFields idPrefix="edit-interview" includeOutcome defaults={{ stage: interview.stage, scheduledLocal: localSchedule, timeZone: interview.timeZone, locationOrLink: interview.locationOrLink, notesMd: interview.notesMd, outcome: interview.outcome }} />
          <div style={{ marginTop: 12 }}><SubmitButton className="btn-primary btn-sm" pendingLabel="Saving…">Save changes</SubmitButton></div>
        </form>
      </Disclosure>
    </section>
  </>;
}
