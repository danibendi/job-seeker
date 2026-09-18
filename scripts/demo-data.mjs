#!/usr/bin/env node

import { createHash } from "node:crypto";
import postgres from "postgres";

const CONFIRMATION = "I_UNDERSTAND_THIS_REQUIRES_AN_EMPTY_DISPOSABLE_DATABASE";
const DEFAULT_ANCHOR = "2026-09-18T09:00:00.000Z";

class DemoSeedError extends Error {}

function requireSafeEnvironment() {
  if (process.env.JOB_SEEKER_DEMO_SEED !== CONFIRMATION) {
    throw new DemoSeedError(`Set JOB_SEEKER_DEMO_SEED=${CONFIRMATION} to opt in.`);
  }
  if (process.env.JOB_SEEKER_DISPOSABLE_DATABASE !== "true") {
    throw new DemoSeedError("Set JOB_SEEKER_DISPOSABLE_DATABASE=true only for an explicitly disposable database.");
  }
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) throw new DemoSeedError("DATABASE_URL_UNPOOLED or DATABASE_URL is required.");
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new DemoSeedError("The database URL is invalid."); }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new DemoSeedError("The database URL must use PostgreSQL.");
  }
  const anchorText = process.env.JOB_SEEKER_DEMO_ANCHOR || DEFAULT_ANCHOR;
  const anchor = new Date(anchorText);
  if (!Number.isFinite(anchor.getTime()) || anchor.toISOString() !== anchorText) {
    throw new DemoSeedError("JOB_SEEKER_DEMO_ANCHOR must be a canonical UTC ISO timestamp, such as 2026-09-18T09:00:00.000Z.");
  }
  return { databaseUrl, anchor };
}

function at(anchor, { days = 0, hours = 0 } = {}) {
  return new Date(anchor.getTime() + (days * 24 + hours) * 60 * 60 * 1000).toISOString();
}

function dateAt(anchor, days = 0) {
  return at(anchor, { days }).slice(0, 10);
}

function mondayOf(anchor, weekOffset = 0) {
  const date = new Date(anchor);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1 + weekOffset * 7);
  return date.toISOString().slice(0, 10);
}

