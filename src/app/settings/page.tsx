import type { Metadata } from "next";
import Link from "next/link";
import { AppBar } from "@/components/app-bar";
import { SaveForm } from "@/components/save-form";
import { LocationsForm } from "@/components/settings/locations-form";
import { ExecutionForm } from "@/components/settings/execution-form";
import { getAgentExecutionSettings } from "@/lib/agent-tasks";
import { ScheduleForm } from "@/components/settings/schedule-form";
import { TokenField } from "@/components/settings/token-field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { saveGeneralSettings, saveSearchPreferences, updateNotificationPreferences } from "@/lib/actions";
import { getSettingsData, isSearchQueued } from "@/lib/data";
import { LIMITS } from "@/lib/settings";
import { timeZoneOptions } from "@/lib/time";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "general", label: "General" },
  { id: "search", label: "Search" },
  { id: "locations", label: "Where" },
  { id: "schedule", label: "Schedule" },
  { id: "notifications", label: "Notifications" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const TELEGRAM = [
  { name: "highFitJobs", label: "New high-fit roles" },
  { name: "dailySummary", label: "Search summary after each run" },
  { name: "weeklyDigest", label: "Weekly digest" },
  { name: "tailoringReady", label: "CV suggestions ready" },
  { name: "requestAnswered", label: "Assistant answered a question" },
  { name: "interviewReminders", label: "Interview reminders" },
  { name: "followUpsDue", label: "Follow-ups due" },
  { name: "watchlistFindings", label: "Watchlist findings" },
  { name: "automationFailures", label: "Automation hit a problem" },
] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const requested = (await searchParams).tab;
  const tab: Tab = TABS.some((option) => option.id === requested) ? requested as Tab : "general";
  const [{ settings, preferences, target, timeZone }, searchQueued, execution] = await Promise.all([getSettingsData(), tab === "schedule" ? isSearchQueued() : Promise.resolve(false), tab === "schedule" ? getAgentExecutionSettings() : Promise.resolve(null)]);

  return <>
    <AppBar title="Settings" back="/more" />
    <div className="scroller settings-tabs" role="tablist" aria-label="Section">{TABS.map((option) => <Link key={option.id} role="tab" aria-selected={tab === option.id} className={`seg ${tab === option.id ? "active" : ""}`} href={option.id === "general" ? "/settings" : `/settings?tab=${option.id}`}>{option.label}</Link>)}</div>

    {tab === "general" && <SaveForm action={saveGeneralSettings} className="card card-pad settings-card">
      <h2>General</h2>
      <p className="small muted">Edit the workspace name, owner, assistant label, locale, and stable candidate ID in <Link className="link" href="/onboarding?edit=1">Workspace identity</Link>.</p>
      <div><label className="label" htmlFor="tz">Time zone</label><Select id="tz" name="timeZone" defaultValue={timeZone}>{timeZoneOptions().map((zone) => <option value={zone} key={zone}>{zone.replaceAll("_", " ")}</option>)}</Select></div>
      <div className="field-grid">
        <div><label className="label" htmlFor="apps">Applications per week</label><Input id="apps" type="number" name="applicationsTarget" min={0} max={50} inputMode="numeric" defaultValue={target?.applicationsTarget ?? 3} required /></div>
        <div><label className="label" htmlFor="convs">Recruiter conversations per week</label><Input id="convs" type="number" name="conversationsTarget" min={0} max={50} inputMode="numeric" defaultValue={target?.conversationsTarget ?? 2} required /></div>
        <div><label className="label" htmlFor="followup">Follow up after (days)</label><Input id="followup" type="number" name="followUpDays" min={1} max={90} inputMode="numeric" defaultValue={settings.followUpDays} required /></div>
      </div>
    </SaveForm>}

    {tab === "search" && <SaveForm action={saveSearchPreferences} className="card card-pad settings-card">
      <h2>What to look for</h2>
      <TokenField name="targetRoles" label="Target roles" initial={settings.targetRoles} limit={LIMITS.roles} placeholder="Technical programme manager" />
      <div>
        <div className="between"><label className="label" htmlFor="min-fit" style={{ margin: 0 }}>Minimum fit score</label><output className="score sm good" htmlFor="min-fit">{settings.minimumFitScore}</output></div>
        <input id="min-fit" className="range" type="range" name="minimumFitScore" min={0} max={100} step={5} defaultValue={settings.minimumFitScore} style={{ marginTop: 8 }} />
      </div>
      <TokenField name="languages" label="Languages I can work in" initial={settings.languages} limit={LIMITS.languages} placeholder="English" />
      <TokenField name="excludedCompanies" label="Skip these companies" initial={settings.excludedCompanies} limit={LIMITS.companies} placeholder="Company name" />
      <TokenField name="excludedKeywords" label="Roles to exclude" initial={settings.excludedKeywords} limit={LIMITS.keywords} placeholder="Essential hands-on ML research" />
      <div><label className="label" htmlFor="notes">Additional role preferences <span className="opt">optional</span></label><Textarea id="notes" name="notesMd" defaultValue={settings.notesMd ?? ""} style={{ minHeight: 64 }} /><p className="small muted">Use Where for locations and work arrangements. The language and minimum-score settings above apply directly.</p></div>
    </SaveForm>}

    {tab === "locations" && <LocationsForm locations={settings.locations} workModes={settings.workModes} remote={settings.remote} />}

    {tab === "schedule" && <div className="stack"><ScheduleForm schedule={settings.schedule} tailorCvSuggestions={settings.tailorCvSuggestions} timeZone={timeZone} searchQueued={searchQueued} />{execution && <ExecutionForm settings={execution} />}</div>}

    {tab === "notifications" && <SaveForm action={updateNotificationPreferences} className="card card-pad settings-card">
      <h2>Notifications</h2>
      <p className="small muted">Delivery requires a separately configured notification integration. New installations start with every notification disabled.</p>
      <div>{TELEGRAM.map((item) => <label className="switch-row" key={item.name}><span className="switch-text">{item.label}</span><span className="switch"><input type="checkbox" name={item.name} defaultChecked={preferences[item.name]} /><span /></span></label>)}</div>
      <div className="field-grid">
        <div><label className="label" htmlFor="notify-min">High-fit means a score of at least</label><Input id="notify-min" type="number" name="minimumFitScore" min={0} max={100} inputMode="numeric" defaultValue={preferences.minimumFitScore} required /></div>
        <div><label className="label" htmlFor="remind">Remind me before an interview</label><Select id="remind" name="interviewReminderHours" defaultValue={String(preferences.interviewReminderHours)}>{[1, 2, 3, 6, 12, 24, 48].map((hours) => <option value={hours} key={hours}>{hours === 1 ? "1 hour" : hours < 24 ? `${hours} hours` : hours === 24 ? "1 day" : "2 days"} before</option>)}</Select></div>
      </div>
    </SaveForm>}
  </>;
}
