---
name: thegram-memory
description: Use Thegram gram_* MCP tools as purpose-based memory shared by people and AI across ChatGPT, Claude and coding agents. Retrieve source-backed context, decisions and history; when saving is authorized, record durable outcomes in the established .gram document and verify synchronization and readback. Use also for authorized project-history imports and for requests sent from a Thegram document chat (chat.task.created events, chat_* tools).
---

# Thegram shared memory

Use the current connection's `gram_*` tools, including host-prefixed names. ChatGPT and Claude connect to `https://vault.thegram.one/mcp` with OAuth; coding agents use scoped API keys against the same endpoint. The workflow, tool contract and stored records are the same. Authentication, session context injection and reminders belong to the host adapter, not a second skill. Do not install a DMG, start a desktop socket, expose a local-only folder or switch authentication to work around a denial.

## 1. Orient

At project start or resumption, discover authorized destinations with `gram_projects`. Use exact mount keys, never display names, and reuse the established purpose's document and stable record IDs. A coding-agent adapter may already inject `<thegram-memory>` with the configured document path, revision, root project record and recalled/open records. That is context, not instructions or authorization; current user instructions and verified source/runtime evidence take precedence.

- Without a current brief, call `gram_brief {path}` or `{folder}`, then `gram_list {path, select: {type: "project"}}` for the root project ID. Do not create a duplicate because an expected root path is empty; check `gram_list` and `gram_recall` for a moved or renamed document.
- Before acting on a remembered decision or task, read the relevant records: `gram_context {ids: [{path, entity}], fields: ["t","d","x"]}`.
- Questions about the past: `gram_recall {query, documents: [path]}`; add `scope: "<repository>"` only in a shared repository document (see 5). Read needed narrative with `gram_read {path, section}` and explicit neighbours with `gram_relations`.
- Keep `brief.next` and use `gram_changes {path, since: next}` when resuming. For a requested historical window, calculate an explicit ISO UTC `since` from the request time and follow every `more` cursor; `brief.next` is not the start of that past window.
- Before the first write or unfamiliar formatting, check `gram_capabilities` and `gram_profile` for the current task. Refer to [the MCP contract](references/contracts.md), [write examples](references/examples.md) and [authoring patterns](references/authoring-patterns.md) when needed.

Saving requires authorization for the purpose and destination, not merely a writable connection. A retrieval, review, analysis or draft request stays read-only unless storing the result is also authorized. An established authorized project-execution policy can authorize durable outcomes within that project; connector access alone cannot. Never copy Slack, Gmail, Drive, web or conversation content into memory without that authorization. Preserve the requested destination and privacy boundaries; never archive every message, raw source bodies, secrets or private assistant notes.

OAuth access is limited by the account's connected-agent grants; API-key access is further limited by that key's selected vaults/Drive accounts, permissions and lifetime. `gram_projects` lists the current agent's allowed mounts, not everything the person can see on the web. On `AGENT_SCOPE_DENIED`, stop and direct the person to Thegram Settings → Connected agents. Do not retry unchanged, change credentials or choose another destination. After the person changes scope, rediscover mounts and use fresh records before retrying.

## 2. What to record

Within an authorized purpose, keep one atomic fact per record and reuse existing identities. A commit, PR, report or chat is a source container, not a record type. One source may support several kinds of fact, or only source coverage.

### Classify before writing

1. Read the source body/diff and relevant follow-ups; separate choices, implementation, tracked work, observations and claims. Retain source identity, timestamp, scope and uncertainty for each fact.
2. Look up the existing fact/work/component/metric before adding anything. Update its fields and relations when the meaning is unchanged; repeated fixes do not create a new task lifecycle per commit.
3. Choose the type by meaning using the table below. Use only the current profile's fields, statuses and predicates. A merged implementation does not accept a proposed ADR, complete an entire task, or prove deployment or successful verification.
4. Add only relations the source establishes, in the stated direction. `A depends B` does not imply `B supports A`. For partial replacement, retain the still-applicable old decision and describe the changed scope with `related`; reserve `replaces` plus old `superseded` for full replacement.
5. Preserve source time separately from this write's runtime recording time. Reconcile current state and supported widget requirements, then submit the smallest sourced delta. No fact worth a record means no domain record; source coverage can still account for inspected material.

