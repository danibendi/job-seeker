import { SaveForm } from "@/components/save-form";
import { Input, Select } from "@/components/ui/input";
import { saveAgentExecution } from "@/lib/actions";
import type { AgentExecutionSettingsRecord } from "@/lib/agent-tasks";
export function ExecutionForm({ settings }: { settings: AgentExecutionSettingsRecord }) {
  return <SaveForm action={saveAgentExecution} className="card card-pad settings-card">
    <h2>Who runs the work</h2>
    <p className="muted small">Choose independently for questions, collection, and LinkedIn evaluation. A connected worker starts assigned tasks. Questions can run without a discovery source; searches remain unavailable until you enable one below.</p>
    <div className="field-grid">{[{ key: "searchExecutor", label: "Searches and questions" }, { key: "evaluationExecutor", label: "LinkedIn evaluation" }].map(({ key, label }) => <div key={key}><label className="label" htmlFor={key}>{label}</label><Select id={key} name={key} defaultValue={settings[key as "searchExecutor" | "evaluationExecutor"]}><option value="unassigned">Choose later — keep queued</option><option value="api">Direct model API</option><option value="hermes">Hermes</option><option value="codex">Codex</option></Select></div>)}</div>
    <fieldset style={{ border: 0, padding: 0 }}><legend className="label">Sources</legend>{[{ id: "public", label: "Exploratory public web search (coverage not guaranteed)" }, { id: "linkedin", label: "LinkedIn" }].map(({ id, label }) => <label className="switch-row" key={id}><span>{label}</span><input type="checkbox" name="searchSources" value={id} defaultChecked={settings.searchSources.includes(id)} /></label>)}</fieldset>
    <div className="field-grid">{[{ key: "maxPages", label: "Page safety limit per search chunk", min: 1, max: 1000 }, { key: "maxDetailFetches", label: "Detail safety limit per search chunk", min: 0, max: 10000 }, { key: "maxDurationSeconds", label: "Run time limit per chunk (seconds)", min: 60, max: 7200 }].map(({ key, label, min, max }) => <div key={key}><label className="label" htmlFor={key}>{label}</label><Input id={key} name={key} type="number" min={min} max={max} required defaultValue={settings[key as "maxPages" | "maxDetailFetches" | "maxDurationSeconds"]} /></div>)}</div>
    <p className="small muted">LinkedIn starts each search configuration with the past 30 days, then checks the past day on later runs. Interrupted searches resume from their saved position. These chunk limits do not cap the number of eligible jobs saved.</p>
    <p className="small muted">The schedule needs a running scheduler and worker. LinkedIn also needs a working browser session on the chosen machine.</p>
  </SaveForm>;
}
