# A tour of Job Seeker

Job Seeker brings the decisions, documents, and follow-through of a job search into one private workspace. Use it as a manual tracker, connect an assistant through MCP, or add a background worker when you want queued automation.

**Every screenshot below is the real application with fictional demo data.** Alex Morgan, the organisations, vacancies, assessments, and agent results are invented. Screenshots illustrate the interface; the preloaded agent results are not evidence of a live model run. You can [recreate this workspace](../examples/demo/README.md) yourself.

## Start with what needs your attention

Home brings together your weekly application target, roles to review, upcoming interviews, follow-ups, and CV changes awaiting a decision. Pending and failed requests remain visible so you can act on them.

![Home: weekly progress, decisions waiting for you, scored roles, and upcoming interviews](screenshots/dashboard.png)

## Keep the whole pipeline in view

Add a vacancy manually, find a role by title or company, filter by fit score, and move between review, shortlist, application, screening, interview, and offer stages. Closed roles retain their history. A board view is also available.

![Pipeline: active roles with fit scores, companies, locations, and current stages](screenshots/pipeline.png)

![Pipeline board: roles arranged by stage with move controls](screenshots/pipeline-board.png)

## Understand the fit before deciding

A role has a fit score, supporting factors, concerns, practical details, and a suggested CV variant. Expand the description, full analysis, or company research; ask a role-specific question and keep private notes. Assessments are saved information to review, not a guarantee that a role is suitable.

![Role detail: fit assessment, concerns, salary and location, and workflow actions](screenshots/job-detail.png)

## Tailor a CV while keeping control of the wording

Maintain several factual CV variants, edit their sections, and keep an original PDF alongside the text. A tailoring proposal shows the current wording, suggested replacement, and rationale. Accept or reject individual changes before incorporating them into the selected CV.

![CV: factual document alongside proposed changes with individual accept and reject controls](screenshots/cv.png)

## Prepare for each interview

The interview list brings together dates, companies, stages, and outcomes. Each interview opens into a preparation workspace with a checklist, questions to ask, notes, an assistant brief, and interviewer research. Reschedule or record the outcome from that same page.

![Interviews: upcoming conversations linked to their roles](screenshots/interviews.png)

![Interview preparation: checklist, questions, and a saved briefing](screenshots/interview-prep.png)

## See what agents are doing

Activity separates durable tasks, the event timeline, search history, and your requests. Task records expose status, executor, attempts, and relevant errors; available actions depend on the task state. The demo keeps scheduling paused and executors unassigned.

![Agent activity: task statuses and execution details](screenshots/activity.png)

Ask a question from the general requests page or from an individual role. A configured worker processes it in the background and saves the answer in the app. Requests remain usable as a visible queue when a worker is unavailable.

![Requests: a saved answer, a waiting question, and a failed request with retry](screenshots/requests.png)

Search history preserves run summaries and counts. These records help explain what happened; they do not establish that every job board or employer was exhaustively scanned. See [capability status](project-status.md) for the current discovery limitations.

![Search history: a saved run summary and search counts](screenshots/search-history.png)

## Learn from progress and outcomes

Insights shows the application funnel, progress against weekly targets, and recorded reasons for skipped or rejected roles. Use those signals to revisit your priorities and search preferences.

![Insights: application funnel, weekly progress, and recorded feedback](screenshots/insights.png)

## Keep your network and sources organised

Agencies holds recruiter contacts, specialisms, outreach status, and notes. It is a directory and tracking tool; adding an agency does not send a message.

![Agencies: contact details and outreach tracking for fictional recruiting firms](screenshots/agencies.png)

Watchlist keeps companies, job boards, and alerts together, including priority, cadence, last check, and findings. These entries guide your search; adding a URL does not automatically install a connector for that site.

![Watchlist: prioritised sources with check cadence and recorded findings](screenshots/watchlist.png)

## Make the search yours

Settings separates factual CV content from search preferences. Set target roles, minimum fit, languages, exclusions, locations, work arrangements, and weekly targets. Workspace identity and timezone are configurable too.

![Search preferences: role targets, fit threshold, languages, and exclusions](screenshots/search-preferences.png)

![Location preferences: office locations, travel radius, and remote-work scope](screenshots/locations.png)

Schedule settings control when searches are due, their budgets, and which configured executor handles each kind of work. A separate scheduler clock must be installed to act on this configuration. The [complete hosted-stack example](reference-stack.md) connects those pieces. Notification preferences also require a delivery integration; they do not create one by themselves.

![Schedule: paused automation, bounded search settings, and executor controls](screenshots/schedule.png)

## Use the same workspace on your phone

The layout adapts to a narrow screen, with primary navigation at the bottom and the remaining sections under More. The mobile view uses the same data and decisions as desktop.

<img src="screenshots/mobile-dashboard.png" alt="Mobile Home: weekly progress and pending decisions above bottom navigation" width="390">

## Try it or build on it

- [Local installation](installation.md): Node.js and PostgreSQL, with automation optional.
- [Complete Neon, Vercel, and Hermes example](reference-stack.md): configuration, adapters, a queue clock, and verification.
- [Recreate these screenshots](../examples/demo/README.md): safe fictional data and the browser capture command.
- [Agent contributor guide](../AGENTS.md): where the code and contracts live.