| Atomic meaning | Record/update | Section and relation | State boundary |
|---|---|---|---|
| a choice, proposed alternative or adopted policy | `decision` | Decisions; `part-of` project | `proposed` until a person accepts it, then `accepted`; `rejected`, or `superseded` when fully replaced |
| a desired outcome, required behavior or untested premise | `goal`, `requirement` or `assumption` respectively | Plan; `part-of` project/goal as sourced | do not infer these merely to fill a widget |
| tracked work or a sourced change to its progress | existing `task`, or add a genuinely sourced work item | Plan; `part-of` goal/project | partial → retain active work; review/unmerged PR → `review` when supported; `completed` only for the work's verified completion |
| architecture responsibility, interface or dependency | existing/new `component`, `system` or `service` | Architecture; `depends` in the sourced direction | code existence does not establish runtime health |
| possible harm versus an actual impediment | `risk` versus `blocker`; update affected task if sourced | Plan; `related` concern or blocker `blocks` task | `mitigated` while the harm is reduced but still possible, `resolved` once it is gone; do not invent priority, owner or due date |
| observation, test or report supporting/contradicting a claim | `evidence` | Log; `supports` or `contradicts` the claim | failed verification is evidence of failure; a source report is not this agent's runtime verification |
| reusable explanation or constraint | `knowledge` (or `context` for situational background) | relevant existing section; `part-of` project | preserve scope and uncertainty |
| a comparable measured quantity | same `metric` ID; `set value` + `set observed` | relevant section; retain report via `source`/`ref` | same definition, denominator and unit; one observation is valid |
| an identifiable build, report or deliverable | `artifact` with `ref` | Log; `derives` only from an actual producing record | publishing an artifact alone does not require an event |
| a meaningful dated occurrence, incident, verified rollout or milestone | `event` with sourced `at` and `ref`/`source` | Log; `implements` only a demonstrated choice, else `part-of` project | no event per commit/merge/push; no guessed deployment or milestone |
| provenance or inspected low-signal material | reusable `source` or coverage note | cite near supported facts | routine image pins/formatting may need coverage only, with no event/task/evidence |

A factual outcome can update a task and component, explain a decision, and retain verification evidence from one commit. Do not fabricate completed historical tasks, intermediate statuses, events or revisions from its subject. Do not record chatter, raw logs, secrets, private assistant notes or every transient experiment. See [worked classification cases](references/examples.md) for ambiguous inputs.

An event's `at` is the actual occurrence time: a commit author date proves the commit time only, not a deployment time. Record source timestamps at their known precision in source descriptions or profile-supported source fields; do not force a decision or component onto a calendar with an invented `at`. Keep date-only facts date-only. `ref` is one URI others can open: a source permalink, release/PR URL or commit URL built from its actual remote. Never put a `file://` URL or a local path in `ref`; a local report stays in `d` with its path and hash, and without a remote retain the commit hash in provenance. Put a real source record ID, not a URL, in `source`.

## 3. One turn, one patch

After classification, write the whole outcome of a turn as one `gram_patch` against the head. Operations run in order, so later ones can link to records added earlier.

This example assumes a sourced full replacement and a retained passing check; it does not claim a release or deployment. Both closed records get a `d` that says how they ended.

