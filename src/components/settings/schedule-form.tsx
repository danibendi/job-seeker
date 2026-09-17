"use client";

import { useState } from "react";
import { saveScheduleSettings } from "@/lib/actions";
import { SCHEDULE_FREQUENCIES, WEEKDAYS, scheduleSummary, type SearchSchedule } from "@/lib/settings";
import { SaveForm } from "@/components/save-form";
import { SearchNow } from "@/components/search-now";
import { Input, Select } from "@/components/ui/input";

type Props = { schedule: SearchSchedule; tailorCvSuggestions: boolean; timeZone: string; searchQueued: boolean };

export function ScheduleForm({ schedule: initial, tailorCvSuggestions, timeZone, searchQueued }: Props) {
  const [schedule, setSchedule] = useState(initial);
  const pickDays = schedule.frequency === "weekly" || schedule.frequency === "custom";
  return <SaveForm action={saveScheduleSettings} className="card card-pad settings-card" footer={<SearchNow queued={searchQueued} />}>
    <div className="between"><h2>Search schedule</h2><span className="pill outline">{scheduleSummary(schedule, timeZone)}</span></div>
    <label className="switch-row" style={{ borderTop: 0 }}><span className="switch-text">Scheduled searches</span><span className="switch"><input type="checkbox" name="enabled" checked={schedule.enabled} onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })} /><span /></span></label>
    <div className="field-grid">
      <div><label className="label" htmlFor="frequency">How often</label><Select id="frequency" name="frequency" value={schedule.frequency} onChange={(event) => setSchedule({ ...schedule, frequency: event.target.value as SearchSchedule["frequency"], days: event.target.value === "weekly" ? schedule.days.slice(0, 1) : schedule.days })}>{SCHEDULE_FREQUENCIES.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</Select></div>
      <div><label className="label" htmlFor="time">At <span className="opt">{timeZone.replaceAll("_", " ")}</span></label><Input id="time" name="time" type="time" required value={schedule.time} onChange={(event) => setSchedule({ ...schedule, time: event.target.value })} /></div>
      {pickDays && <div className="wide">
        <span className="label">{schedule.frequency === "weekly" ? "Day" : "Days"}</span>
        <div className="day-picks">{WEEKDAYS.map((day) => <label className="chip-toggle" key={day.id}><input type={schedule.frequency === "weekly" ? "radio" : "checkbox"} name="days" value={day.id} checked={schedule.days.includes(day.id)} onChange={() => setSchedule({ ...schedule, days: schedule.frequency === "weekly" ? [day.id] : schedule.days.includes(day.id) ? schedule.days.filter((item) => item !== day.id) : [...schedule.days, day.id] })} /><span>{day.label}</span></label>)}</div>
      </div>}
      <div><label className="label" htmlFor="max-jobs">Public roles saved per search, at most</label><Input id="max-jobs" name="maxJobs" type="number" inputMode="numeric" min={1} max={100} required defaultValue={schedule.maxJobs} /><p className="small muted" style={{ marginTop: 6 }}>LinkedIn keeps every eligible evaluated role.</p></div>
    </div>
    <label className="switch-row" style={{ borderTop: 0 }}><span className="switch-text">Prepare CV suggestions for shortlisted roles</span><span className="switch"><input type="checkbox" name="tailorCvSuggestions" defaultChecked={tailorCvSuggestions} /><span /></span></label>
  </SaveForm>;
}
