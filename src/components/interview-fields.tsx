import { Input, Select, Textarea } from "@/components/ui/input";
import { humanize } from "@/lib/format";
import {
  DEFAULT_INTERVIEW_TIME_ZONE,
  INTERVIEW_OUTCOMES,
  INTERVIEW_STAGES,
  INTERVIEW_TIME_ZONE_OPTIONS,
} from "@/lib/interview-workflow";

type Props = {
  defaults?: {
    stage?: string;
    scheduledLocal?: string;
    timeZone?: string;
    locationOrLink?: string | null;
    notesMd?: string | null;
    outcome?: string;
  };
  includeOutcome?: boolean;
  idPrefix?: string;
  defaultTimeZone?: string;
};

export function InterviewFields({ defaults = {}, includeOutcome = false, idPrefix = "interview", defaultTimeZone }: Props) {
  const timeZone = defaults.timeZone ?? defaultTimeZone ?? DEFAULT_INTERVIEW_TIME_ZONE;
  return <div className="field-grid">
    <div><label className="label" htmlFor={`${idPrefix}-stage`}>Stage</label><Select id={`${idPrefix}-stage`} name="stage" defaultValue={defaults.stage ?? "recruiter_screen"} required>{INTERVIEW_STAGES.map((stage) => <option value={stage} key={stage}>{humanize(stage)}</option>)}</Select></div>
    <div><label className="label" htmlFor={`${idPrefix}-when`}>Date and time</label><Input id={`${idPrefix}-when`} name="scheduledLocal" type="datetime-local" defaultValue={defaults.scheduledLocal} required /></div>
    <div><label className="label" htmlFor={`${idPrefix}-tz`}>Time zone</label><Input id={`${idPrefix}-tz`} name="timeZone" list={`${idPrefix}-time-zones`} defaultValue={timeZone} autoComplete="off" required /><datalist id={`${idPrefix}-time-zones`}>{[...new Set([timeZone, ...INTERVIEW_TIME_ZONE_OPTIONS])].map((zone) => <option value={zone} key={zone} />)}</datalist></div>
    <div><label className="label" htmlFor={`${idPrefix}-where`}>Link or address <span className="opt">optional</span></label><Input id={`${idPrefix}-where`} name="locationOrLink" defaultValue={defaults.locationOrLink ?? ""} placeholder="https://… or office address" /></div>
    {includeOutcome && <div><label className="label" htmlFor={`${idPrefix}-outcome`}>Outcome</label><Select id={`${idPrefix}-outcome`} name="outcome" defaultValue={defaults.outcome ?? "pending"} required>{INTERVIEW_OUTCOMES.map((outcome) => <option value={outcome} key={outcome}>{humanize(outcome)}</option>)}</Select></div>}
    <div className="wide"><label className="label" htmlFor={`${idPrefix}-notes`}>Notes <span className="opt">optional</span></label><Textarea id={`${idPrefix}-notes`} name="notesMd" defaultValue={defaults.notesMd ?? ""} placeholder="Agenda, contact, anything to remember" style={{ minHeight: 72 }} /></div>
  </div>;
}