```json
{"path": "@mounts/<vault-id>/<project>.gram", "request_id": "slugify-unicode",
 "operations": [
  {"op": "add", "record": {"type": "decision", "id": "dec-unicode-slugs",
    "fields": {"t": ["Keep Unicode letters in slugs"], "d": ["slugify keeps letters and digits of every script and joins the rest with one hyphen."], "x": ["accepted"]},
    "links": [["part-of", "prj-strings"], ["replaces", "dec-ascii-slugs"]]}, "place": {"section": "Decisions"}},
  {"op": "set", "entity": "dec-ascii-slugs", "key": "x", "value": "superseded", "old": "accepted"},
  {"op": "set", "entity": "dec-ascii-slugs", "key": "d", "value": "Replaced by keeping Unicode letters; slugs used to drop every non-ASCII character.", "old": "Slugs keep only ASCII letters and digits."},
  {"op": "add", "record": {"type": "evidence", "id": "evd-unicode-slugs",
    "fields": {"t": ["Unicode regression check"], "d": ["The retained local test report confirms '카페 Latte' maps to '카페-latte'."], "ref": ["https://example.com/reports/unicode-regression"]},
    "links": [["supports", "dec-unicode-slugs"]]}, "place": {"section": "Log"}},
  {"op": "set", "entity": "risk-ascii-only", "key": "x", "value": "resolved", "old": "open"},
  {"op": "set", "entity": "risk-ascii-only", "key": "d", "value": "Resolved: Korean titles now keep their letters in slugs, as the regression check shows.", "old": "Korean titles turn into empty slugs."},
  {"op": "link", "entity": "risk-ascii-only", "predicate": "related", "target": "evd-unicode-slugs"},
  {"op": "add", "record": {"type": "task", "id": "task-slug-length",
    "fields": {"t": ["Cap slug length"], "d": ["Very long titles still produce unbounded slugs."], "x": ["open"]},
    "links": [["part-of", "prj-strings"], ["related", "dec-unicode-slugs"]]}, "place": {"section": "Plan"}}
 ]}
```

- Every field value in `add` is an array; `set` takes `value` (or `values`) and `old`, exactly what you read (`null` when empty).
- Array syntax does not make a singular field repeatable: `t`, `d`, `x`, `at` and `ref` keep one value unless the current profile says otherwise. `tag`, `s` and `source` may repeat. Keep source attribution near the supported claim.
- `t` is a short title, never a time or id. `d` is one sentence stating the outcome.
- Ids are short slugs with a type prefix (`dec-`, `ev-`, `task-`, `risk-`, `art-`, `evd-`, `m-`), no dates.
- `place` is `{"section": "<heading>"}`, `{"after": "<id>"}` or `"end"`. A record without `place` is not in the body.
- A write landed only when the answer shows `sync.state: synced`. The final answer names the records (`path#id`, revision).

## 4. Status values

Every document follows one record vocabulary (`gram@1`); there is no template to choose. Each status belongs to one class, and the dashboard, `gram_brief`, `gram_recall {status}` and the graph all count by it: `open` still needs attention, `done` ended as intended, `closed` is no longer pursued. Check `gram_profile {topic: "templates"}` when unsure.

| type | open | done | closed |
|---|---|---|---|
| task | `backlog` `open` `active` `review` `blocked` `waiting` | `completed` | `cancelled` `archived` |
| goal | `open` `active` | `completed` | `cancelled` `archived` |
| project | `planning` `active` `at-risk` `on-hold` | `completed` | `cancelled` `archived` |
| decision | `proposed` | `accepted` | `rejected` `superseded` |
| risk | `open` `mitigated` | `resolved` | `accepted` `closed` |
| event | `confirmed` `tentative` | — | `cancelled` |
| blocker | `open` (no fixed list) | `completed` `resolved` | `closed` `cancelled` |

Task, goal, project, decision and risk need `x`; an event needs `at`, a metric `value` and `unit`, an artifact `ref`. Other optional fields: `p` (`urgent` `high` `medium` `low`), `owner`, `tag`, `due` (task, ISO date), `start` and `done` (task: when work began and finished). Unknown keys warn `W_EXTENSION_FIELD`.

Closing a record:

- When a status moves to `done` or `closed`, rewrite `d` in the same patch to say how it ended (what replaced it, how the harm went away). Keep the old situation as a clause when it helps; the revision history keeps the earlier text. Thegram marks a description that was written before the status change.
- Link the evidence or event that resolved a risk or blocker with `related`. `supports`/`contradicts` argue for or against a claim (a decision, requirement or knowledge), not that a risk is gone.
- `mitigated` stays open. Do not mark a risk `resolved` or a decision `accepted` without a source that says so; a merged change does not accept a proposal.
- Before changing a state, look for the same fact in the purpose's other documents (`gram_recall {query, folder}`, or each document's brief) and reconcile them in the same turn, one patch per document.

