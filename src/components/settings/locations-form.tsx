"use client";

import { useState } from "react";
import { MapPin, Plus, X } from "lucide-react";
import { saveLocationSettings } from "@/lib/actions";
import { COUNTRY_OPTIONS, MAJOR_CITIES, countryName } from "@/lib/geography";
import { LIMITS, WORK_MODES, type OfficeLocation, type RemoteSearchLocation, type RemoteSettings } from "@/lib/settings";
import { SaveForm } from "@/components/save-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";

type Props = { locations: OfficeLocation[]; workModes: string[]; remote: RemoteSettings };

function CountrySelect({ value, onChange, label, id }: { value: string; onChange: (value: string) => void; label: string; id?: string }) {
  return <Select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
    <option value="">Country</option>
    {COUNTRY_OPTIONS.map((country) => <option value={country.code} key={country.code}>{country.name}</option>)}
  </Select>;
}

export function LocationsForm({ locations: initialLocations, workModes, remote: initialRemote }: Props) {
  const [locations, setLocations] = useState(initialLocations);
  const [draft, setDraft] = useState<OfficeLocation>({ city: "", country: "", radiusKm: 30 });
  const [customCity, setCustomCity] = useState(false);
  const [remote, setRemote] = useState(initialRemote);
  const [remoteSearchLocations, setRemoteSearchLocations] = useState<RemoteSearchLocation[]>(
    initialRemote.searchLocations?.length
      ? initialRemote.searchLocations
      : initialLocations.map(({ city, country }) => ({ city, country })),
  );
  const [remoteDraft, setRemoteDraft] = useState<RemoteSearchLocation>({ city: "", country: "" });
  const [customRemoteCity, setCustomRemoteCity] = useState(false);
  const cities = draft.country ? MAJOR_CITIES[draft.country] ?? [] : [];
  const remoteCities = remoteDraft.country ? MAJOR_CITIES[remoteDraft.country] ?? [] : [];
  const canAdd = Boolean(draft.city.trim() && draft.country) && locations.length < LIMITS.locations;
  const canAddRemote = Boolean(remoteDraft.city.trim() && remoteDraft.country)
    && remoteSearchLocations.length < LIMITS.remoteSearchLocations;

  function addLocation() {
    if (!canAdd) return;
    const city = draft.city.trim();
    if (!locations.some((item) => item.city.toLowerCase() === city.toLowerCase() && item.country === draft.country)) setLocations([...locations, { ...draft, city }]);
    setDraft({ city: "", country: "", radiusKm: 30 }); setCustomCity(false);
  }
  function toggleCountry(code: string) {
    if (!code) return;
    setRemote((current) => ({ ...current, countries: current.countries.includes(code) ? current.countries.filter((item) => item !== code) : [...current.countries, code].slice(0, LIMITS.remoteCountries) }));
  }
  function addRemoteSearchLocation() {
    if (!canAddRemote) return;
    const city = remoteDraft.city.trim();
    if (!remoteSearchLocations.some((item) => item.city.toLowerCase() === city.toLowerCase() && item.country === remoteDraft.country)) {
      setRemoteSearchLocations([...remoteSearchLocations, { ...remoteDraft, city }]);
    }
    setRemoteDraft({ city: "", country: "" });
    setCustomRemoteCity(false);
  }

  return <SaveForm action={saveLocationSettings} className="card card-pad settings-card">
    <h2>Where</h2>
    <input type="hidden" name="locationsJson" value={JSON.stringify(locations)} />
    <input type="hidden" name="remoteSearchLocationsJson" value={JSON.stringify(remoteSearchLocations)} />
    <div className="settings-group">
      <span className="label" style={{ margin: 0 }}>Office locations{locations.length ? <span className="opt"> · {locations.length}</span> : null}</span>
      {locations.length > 0 && <div className="loc-list">{locations.map((location, index) => <div className="loc" key={`${location.country}-${location.city}`}>
        <span className="menu-icon"><MapPin aria-hidden /></span>
        <span style={{ minWidth: 0 }}><span className="title truncate">{location.city}</span><span className="meta truncate">{countryName(location.country)}</span></span>
        <label className="radius"><input className="field" type="number" inputMode="numeric" min={0} max={500} value={location.radiusKm} aria-label={`Radius around ${location.city} in km`} onChange={(event) => setLocations(locations.map((item, i) => i === index ? { ...item, radiusKm: Math.max(0, Math.min(500, Number(event.target.value) || 0)) } : item))} />km</label>
        <button type="button" className="icon-btn" aria-label={`Remove ${location.city}`} onClick={() => setLocations(locations.filter((_, i) => i !== index))}><X aria-hidden /></button>
      </div>)}</div>}
      {locations.length < LIMITS.locations && <div className="loc-add">
        <CountrySelect id="office-country" label="Office country" value={draft.country} onChange={(country) => { setDraft((item) => ({ ...item, country, city: "" })); setCustomCity(false); }} />
        {draft.country && cities.length > 0 && !customCity
          ? <Select aria-label="Office city" value={draft.city} onChange={(event) => { if (event.target.value === "__custom") { setCustomCity(true); setDraft((item) => ({ ...item, city: "" })); } else setDraft((item) => ({ ...item, city: event.target.value })); }}><option value="">City</option>{cities.map((city) => <option value={city} key={city}>{city}</option>)}<option value="__custom">Another city…</option></Select>
          : <Input aria-label="Office city" placeholder="City" maxLength={80} value={draft.city} disabled={!draft.country} onChange={(event) => setDraft((item) => ({ ...item, city: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addLocation(); } }} />}
        <label className="radius cluster" style={{ gap: 6 }}><Input type="number" inputMode="numeric" min={0} max={500} aria-label="Radius in km" value={draft.radiusKm} onChange={(event) => setDraft((item) => ({ ...item, radiusKm: Math.max(0, Math.min(500, Number(event.target.value) || 0)) }))} style={{ width: 72 }} /><span className="small muted">km</span></label>
        <Button type="button" className="btn-secondary" disabled={!canAdd} onClick={addLocation}><Plus aria-hidden />Add</Button>
      </div>}
    </div>

    <div className="settings-group">
      <span className="label" style={{ margin: 0 }}>Office work modes</span>
      <div className="cluster">{WORK_MODES.map((mode) => <label className="chip-toggle" key={mode.id}><input type="checkbox" name="workModes" value={mode.id} defaultChecked={workModes.includes(mode.id)} /><span>{mode.label}</span></label>)}</div>
    </div>

    <div className="settings-group">
      <label className="switch-row" style={{ borderTop: 0 }}><span className="switch-text">Remote roles</span><span className="switch"><input type="checkbox" name="remoteEnabled" checked={remote.enabled} onChange={(event) => setRemote({ ...remote, enabled: event.target.checked })} /><span /></span></label>
      {remote.enabled && <>
        <div className="settings-group">
          <div>
            <span className="label">Remote search locations{remoteSearchLocations.length ? <span className="opt"> · {remoteSearchLocations.length}</span> : null}</span>
            <p className="small muted">These locations anchor remote discovery. Region-targeted EU or EMEA roles can still appear when they match a selected location; work eligibility is configured separately below.</p>
          </div>
          {remoteSearchLocations.length > 0 && <div className="loc-list">{remoteSearchLocations.map((location, index) => <div className="loc" style={{ gridTemplateColumns: "auto minmax(0, 1fr) auto" }} key={`${location.country}-${location.city}`}>
            <span className="menu-icon"><MapPin aria-hidden /></span>
            <span style={{ minWidth: 0 }}><span className="title truncate">{location.city}</span><span className="meta truncate">{countryName(location.country)}</span></span>
            <button type="button" className="icon-btn" aria-label={`Remove ${location.city} from remote search locations`} onClick={() => setRemoteSearchLocations(remoteSearchLocations.filter((_, i) => i !== index))}><X aria-hidden /></button>
          </div>)}</div>}
          {remoteSearchLocations.length < LIMITS.remoteSearchLocations && <div className="cluster" style={{ alignItems: "stretch" }}>
            <span style={{ flex: "1 1 180px" }}><CountrySelect id="remote-search-country" label="Remote search country" value={remoteDraft.country} onChange={(country) => { setRemoteDraft({ country, city: "" }); setCustomRemoteCity(false); }} /></span>
            <span style={{ flex: "1 1 180px" }}>{remoteDraft.country && remoteCities.length > 0 && !customRemoteCity
              ? <Select aria-label="Remote search city" value={remoteDraft.city} onChange={(event) => { if (event.target.value === "__custom") { setCustomRemoteCity(true); setRemoteDraft((item) => ({ ...item, city: "" })); } else setRemoteDraft((item) => ({ ...item, city: event.target.value })); }}><option value="">City</option>{remoteCities.map((city) => <option value={city} key={city}>{city}</option>)}<option value="__custom">Another city…</option></Select>
              : <Input aria-label="Remote search city" placeholder="City" maxLength={80} value={remoteDraft.city} disabled={!remoteDraft.country} onChange={(event) => setRemoteDraft((item) => ({ ...item, city: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addRemoteSearchLocation(); } }} />}</span>
            <Button type="button" className="btn-secondary" disabled={!canAddRemote} onClick={addRemoteSearchLocation}><Plus aria-hidden />Add</Button>
          </div>}
        </div>
        {remote.countries.map((code) => <input type="hidden" name="remoteCountries" value={code} key={code} />)}
        <div>
          <label className="label" htmlFor="remote-country">Eligible to work from{remote.countries.length ? <span className="opt"> · {remote.countries.length}</span> : null}</label>
          {remote.countries.length > 0 && <div className="tokens" style={{ marginBottom: 6 }}>{remote.countries.map((code) => <span className="token" key={code}><span>{countryName(code)}</span><button type="button" aria-label={`Remove ${countryName(code)}`} onClick={() => toggleCountry(code)}><X aria-hidden /></button></span>)}</div>}
          <CountrySelect id="remote-country" label="Add a country" value="" onChange={toggleCountry} />
        </div>
        <div>
          <label className="switch-row"><span className="switch-text">Anywhere in the world</span><span className="switch"><input type="checkbox" name="includeWorldwide" checked={remote.includeWorldwide} onChange={(event) => setRemote({ ...remote, includeWorldwide: event.target.checked })} /><span /></span></label>
          <label className="switch-row"><span className="switch-text">Eligibility not stated</span><span className="switch"><input type="checkbox" name="includeUnspecified" checked={remote.includeUnspecified} onChange={(event) => setRemote({ ...remote, includeUnspecified: event.target.checked })} /><span /></span></label>
        </div>
      </>}
    </div>
  </SaveForm>;
}