function uuid(group, index) {
  return `${group.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function minimalPdf(lines) {
  const escaped = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  const commands = escaped.map((line, index) => `${index ? "0 -24 Td " : ""}(${line}) Tj`).join("\n");
  const stream = `BT\n/F1 15 Tf\n72 740 Td\n${commands}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function demoData(anchor) {
  const cvLeadership = uuid(2, 1);
  const cvService = uuid(2, 2);
  const companyNames = [
    ["Northstar Loom Labs", "northstar-loom", "London, United Kingdom", "a"],
    ["Juniper Arc Systems", "juniper-arc", "Amsterdam, Netherlands", "a"],
    ["Harbor & Finch Studio", "harbor-finch", "London, United Kingdom", "b"],
    ["Lantern Peak Mobility", "lantern-peak", "Bristol, United Kingdom", "a"],
    ["Blue Oak Robotics", "blue-oak-robotics", "Cambridge, United Kingdom", "a"],
    ["Cedar Kite Health", "cedar-kite-health", "London, United Kingdom", "b"],
    ["Paper Moon Cloud", "paper-moon-cloud", "Remote, Europe", "a"],
    ["Bright Harbor Works", "bright-harbor", "Manchester, United Kingdom", "b"],
    ["Ember Field Energy", "ember-field", "Oxford, United Kingdom", "c"],
    ["Mossline Analytics", "mossline-analytics", "Remote, United Kingdom", "b"],
  ];
  const companies = companyNames.map(([name, slug, location, tier], index) => ({
    id: uuid(1, index + 1), name, slug, location, tier,
    website: `https://${slug}.example`, careersUrl: `https://careers.${slug}.example`,
    dossierMd: `## Why it is interesting\n\n${name} is a fictional organisation created for the Job Seeker public demo. Its design practice values measurable service quality, accessible systems, and calm cross-functional delivery.\n\n## Signals to verify\n\n- Decision-making scope for the role\n- Design team maturity and reporting line\n- Expected balance of strategy and operations`,
    notesMd: "Synthetic demo record. No outreach has occurred outside this fictional dataset.",
  }));
  const jobSpecs = [
    ["Design Program Manager", "sourced", 92, "hybrid", "£88,000–£102,000", cvLeadership, null],
    ["Senior Design Operations Lead", "to_apply", 88, "hybrid", "€92,000–€108,000", cvLeadership, -1],
    ["Service Design Lead", "applied", 84, "hybrid", "£78,000–£91,000", cvService, -18],
    ["Product Design Program Manager", "screening", 90, "hybrid", "£90,000–£105,000", cvLeadership, -8],
    ["Design Operations Manager", "interviewing", 87, "hybrid", "£82,000–£96,000", cvLeadership, -11],
    ["Principal Service Designer", "interviewing", 82, "hybrid", "£86,000–£99,000", cvService, -13],
    ["Design Systems Program Lead", "offer", 94, "remote", "£98,000–£112,000", cvLeadership, -25],
    ["UX Program Manager", "rejected", 76, "hybrid", "£72,000–£84,000", cvLeadership, -31],
    ["Design Strategy Lead", "irrelevant", 55, "onsite", "£75,000–£86,000", cvService, -6],
    ["Design Operations Partner", "sourced", 79, "remote", "£80,000–£94,000", cvLeadership, null],
  ];
  const jobs = jobSpecs.map(([title, status, fitScore, workMode, salaryText, cvId, statusDays], index) => ({
    id: uuid(3, index + 1), companyId: companies[index].id, title, status, fitScore, workMode, salaryText,
    url: `https://careers.${companies[index].slug}.example/jobs/${companies[index].slug}-${index + 101}`,
    source: index % 3 === 0 ? "Company watchlist" : index % 3 === 1 ? "Fictional design jobs board" : "Saved alert",
    location: companies[index].location,
    descriptionMd: `## The opportunity\n\n${companies[index].name} is looking for a ${title} to improve how multidisciplinary teams plan, learn, and deliver. The role owns a portfolio of design initiatives and partners with product, research, engineering, and operations.\n\n## What you would do\n\n- Turn ambiguous goals into a visible programme with clear decisions\n- Improve rituals, tooling, and evidence without adding process for its own sake\n- Coach leads through prioritisation, dependencies, and stakeholder communication\n- Measure whether the operating model improves outcomes for customers and teams\n\n## What they value\n\nInclusive facilitation, systems thinking, crisp writing, and experience leading change across several teams.\n\n*This vacancy and organisation are fictional demo content.*`,
    postedAt: at(anchor, { days: -index - 2 }), discoveredAt: at(anchor, { days: -index, hours: -3 }),
    dedupeKey: `demo:${companies[index].slug}:${index + 101}`,
    fitAnalysisMd: `## Strong match\n\nAlex has led multi-team design programmes, built lightweight operating systems, and translated research into prioritised delivery. The role's emphasis on facilitation and measurable improvement aligns well.\n\n## Questions to resolve\n\nConfirm the decision authority, team size, and whether ${workMode === "remote" ? "remote collaboration" : "office cadence"} is flexible.`,
    fitFactors: [
      { factor: "Programme leadership", weight: 35, direction: "+", note: "Direct evidence across multi-team design portfolios." },
      { factor: "Design operations", weight: 25, direction: "+", note: "Strong systems, rituals, and change-management fit." },
      { factor: "Location and work mode", weight: 15, direction: workMode === "onsite" ? "-" : "+", note: workMode === "onsite" ? "More office time than preferred." : "Matches configured preferences." },
      { factor: "Domain familiarity", weight: 10, direction: index % 4 === 0 ? "-" : "+", note: index % 4 === 0 ? "Adjacent domain; validate ramp-up expectations." : "Relevant service and platform context." },
    ],
    analysisStatus: "complete", recommendedCvVariantId: cvId,
    statusChangedAt: statusDays === null ? at(anchor, { days: -index }) : at(anchor, { days: statusDays }),
    triagedAt: status === "sourced" ? null : at(anchor, { days: Math.min(-1, Number(statusDays) || -1), hours: -1 }),
  }));
  jobs[9].triagedAt = null;

  const interviews = [
    {
      id: uuid(7, 1), jobId: jobs[4].id, stage: "panel", scheduledAt: at(anchor, { days: 2, hours: 5 }), timeZone: "Europe/London",
      locationOrLink: "https://meet.blue-oak-robotics.example/demo-panel",
      notesMd: "60-minute fictional panel with design, product, and research leads. Prepare a concise operating-model case study and leave time for questions.",
      questionsMd: "- How do you introduce consistency without slowing teams down?\n- Tell us about a programme that changed direction after new evidence.\n- How do you know a design operating model is working?",
      postInterviewNotesMd: null,
      checklist: [{ id: "case", label: "Rehearse the Meridian Canvas case study", done: true }, { id: "metrics", label: "Prepare before/after programme measures", done: true }, { id: "questions", label: "Choose three questions for the panel", done: false }], outcome: "pending",
    },
    {
      id: uuid(7, 2), jobId: jobs[5].id, stage: "hiring_manager", scheduledAt: at(anchor, { days: 5, hours: 2 }), timeZone: "Europe/London",
      locationOrLink: "https://meet.cedar-kite-health.example/demo-conversation",
      notesMd: "45-minute fictional conversation focused on service transformation, research synthesis, and influencing clinical operations.",
      questionsMd: "- How do you make service blueprints useful after a workshop?\n- Describe a time you aligned policy, operations, and digital teams.\n- What would you learn in your first 30 days?",
      postInterviewNotesMd: null,
      checklist: [{ id: "journey", label: "Review the care-journey brief", done: true }, { id: "portfolio", label: "Select two portfolio artefacts", done: false }, { id: "access", label: "Prepare an accessibility example", done: false }], outcome: "pending",
    },
  ];

  const pdf = minimalPdf(["ALEX MORGAN", "Fictional CV for the Job Seeker public demo", "Design programme leadership and service design"]);
  return { anchor, companies, jobs, interviews, cvLeadership, cvService, pdf };
}

const requiredTables = [
  "workspaces", "companies", "cv_variants", "jobs", "job_status_history", "feedback", "cv_tailorings",
  "interviews", "interviewers", "prep_briefs", "agencies", "outreach_log", "watchlist_items", "strategy_sections",
  "key_events", "weekly_targets", "requests", "rejections", "automation_runs", "notification_preferences",
  "search_settings", "cv_documents", "digests", "activity_log", "events_outbox", "linkedin_snapshots",
  "linkedin_ingest_receipts", "agent_tasks", "agent_execution_settings", "agent_schedule_occurrences",
  "linkedin_search_runs", "linkedin_search_lanes", "linkedin_search_pages", "linkedin_search_details",
];

const singletonTables = new Set(["workspaces", "agent_execution_settings"]);

async function assertEmptyDisposableDatabase(tx) {
  for (const table of requiredTables) {
    const [{ exists }] = await tx`select to_regclass(${`public.${table}`}) is not null as exists`;
    if (!exists) throw new DemoSeedError("The database is not fully migrated; run the repository migrations first.");
  }
  for (const table of requiredTables) {
    const [{ count }] = await tx`select count(*)::int as count from ${tx(table)}`;
    if (!singletonTables.has(table) && count !== 0) {
      throw new DemoSeedError("Demo seeding refused because business tables are not empty.");
    }
  }
  const workspaces = await tx`select id, candidate_id, owner_name, onboarding_completed_at from workspaces`;
  if (workspaces.length > 1 || (workspaces.length === 1 && (workspaces[0].id !== "owner" || workspaces[0].owner_name !== "" || workspaces[0].onboarding_completed_at !== null))) {
    throw new DemoSeedError("Demo seeding refused because the workspace already contains owner data.");
  }
  const execution = await tx`select id, search_executor, evaluation_executor, search_sources from agent_execution_settings`;
  if (execution.length > 1 || (execution.length === 1 && (execution[0].id !== "owner" || execution[0].search_executor !== "unassigned" || execution[0].evaluation_executor !== "unassigned" || execution[0].search_sources.length !== 0))) {
    throw new DemoSeedError("Demo seeding refused because agent execution is already configured.");
  }
}

async function insertCore(tx, data) {
  const { anchor, companies, jobs, cvLeadership, cvService, pdf } = data;
  await tx`
    insert into workspaces (id, candidate_id, display_name, owner_name, assistant_label, locale, time_zone, onboarding_completed_at, created_at, updated_at)
    values ('owner', 'demo-alex-morgan', ${"Alex's Demo Workspace"}, 'Alex Morgan', 'Orbit', 'en-GB', 'Europe/London', ${at(anchor)}, ${at(anchor, { days: -45 })}, ${at(anchor)})
    on conflict (id) do update set candidate_id = excluded.candidate_id, display_name = excluded.display_name,
      owner_name = excluded.owner_name, assistant_label = excluded.assistant_label, locale = excluded.locale,
      time_zone = excluded.time_zone, onboarding_completed_at = excluded.onboarding_completed_at, updated_at = excluded.updated_at
  `;

  await tx`insert into cv_variants (id, slug, name, summary, content_md, version, updated_at) values
    (${cvLeadership}, 'design-program-leadership', 'Design programme leadership', 'Portfolio leadership, design operations, and cross-functional delivery.', ${`# Alex Morgan\n\n*Fictional candidate profile for the Job Seeker public demo.*\n\n## Profile\n\nDesign programme leader with 11 years of synthetic experience turning complex portfolios into focused, measurable delivery. Builds practical operating systems for product, design, research, and engineering teams.\n\n## Selected fictional experience\n\n### Meridian Canvas Cooperative — Head of Design Programmes\n\n- Led a four-country portfolio spanning service design, design systems, and customer research.\n- Cut decision lead time by 32% through a lightweight quarterly planning and dependency model.\n- Introduced accessible programme reviews that made evidence, risk, and ownership visible.\n\n### Common Thread Digital — Design Operations Lead\n\n- Built onboarding, research operations, and portfolio reporting for a 42-person design practice.\n- Coached design leads through organisational change and improved team-health measures.\n\n## Strengths\n\nProgramme design · Facilitation · Portfolio strategy · Design operations · Executive communication`}, 4, ${at(anchor, { days: -6 })}),
    (${cvService}, 'service-design-research', 'Service design & research', 'Service transformation, research synthesis, and inclusive facilitation.', ${`# Alex Morgan\n\n*Fictional candidate profile for the Job Seeker public demo.*\n\n## Profile\n\nService design leader who connects qualitative evidence, operational constraints, and product strategy. Experienced in inclusive research and end-to-end service transformation.\n\n## Selected fictional experience\n\n### Meridian Canvas Cooperative — Principal Service Designer\n\n- Redesigned a multi-channel support journey with policy, operations, and digital teams.\n- Established continuous research and service measures used in monthly prioritisation.\n- Facilitated inclusive co-design with customers and frontline colleagues.\n\n### Common Thread Digital — Senior Service Designer\n\n- Mapped complex services, prototyped operating changes, and coached multidisciplinary teams.\n\n## Strengths\n\nService blueprints · Research synthesis · Accessibility · Facilitation · Change leadership`}, 3, ${at(anchor, { days: -9 })})`;

  await tx`insert into cv_documents (variant_id, file_name, content_base64, sha256, updated_at) values
    (${cvLeadership}, 'alex-morgan-fictional-demo-cv.pdf', ${pdf.toString("base64")}, ${createHash("sha256").update(pdf).digest("hex")}, ${at(anchor, { days: -6 })})`;

  for (const company of companies) {
    await tx`insert into companies (id, name, slug, website, careers_url, location, tier, dossier_md, notes_md, created_at, updated_at) values
      (${company.id}, ${company.name}, ${company.slug}, ${company.website}, ${company.careersUrl}, ${company.location}, ${company.tier}, ${company.dossierMd}, ${company.notesMd}, ${at(anchor, { days: -40 })}, ${at(anchor, { days: -2 })})`;
  }
  for (const job of jobs) {
    await tx`insert into jobs (id, company_id, title, url, source, location, work_mode, salary_text, description_md, posted_at, discovered_at, dedupe_key, fit_score, fit_analysis_md, fit_factors, analysis_status, recommended_cv_variant_id, status, status_changed_at, triaged_at) values
      (${job.id}, ${job.companyId}, ${job.title}, ${job.url}, ${job.source}, ${job.location}, ${job.workMode}, ${job.salaryText}, ${job.descriptionMd}, ${job.postedAt}, ${job.discoveredAt}, ${job.dedupeKey}, ${job.fitScore}, ${job.fitAnalysisMd}, ${tx.json(job.fitFactors)}, ${job.analysisStatus}, ${job.recommendedCvVariantId}, ${job.status}, ${job.statusChangedAt}, ${job.triagedAt})`;
  }
}

async function insertWorkflow(tx, data) {
  const { anchor, jobs, interviews, cvLeadership, cvService } = data;
  let historyIndex = 1;
  for (const [jobIndex, job] of jobs.entries()) {
    await tx`insert into job_status_history (id, job_id, from_status, to_status, note, from_triaged, actor, created_at) values
      (${uuid(4, historyIndex++)}, ${job.id}, ${job.status === "sourced" ? null : "sourced"}, ${job.status}, ${job.status === "sourced" ? "Fictional role discovered and scored for the demo." : `Moved into ${job.status.replaceAll("_", " ")} during the synthetic demo journey.`}, ${job.status !== "sourced"}, ${jobIndex % 2 ? "owner" : "assistant"}, ${job.statusChangedAt})`;
  }
  await tx`insert into job_status_history (id, job_id, from_status, to_status, note, from_triaged, actor, created_at) values
    (${uuid(4, historyIndex++)}, ${jobs[4].id}, 'screening', 'interviewing', 'Panel interview booked after a positive fictional screening call.', true, 'owner', ${at(anchor, { days: -4 })}),
    (${uuid(4, historyIndex++)}, ${jobs[6].id}, 'interviewing', 'offer', 'Synthetic offer received; compensation and remit under review.', true, 'owner', ${at(anchor, { days: -2 })})`;

  await tx`insert into feedback (id, job_id, verdict, reasons, note, created_at) values
    (${uuid(5, 1)}, ${jobs[8].id}, 'irrelevant', ${tx.array(["location", "role_type"])}, 'The role is fully on-site and weighted toward brand strategy rather than service or programme leadership.', ${at(anchor, { days: -5 })}),
    (${uuid(5, 2)}, ${jobs[1].id}, 'relevant', ${tx.array([])}, 'Strong scope and a credible next step.', ${at(anchor, { days: -1 })}),
    (${uuid(5, 3)}, ${jobs[7].id}, 'maybe', ${tx.array(["seniority_too_low"])}, 'Good work, but the original remit may have been narrower than the title suggested.', ${at(anchor, { days: -20 })})`;

  await tx`insert into cv_tailorings (id, job_id, cv_variant_id, proposal_md, changes, status, owner_note, created_at, decided_at) values
    (${uuid(6, 1)}, ${jobs[0].id}, ${cvLeadership}, 'Emphasise portfolio governance, facilitation, and the measurable change at Meridian Canvas. Keep the evidence concrete and avoid mirroring vacancy language.', ${tx.json([
      { id: "northstar-summary", section: "Profile", current: "Design programme leader with 11 years of experience.", proposed: "Design programme leader who turns complex product portfolios into focused, measurable delivery.", rationale: "Leads with the role's highest-value outcome.", decision: "pending" },
      { id: "northstar-metric", section: "Meridian Canvas", current: "Led a multi-country portfolio.", proposed: "Led a four-country design portfolio and reduced decision lead time by 32%.", rationale: "Pairs scope with a verified result from the fictional CV.", decision: "pending" },
    ])}, 'proposed', null, ${at(anchor, { hours: -6 })}, null),
    (${uuid(6, 2)}, ${jobs[4].id}, ${cvLeadership}, 'Shift the opening toward design operations and make the operating-model results easier to scan.', ${tx.json([
      { id: "blue-oak-ops", section: "Profile", current: "Builds practical operating systems.", proposed: "Builds practical operating systems that help design, product, and engineering teams make faster decisions.", rationale: "Connects operating practice to an outcome.", decision: "accepted" },
    ])}, 'reviewed', 'Accepted for the fictional application pack.', ${at(anchor, { days: -12 })}, ${at(anchor, { days: -11 })}),
    (${uuid(6, 3)}, ${jobs[5].id}, ${cvService}, 'Bring service transformation and inclusive research evidence to the top.', ${tx.json([
      { id: "cedar-access", section: "Meridian Canvas", current: "Facilitated inclusive co-design.", proposed: "Facilitated inclusive co-design with customers and frontline teams, turning access needs into service changes.", rationale: "Adds the outcome that matters to a health service context.", decision: "accepted" },
    ])}, 'reviewed', 'Used in this synthetic application.', ${at(anchor, { days: -15 })}, ${at(anchor, { days: -14 })})`;

  for (const interview of interviews) {
    await tx`insert into interviews (id, job_id, stage, scheduled_at, time_zone, location_or_link, notes_md, questions_md, post_interview_notes_md, checklist, outcome) values
      (${interview.id}, ${interview.jobId}, ${interview.stage}, ${interview.scheduledAt}, ${interview.timeZone}, ${interview.locationOrLink}, ${interview.notesMd}, ${interview.questionsMd}, ${interview.postInterviewNotesMd}, ${tx.json(interview.checklist)}, ${interview.outcome})`;
  }
  await tx`insert into interviewers (id, interview_id, name, role_title, linkedin_url, research_md) values
    (${uuid(8, 1)}, ${interviews[0].id}, 'Riley Chen', 'Fictional VP of Design', 'https://profiles.example/riley-chen-demo', 'Leads the fictional design organisation. Likely to test whether operating changes produce visible outcomes rather than more ceremony.'),
    (${uuid(8, 2)}, ${interviews[0].id}, 'Jordan Bell', 'Fictional Director of Product', 'https://profiles.example/jordan-bell-demo', 'Focuses on cross-functional planning, trade-offs, and clear ownership.'),
    (${uuid(8, 3)}, ${interviews[1].id}, 'Samira Vale', 'Fictional Head of Service Design', 'https://profiles.example/samira-vale-demo', 'Interested in research practice, accessibility, and how service evidence changes operational decisions.')`;
  await tx`insert into prep_briefs (id, interview_id, content_md, created_at, read_at) values
    (${uuid(9, 1)}, ${interviews[0].id}, ${`# Blue Oak panel brief\n\n## Story to lead with\n\nUse the fictional Meridian Canvas portfolio reset: the situation was fragmented decision-making; Alex introduced evidence-led reviews and explicit dependencies; decision lead time improved by 32%.\n\n## Three points to land\n\n1. Start with the decision the organisation needs to improve.\n2. Co-design the smallest operating change with the people who will use it.\n3. Measure behaviour and outcomes, then adapt.\n\n## Questions to ask\n\n- Which decisions are hardest for teams today?\n- Where does this role have authority to change the system?\n- What would success look like after six months?`}, ${at(anchor, { days: -2 })}, ${at(anchor, { days: -1 })}),
    (${uuid(9, 2)}, ${interviews[1].id}, ${`# Cedar Kite conversation brief\n\nConnect service-blueprint work to operational ownership. Prepare examples of inclusive research, alignment across policy and delivery, and how Alex avoids research becoming a static report.\n\n## First-30-days outline\n\nListen across customer, frontline, and leadership groups; map current evidence and decision forums; choose one journey where a small experiment can demonstrate value.`}, ${at(anchor, { days: -1 })}, null)`;

  await tx`insert into rejections (id, job_id, occurred_at, stage, reason_category, reason_detail, learning_md, response_needed, response_sent, created_at, updated_at) values
    (${uuid(18, 1)}, ${jobs[7].id}, ${at(anchor, { days: -10 })}, 'Hiring manager', 'scope_mismatch', 'The fictional team chose a candidate with deeper hands-on production management experience.', 'Ask about the weekly split between programme leadership and delivery administration earlier. Keep the strongest portfolio-scale example in the first five minutes.', true, false, ${at(anchor, { days: -10 })}, ${at(anchor, { days: -9 })})`;
}

async function insertDirectoriesAndSettings(tx, data) {
  const { anchor, companies } = data;
  await tx`insert into agencies (id, name, website, contacts, status, notes_md, last_contact_at) values
    (${uuid(10, 1)}, 'Storyline Talent Collective', 'https://storyline-talent.example', ${tx.json([{ name: "Taylor Reed", role: "Fictional design recruiter", email: "taylor@storyline-talent.example" }])}, 'active', 'Synthetic specialist recruiter for design leadership and design operations. Agreed to share roles with clear remit and salary bands.', ${at(anchor, { days: -3 })}),
    (${uuid(10, 2)}, 'Northbank Creative Search', 'https://northbank-search.example', ${tx.json([{ name: "Casey Rowan", role: "Fictional partner", email: "casey@northbank-search.example" }])}, 'contacted', 'Introductory note sent in this fictional demo. Follow up with the two-paragraph positioning statement.', ${at(anchor, { days: -7 })}),
    (${uuid(10, 3)}, 'Signal & Form Partners', 'https://signal-form.example', ${tx.json([])}, 'not_contacted', 'Potential source for European service-design leadership roles.', null)`;
  await tx`insert into outreach_log (id, agency_id, company_id, channel, direction, summary, occurred_at, next_action, next_action_date) values
    (${uuid(11, 1)}, ${uuid(10, 1)}, null, 'email', 'in', ${"Fictional recruiter shared a market update and asked for Alex's preferred remit."}, ${at(anchor, { days: -3 })}, 'Send the design-programme CV and shortlist criteria.', ${dateAt(anchor, 1)}),
    (${uuid(11, 2)}, null, ${companies[4].id}, 'email', 'out', 'Sent a fictional thank-you note after the screening conversation.', ${at(anchor, { days: -4 })}, 'Prepare for the panel.', ${dateAt(anchor, 1)})`;
  await tx`insert into watchlist_items (id, label, url, kind, cadence, last_checked_at, last_findings_md) values
    (${uuid(12, 1)}, 'Northstar Loom careers', 'https://careers.northstar-loom.example', 'company', 'daily', ${at(anchor, { hours: -4 })}, 'Found the Design Program Manager role. No other matching leadership vacancies in this fictional snapshot.'),
    (${uuid(12, 2)}, 'Paper Moon Cloud careers', 'https://careers.paper-moon-cloud.example', 'company', 'weekly', ${at(anchor, { days: -2 })}, 'Offer-stage role remains listed; two unrelated engineering roles were ignored.'),
    (${uuid(12, 3)}, 'Fictional Design Leadership Board', 'https://jobs.design-leadership.example/search', 'board', 'daily', ${at(anchor, { hours: -7 })}, 'Three roles reviewed; Juniper Arc was the strongest match.'),
    (${uuid(12, 4)}, 'UK design operations alert', 'https://alerts.example/design-operations-uk', 'alert', 'daily', ${at(anchor, { days: -1 })}, 'Mossline Analytics added; remote eligibility still needs confirmation.'),
    (${uuid(12, 5)}, 'European service design alert', 'https://alerts.example/service-design-europe', 'alert', 'weekly', null, null)`;
  await tx`insert into strategy_sections (id, key, title, content_md, sort, updated_at) values
    (${uuid(13, 1)}, 'positioning', 'Positioning', 'Alex leads design programmes where the challenge is coordination, evidence, and organisational change—not simply adding process. Prioritise roles with a portfolio remit and access to senior decision-makers.', 10, ${at(anchor, { days: -4 })}),
    (${uuid(13, 2)}, 'proof', 'Evidence to use', '- 32% shorter decision lead time in a fictional four-country portfolio\n- Operating model for a 42-person design practice\n- Inclusive service transformation across policy, operations, and digital teams', 20, ${at(anchor, { days: -4 })}),
    (${uuid(13, 3)}, 'boundaries', 'Search boundaries', 'Prefer design programme, design operations, and principal service-design roles. Avoid pure brand leadership, production-only project management, and roles requiring five office days.', 30, ${at(anchor, { days: -4 })})`;
  await tx`insert into key_events (id, title, starts_on, ends_on, location, url, notes, rsvp_status) values
    (${uuid(14, 1)}, 'Fictional Design Operations Forum', ${dateAt(anchor, 12)}, ${dateAt(anchor, 12)}, 'London, United Kingdom', 'https://events.example/design-operations-forum', 'Demo networking event with two relevant roundtables.', 'going'),
    (${uuid(14, 2)}, 'Service Design Practice Exchange', ${dateAt(anchor, 21)}, ${dateAt(anchor, 22)}, 'Online', 'https://events.example/service-design-exchange', 'Synthetic community event for portfolio research.', 'interested')`;
  await tx`insert into weekly_targets (id, week_start, applications_target, conversations_target) values
    (${uuid(15, 1)}, ${mondayOf(anchor, -2)}, 4, 2),
    (${uuid(15, 2)}, ${mondayOf(anchor, -1)}, 4, 2),
    (${uuid(15, 3)}, ${mondayOf(anchor)}, 3, 2)`;
  await tx`insert into notification_preferences (id, high_fit_jobs, interview_reminders, follow_ups_due, automation_failures, daily_summary, weekly_digest, tailoring_ready, request_answered, watchlist_findings, interview_reminder_hours, minimum_fit_score, time_zone, updated_at) values
    ('owner', false, false, false, false, false, false, false, false, false, 24, 85, 'Europe/London', ${at(anchor)})`;
  await tx`insert into search_settings (id, minimum_fit_score, follow_up_days, target_roles, languages, excluded_companies, excluded_keywords, locations, work_modes, remote, schedule, tailor_cv_suggestions, notes_md, updated_at) values
    ('owner', 70, 10, ${tx.array(["Design Program Manager", "Design Operations Lead", "Principal Service Designer"])}, ${tx.array(["English", "French"])}, ${tx.array(["Example Tobacco Group"])}, ${tx.array(["junior", "pure brand", "production-only"])}, ${tx.json([{ city: "London", country: "GB", radiusKm: 55 }, { city: "Amsterdam", country: "NL", radiusKm: 30 }])}, ${tx.array(["hybrid"])}, ${tx.json({ enabled: true, countries: ["GB", "NL"], searchLocations: [{ city: "London", country: "GB" }, { city: "Amsterdam", country: "NL" }], includeWorldwide: false, includeUnspecified: false })}, ${tx.json({ enabled: false, frequency: "weekdays", time: "09:00", days: [], maxJobs: 15 })}, true, 'Prioritise roles with portfolio authority, measurable service outcomes, and mature cross-functional partners. Synthetic preferences for the public demo.', ${at(anchor)})`;
  await tx`insert into agent_execution_settings (id, search_executor, evaluation_executor, search_sources, max_pages, max_detail_fetches, max_duration_seconds, updated_at) values
    ('owner', 'unassigned', 'unassigned', ${tx.array([])}, 10, 30, 1200, ${at(anchor)})
    on conflict (id) do update set search_executor = 'unassigned', evaluation_executor = 'unassigned', search_sources = '{}', updated_at = excluded.updated_at`;
}

async function insertActivity(tx, data) {
  const { anchor, jobs } = data;
  const requests = [
    { id: uuid(17, 1), text: "Which three roles should I prioritise this week?", job: null, status: "answered", response: "1. **Paper Moon Cloud** — clarify the offer remit and success measures.\n2. **Blue Oak Robotics** — finish the panel story and metrics.\n3. **Northstar Loom Labs** — review the strong tailoring proposal and decide whether to apply.", created: at(anchor, { days: -2 }), answered: at(anchor, { days: -2, hours: 1 }) },
    { id: uuid(17, 2), text: "What should I ask the Blue Oak panel?", job: jobs[4].id, status: "answered", response: "Ask which decisions currently stall, where this role has authority to change the operating model, and what observable result would make the panel call the first six months successful.", created: at(anchor, { days: -1 }), answered: at(anchor, { days: -1, hours: 1 }) },
    { id: uuid(17, 3), text: "Draft a concise follow-up for Harbor & Finch", job: jobs[2].id, status: "open", response: null, created: at(anchor, { hours: -3 }), answered: null },
    { id: uuid(17, 4), text: "Compare the two CV variants for Cedar Kite", job: jobs[5].id, status: "failed", response: null, created: at(anchor, { days: -3 }), answered: null, error: "Paused in this fictional demo because no executor was connected; no external model was called." },
  ];
  for (const request of requests) {
    await tx`insert into requests (id, text, job_id, status, purpose, payload, response_md, created_at, answered_at, error_md, updated_at) values
      (${request.id}, ${request.text}, ${request.job}, ${request.status}, 'question', ${tx.json({ demo: true, synthetic: true })}, ${request.response}, ${request.created}, ${request.answered}, ${request.error ?? null}, ${request.answered ?? request.created})`;
  }
  const tasks = [
    { id: uuid(21, 1), request: requests[0].id, kind: "question", executor: "api", status: "succeeded", attempt: 1, result: { summary: "Prioritised the offer decision, the upcoming panel, and the highest-fit new role. Synthetic demo result; no model was invoked by the seeder." }, error: null, started: at(anchor, { days: -2 }), completed: at(anchor, { days: -2, hours: 1 }) },
    { id: uuid(21, 2), request: requests[1].id, kind: "question", executor: "codex", status: "succeeded", attempt: 1, result: { summary: "Prepared three decision-focused questions for the fictional Blue Oak panel. Synthetic demo result; no model was invoked by the seeder." }, error: null, started: at(anchor, { days: -1 }), completed: at(anchor, { days: -1, hours: 1 }) },
    { id: uuid(21, 3), request: requests[2].id, kind: "question", executor: "unassigned", status: "waiting_for_user", attempt: 0, result: null, error: "Synthetic demo task awaiting an executor; no worker has claimed it.", started: null, completed: null },
    { id: uuid(21, 4), request: requests[3].id, kind: "question", executor: "hermes", status: "cancelled", attempt: 0, result: null, error: "Synthetic demo cancellation before dispatch; no external runtime was called.", started: null, completed: at(anchor, { days: -3, hours: 1 }) },
    { id: uuid(21, 5), request: null, kind: "search", executor: "api", status: "succeeded", attempt: 1, result: { summary: "Reviewed 12 fictional sources and surfaced 4 demo roles. This stored history is synthetic and was not produced by a live worker.", demo: true }, error: null, started: at(anchor, { days: -4 }), completed: at(anchor, { days: -4, hours: 1 }) },
  ];
  for (const task of tasks) {
    await tx`insert into agent_tasks (id, request_id, kind, executor, status, dedupe_key, payload, checkpoint, result, attempt_count, max_attempts, available_at, last_error, started_at, created_at, updated_at, completed_at) values
      (${task.id}, ${task.request}, ${task.kind}, ${task.executor}, ${task.status}, ${`demo:${task.id}`}, ${tx.json({ candidateId: "demo-alex-morgan", demo: true, synthetic: true })}, ${tx.json({ message: task.status === "waiting_for_user" ? "Choose an executor when demonstrating task assignment." : "Synthetic public-demo history." })}, ${task.result ? tx.json(task.result) : null}, ${task.attempt}, 3, ${at(anchor, { days: -6 })}, ${task.error}, ${task.started}, ${task.started ?? at(anchor, { days: -3 })}, ${task.completed ?? task.started ?? at(anchor)}, ${task.completed})`;
  }
  await tx`insert into automation_runs (id, run_key, workflow, status, scheduled_for, started_at, completed_at, jobs_found, jobs_analyzed, summary_md, payload) values
    (${uuid(19, 1)}, 'demo-search-2026-09-14', 'search', 'succeeded', null, ${at(anchor, { days: -4 })}, ${at(anchor, { days: -4, hours: 1 })}, 4, 4, 'Synthetic stored search history for the public demo. Four fictional roles were scored; no live worker or external runtime was invoked by the seed.', ${tx.json({ demo: true, synthetic: true, invokedRuntime: false })}),
    (${uuid(19, 2)}, 'demo-watchlist-2026-09-16', 'watchlist_check', 'skipped', null, ${at(anchor, { days: -2 })}, ${at(anchor, { days: -2 })}, 0, 0, 'Synthetic skipped run showing that automation is paused in this demo.', ${tx.json({ demo: true, synthetic: true, reason: "schedule_disabled" })})`;
  const events = [
    ["assistant", "search_completed", jobs[0].id, "Synthetic search history added four fictional roles; Northstar Loom scored highest.", -4],
    ["owner", "job_status_changed", jobs[6].id, "Moved Paper Moon Cloud to Offer after a fictional final conversation.", -2],
    ["assistant", "cv_tailoring_ready", jobs[0].id, "Prepared a fictional CV tailoring proposal for Northstar Loom.", -1],
    ["owner", "feedback_recorded", jobs[8].id, "Passed on Ember Field because the work mode and role focus did not match.", -1],
    ["assistant", "request_answered", jobs[4].id, "Answered a fictional interview-prep question for Blue Oak Robotics.", 0],
    ["system", "demo_seeded", null, "Loaded fictional public-demo data. Schedules, notifications, and executors remain disabled.", 0],
  ];
  for (const [index, [actor, type, jobId, message, days]] of events.entries()) {
    await tx`insert into activity_log (id, actor, type, job_id, message, payload, created_at) values
      (${uuid(20, index + 1)}, ${actor}, ${type}, ${jobId}, ${message}, ${tx.json({ demo: true, synthetic: true })}, ${at(anchor, { days, hours: index - 5 })})`;
  }
  await tx`insert into digests (id, digest_date, content_md, stats, created_at) values
    (${uuid(16, 1)}, ${dateAt(anchor, -1)}, '## Fictional weekly snapshot\n\nThe pipeline has one offer, two active interviews, one follow-up due, and two newly sourced roles. Prioritise the Paper Moon decision and Blue Oak panel preparation.', ${tx.json({ demo: true, applications: 3, interviews: 2, offers: 1 })}, ${at(anchor, { days: -1 })})`;
}

async function main() {
  const { databaseUrl, anchor } = requireSafeEnvironment();
  const sql = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 });
  const data = demoData(anchor);
  try {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('job-seeker:fictional-demo-seed:v1'))`;
      await assertEmptyDisposableDatabase(tx);
      for (const [stage, seed] of [
        ["core records", insertCore],
        ["workflow records", insertWorkflow],
        ["directories and settings", insertDirectoriesAndSettings],
        ["activity records", insertActivity],
      ]) {
        try { await seed(tx, data); }
        catch (error) {
          if (error instanceof DemoSeedError) throw error;
          if (process.env.JOB_SEEKER_DEMO_DEBUG === "true") {
            console.error(JSON.stringify({ stage, code: error?.code ?? null, table: error?.table ?? null, column: error?.column ?? null, constraint: error?.constraint ?? null, routine: error?.routine ?? null }));
          }
          throw new DemoSeedError(`Demo seeding failed during ${stage}.`);
        }
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log(JSON.stringify({
    seeded: true,
    fixture: "fictional-public-demo-v1",
    anchor: anchor.toISOString(),
    candidateId: "demo-alex-morgan",
    automation: "disabled",
    records: { companies: 10, jobs: 10, cvVariants: 2, interviews: 2, requests: 4, agentTasks: 5 },
    routes: {
      dashboard: "/",
      pipeline: "/pipeline",
      richJob: `/jobs/${data.jobs[0].id}`,
      interview: `/interviews/${data.interviews[0].id}`,
      cv: "/cv?variant=design-program-leadership",
      tailoring: `/cv?tailoring=${uuid(6, 1)}`,
      activity: "/activity?tab=tasks",
      insights: "/insights",
      settings: "/settings?tab=schedule",
    },
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof DemoSeedError ? error.message : "Demo seeding failed; inspect the disposable database locally.";
  console.error(message);
  process.exitCode = 1;
});