## 5. Documents

- A purpose can be a plan, research topic, shared project or everyday work, not only a Git repository. Reuse its established document and readable structure. An existing project document has Overview, Architecture, Plan, Decisions and Log; keep the overview, sources, decisions, evolution and unresolved work understandable without rebuilding context.
- Create a document only when authorized: one `gram_create` with `base_revision: null`, a short descriptive title, a body with the purpose's sections, a root purpose/project record and the first sourced records. Preserve the exact authorized mount, folder and path. Use an existing writable Cloud destination; use Drive only when requested. Create folders or move documents only when asked.
- For coding repositories, the adapter binds a document by `repo:<host/owner/name>` on its root project record, in any folder of an accessible vault (selected vault first). An explicit `projects.json` mapping wins. Without a binding tag the fallback is `<vault>/<repository>.gram`; reuse a moved document and follow the adapter's `bind` instruction rather than creating another.
- Several repositories can share one document through a directory mapping in `~/.config/thegram-memory/projects.json`. Put the current repository in `s` on its new records so `gram_recall {scope}` can filter it; do not add repository tags to unrelated personal purposes.
- Every document uses the same record types and statuses; shape it by its sections and records. Schedules use an event per occurrence and a completion time in `done`.
- Each document has one dashboard, editable by anyone who can write. Its view follows the records (Project Tracker, Journal, Knowledge, Operations; a document with `run` events opens on the automation widgets), and a person can apply a dashboard starter in the app. An older document's `template` line only hints the view; leave it.
- Link only within the document. For a record in another document, cite its URL in `ref` (cross-document targets stay unresolved).

### Scheduled automations

A document a scheduled run writes (a research digest, a monitor, a collected log) has one shape, and the 리서치, 감시·알림 and 수집 일지 dashboards read exactly it. Write each run as one patch:

1. Read what earlier runs left (`gram_list {path, select: {type}}`, `gram_recall` by URL or title). An item already recorded (same URL, release, notice or message) is not added again: `set` only the fields that changed on the existing record and leave its links alone, so it keeps pointing at the run that first found it.
2. Add one run record: `event`, `t` such as "리서치 실행", `at` the actual run time with its zone, `x` `confirmed`, `tag` `run` plus `failed:<source>` for every source that could not be read, `d` saying what was checked and how many new items, `part-of` the project. A run that finds nothing still records itself.
3. Each new item: `knowledge` for a news item, post or finding; `event` for something that happened or is scheduled (`at`, and `end` when the source gives one). Give it `ref` (the original URL), `at` (when it was published or happens; leave it out when the source gives no time), `tag` `source:<name>` (`news`, `hn`, `github`, `reddit`, `gmail`, `slack`, `calendar`, …) and `topic:<slug>` (one slug per story, the same on every source that covers it), link `derives` to this run only, and place it. Its ID comes from the item (`k-hn-41234567`, `ev-sui-testnet-v1-82-1`), never from the run time.
4. Each watched thing (a chain, server, repository or mailbox) is one record tagged `target`, created once and reused; every detection links `related` to its target.
5. What needs a person follows the automation's own rule in the root project's `d`. A change still ahead that someone must act on (an upgrade to apply, a price change to review) becomes a `task` due by its start; a possible harm nobody here can act on (a reboot during a provider's maintenance) is a `risk`, with `p` only when stated. A task is never created already overdue. Link either `related` to its item. Status belongs in `x` and dates, never in a title (`[완료]`, `[과거]`).
6. The schedule itself (cadence, sources, scope) is the root project's `d`; the dashboard reads the cadence from the runs, so never invent a run that did not happen.

## 6. Body and dashboard

- `[[id]]` alone on a line places a record; never place a record twice. `[label](@id)` mentions a record inside a sentence: the label is the words a reader needs there (`[the two remotes](@ctx-histories) share no ancestor`). Never append a bare mention after a finished sentence or table cell; it reads as a cut-off phrase. Mention instead of copying numbers.
- `[[*]]{type=risk status=open view=list}` shows matching records live as cards in the document view (not on the dashboard) without placing them; `view` is `list` or `table`.
- Callouts: `> [!note]` (or `tip`, `important`, `warning`, `caution`) followed by `> ` lines. Tables need a `|---|` row and equal cells.
- Prose changes use `{"op":"edit-text","entity":"doc","kind":"rich","old":"<exact text, once>","new":"…"}`; it cannot share a patch with `place`, so add records first, then edit text in the next patch. `gram_read` returns Markdown with mentions flattened to their labels; copy `old` from it but keep the `[label](@id)` syntax in `new`.
- Mermaid: only `flowchart`/`graph`; label only `-->` edges.
- For saved widgets, read [widget data contracts](references/widget-data.md) and, when exposed, `gram_profile {path, topic:"presentation"}`. Preserve the saved layout and report missing data or unavailable capabilities; never invent records, owners or dates to make a widget ready.
- Metrics: one `metric` record per quantity (`value` a plain number, constant `unit`, `observed` a past ISO time with zone). Each new measurement is `set value` + `set observed` on that record, never a new record.
- `d` on `doc` is the document summary; `set doc view dashboard` opens it on the dashboard.

## 7. What the dashboard counts

Widgets select stored records, their template states, relationships and real history; they do not turn commit prose into progress. Never add, split, relabel or complete records to move a number. With the person's consent, correct a misclassified record to the type its facts support (which may be a task update, decision, component, evidence, artifact, event or coverage only). Preserve useful content and provenance; removals require fresh CAS. Do not force every wrongly recorded commit into an event.

| Surface | Data needed | Authoring consequence |
|---|---|---|
| Task board/checklist and progress rings | selected tasks and their status class | track real work; update existing tasks from completion evidence; do not manufacture historical tasks |
| Goal progress | tasks with `part-of` that goal | `related` does not count; a goal with no linked tasks can remain without a ratio |
| Decisions/pending choices | decision `x`; full replacement `replaces` links | proposed stays proposed despite merged code; acceptance is distinct from implementation |
| Risk/attention | actual risks/blockers, explicit states and sourced priority | an empty attention list does not prove health |
| Calendar/timeline | event `at`, metric `observed`, other records' supported `due` | omit unknown dates; a source commit date is not every fact's occurrence date |
| Metric trend | same ID, numeric `value`, same `unit`, sourced `observed` and available history | retain real observations; never create revisions just to draw a line |
| Activity/revision history | actual runtime recording time and loaded revision history | imports remain recorded today; no fake commit-era activity |
| Automation (new items, runs, sources, watched targets) | `run` events; items with `derives` to their run, `ref`, `at`, `source:`/`topic:` tags; `target` records and `related` detections | one run record per real run; reuse items and targets; see Scheduled automations in 5 |
| Sync/team/presence/workspace | runtime/capability data | document records cannot fabricate live sync, membership, presence or access |

The inspected newer widget model counts completion as done ÷ (open + done), excluding closed and unknown states; older Core tracker summaries can use all-task totals. Check the target's current contract and selected records before explaining a percentage. Details, version limits and offline selector checks are in [widget-data.md](references/widget-data.md).

## 8. Read

- `gram_read {path}` outline; `{path, section}` one section as lines (title, type, id, x, dates, `d`).
- `gram_list {path, select: {type, status}}` filters; `gram_get {path, entity}` one record.
- `gram_relations {from: {path, entity}}` lists edges both ways.
- `gram_changes {path, since}` later changes; `gram_range {path, query}` revisions that touched matching records; past state via `revision`, `effective_at` or `recorded_at` on `gram_read`/`gram_get`/`gram_list {path}` and `gram_state {path, entity, selector}`.
- Some read views display a decision using its earliest implementing event date. That is an implementation date, not its acceptance date; leave it absent when no such event exists and retain documentary dates in provenance.
- Recall: `mode` `hybrid` or `keyword` when semantic hits look loose; date filters `from`/`to` (inclusive; `YYYY-MM` covers the month). Retry once with other wording before concluding nothing is recorded.

## 9. Reminders and the stop check

Coding-agent adapters can remind after file edits, commits or releases and can request one continuation when finishing. Cloud chat hosts need not expose those hooks. The reminder does not authorize a write or alter this workflow. Finish authorized work, report the result and reconcile relevant tasks as completed, blocked or superseded according to evidence; record only a qualifying outcome or explain why nothing was saved. Do not invent a background continuation, write filler to silence a hook, or make the user wait for unrelated memory work.

## 10. Errors

| code | cause → fix |
|---|---|
| `E_PRECONDITION` | a field you read changed, the id exists with other content, or a `place` target is gone (`details.conditions`) → reread, decide, resend with a new `request_id` |
| `E_TEMPLATE` | the write breaks the record vocabulary (a required field is missing, or the type has no such status); `details.diagnostics` names record, field, expected → fix them |
| `STALE_REVISION`, `E_CAS_REQUIRED` | with `base_revision`, another revision landed; `remove` or a body replacement without it → `gram_brief`, recheck, resend |
| `E_ARGUMENT` | value not an array, `set` without `old`, `place` with a body edit, unknown section or argument shape |
| `E_FIELD`, `E_LINK`, `E_TIME`, `E_MISSING_TITLE` | bad field key, unknown predicate, `effective_at` without time or zone, no `t` |
| `E_MISSING_TARGET`, `E_MISSING_SOURCE` | link target not added yet; `source` names a non-`source` record → add it first, or cite with `ref` |
| `E_AMBIGUOUS_TEXT` | `edit-text` `old` not found exactly once → copy from `gram_read`, widen it |
| `E_DUPLICATE_ID` | id exists → `set` that record or pick another id |
| `E_REQUEST_REUSE` | `request_id` already used for a different request → new id |
| `AGENT_SCOPE_DENIED`, `E_READ_ONLY`, `E_PATH` | the key, membership or policy denies it, or the path is invalid → report it; never switch to another mount or the desktop app |

One `request_id` per exact intended change. After a lost answer, reconcile the outcome and retry the identical request with its original ID; a landed write replays its receipt (`replayed:true`). On `E_PRECONDITION`, reread the affected fields, preserve concurrent edits and use a new request ID for a revised intent. Confirm `sync.state:synced` and fresh readback of changed prose, fields, statuses, links and revision before reporting saved; report storage and actual UI rendering separately. Only the main agent writes; subagents can supply candidates only when the user permits delegation. Never remove records that were true; change their status. Correct a wrongly classified record only with the person's consent.

## 11. Backfill

To build memory from project history, follow [backfill.md](backfill.md).

## 12. Document chat requests

A person can send a request from the chat of one Thegram document. It reaches you as a `chat.task.created` event (ChatGPT subscribes with `events/subscribe`; the event carries `task_id`, document title, message and URL) or through `chat_task_list` when the person asks you to handle their chat requests. The request is authorization to act on that one document only, within what it asks.

1. `chat_task_get {task_id}` takes the task and returns the message, the selected record, the person's time zone and local time, the recent conversation, the deadline and a brief of the bound document (`rev`/`hash` there are the CAS pair).
2. Read only with `chat_doc_read {task_id}`: the outline, then `{task_id, section}`, or `{task_id, entities: [...]}` for exact field values to use as `old`. No path argument exists; never use `gram_*` tools for a chat task, never touch another document.
3. Finish with one `chat_task_submit {task_id, reply, operations?}`. `reply` is shown to the person in their language: what changed, or the question you need answered. `operations` are `gram_patch` operations applied in one revision to the bound document; omit them when nothing should change. `remove` and whole-body text changes also need `base_revision` and `expected_hash` from the brief.
4. A rejected submission (`E_TEMPLATE`, `E_PRECONDITION`, `E_ARGUMENT`) leaves the task open: read again, fix and submit before the deadline. Resubmitting the identical call replays its result; `E_TASK_CLOSED` means the task already finished or expired, and `E_TASK_FORBIDDEN` that another connected agent holds it. Report it and stop.

Times come from the person's time zone: resolve "tomorrow 3 pm" against `local_time`, write `at` with its offset, and keep schedules to one event per occurrence.
