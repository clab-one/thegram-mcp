---
name: thegram-memory
description: Read and write Thegram project memory and documents through the thegram MCP tools. Use for decisions, history, project documents (.gram by default) and backfilling memory from git history.
---

# Thegram project memory

Tools are the `thegram` MCP server's `gram_<name>` tools. In OMP, call one by writing its JSON arguments to `xd://mcp__thegram_gram_<name>`.

## Session

1. Start from the injected brief, or call `gram_brief {folder}`. If the plugin reported an error, call `gram_projects` first.
2. Only the main agent writes; subagents return candidate records. Write one patch per durable outcome when it happens: a decision, a shipped change or incident, a risk, task or blocker, a verified metric, a status change.
3. Before the final answer, every task you opened is `completed`, `blocked` or deliberately `active`, and every open question is an open decision (`open`, or `proposed` in a template).

## Documents

- `<project>/memory.gram` has Overview, Architecture, Plan, Decisions and Log; other names and folders are free. Reuse documents; write them as `.gram`, `.md` only for README or when the user asks.
- A new document starts from a template: `schedule@1` for schedules and journals, `project@1` for tasks and projects (and `memory.gram`), `knowledge@1` for research, knowledge and operations notes. Write by `gram_profile {topic: "templates"}`: required fields, `x` values, action ids.
- A document without a template stays so. `~project@1` in `gram_brief`/`gram_list` is only a suggestion; `set doc template` only when the user asks.
- Schedules: one event per occurrence, never a recurrence rule; a completion time goes in `done`, never inferred from history.
- Documents hold any prose, tables and code; the durable-outcome rule is for memory records. See `gram_profile {task: "create"}` or `{task: "rich"}`.

## Mounts

`gram_projects` lists mounts (Google Drive, other vaults) with key, id, kind, name, count and access. Use the exact key as the path prefix, e.g. `@mounts/<id>/proj/memory.gram`; the name is display only. Access never exceeds the agent approval: read-only mounts reject writes with `E_READ_ONLY`, and vault mounts take writes only to top-level `.gram` documents (`E_PATH`). A write reached the remote only when it returns `sync.state` `synced`.

## Read

- Orient: `gram_brief {folder}` gives each document's `rev`/`hash`, counts, open work and `next`; `gram_changes {folder, since}` lists later changes.
- Find: `gram_recall {query, folder}` returns `path#id` hits; read them with `gram_context {ids, fields: [...]}`. `gram_relations {from}` lists links both ways.
- `gram_read {path}` gives the outline; `{path, section}` one section, a line per record (title, type, id, x, p, dates, value) with `d` under it. There is no `records` array.
- Decisions have no date field; their date is the earliest event that `implements` them (`implemented` in `gram_context`/`gram_get`).
- Dates: inclusive from/to or a date/month/year query; default field event at, metric observed, task due, otherwise at (`date` picks another).
- `scope` in recall is exact s-tag membership; `type` is record type. Prefer hybrid or keyword when semantic hits look loose; if hits miss, retry once with another mode, wording or date filter.
- History: `gram_range {path, query}` lists revisions that changed matching records, `{path, start: 0}` all of them with `effective_at` (pass `more` as `start`).
- Past state: `effective_at`, `revision` or `recorded_at` on `gram_read`, `gram_get` and `gram_list {path}`, in `gram_state`'s `selector`, and per `gram_context` `ids[]` item; `gram_list` with `select` ignores them.

## Write

Each `gram_patch` or `gram_create` is one revision. Write to the head: leave out `base_revision`/`expected_hash`.

```json
{"path": "<project>/memory.gram", "request_id": "<stable-slug>", "operations": []}
```

Each `set`/`unset` carries `old`, what you read (a string, an array for several, `null` if empty); `E_PRECONDITION` comes only when one of those fields changed, never for edits elsewhere. `remove` and whole-body `text`/`drop-text`/`rich` need `base_revision` and `expected_hash` from `gram_brief` or your last write's `doc`. Pass `effective_at` only for past facts, a full ISO time with a zone. The app retries `E_BUSY`.

| op | shape |
|---|---|
| add | `{"op":"add","record":{"type":"decision","id":"dec-<slug>","fields":{"t":["…"],"d":["…"],"x":["accepted"]},"links":[["part-of","prj-<slug>"]]},"place":{"section":"Decisions"}}` |
| set | `{"op":"set","entity":"task-<slug>","key":"x","value":"completed","old":"active"}`; several values: `"values":["ui","api"]` |
| link, unlink | `{"op":"link","entity":"dec-new","predicate":"replaces","target":"dec-old"}` |
| edit-text | `{"op":"edit-text","entity":"doc","kind":"rich","old":"<exact text, once>","new":"…"}` |

- `add` values are arrays; `set` takes `value` or `values`. Never remove a record; change its status.
- `place` is `{"section": "<heading>"}`, `{"after": "<id>"}` or `"end"` (without it the record is not in the body) and cannot share a patch with `edit-text`. Inside `edit-text`, `[[id]]` alone on a line places a record and `[label](@id)` mentions one.
- Operations run in order; later ones can link to or place after records added earlier.
- A listed template action names itself: `"action": "task.set-status", "action_target": "task-<slug>"`, with exactly its operations, each with `old`. An action takes only its own fields (`task.add` has no `d`); otherwise write without `action`.

A new memory is one `gram_create`. Records in it may link to each other in any order; only records placed as `[[id]]` in `text` are in the body. Without `content` a template starts from its own headings.

```json
{"path": "<project>/memory.gram", "title": "…", "base_revision": null, "template": "project@1",
 "content": {"text": "# Overview\n\n[[prj-<slug>]]\n\n# Architecture\n\n# Plan\n\n# Decisions\n\n# Log\n",
             "fields": {"d": ["<one-line summary>"]},
             "records": [{"type": "project", "id": "prj-<slug>", "fields": {"t": ["…"], "d": ["…"], "x": ["active"]}}]}}
```

## Records

- Types: `project goal requirement assumption decision task blocker risk event artifact evidence metric component system service source history knowledge context person agent run asset`. Others are rejected.
- Fields: t (required, one line), d, x, p, owner, tag, source, ref, s (scope tag); due on tasks, at on events, value/unit/observed on metrics; plus the template's. Other valid keys warn `W_EXTENSION_FIELD`, invalid ones fail `E_FIELD`. `source` must name a `source` record; otherwise cite with `ref`.
- Predicates: `part-of implements depends derives related supports contradicts replaces blocks enables`. Others are stored but never read back as links.
- Without a template `x` is free text (the table below); a misspelled status shows as open, a task or risk without `x` never does. A template takes only its listed values: in `project@1` an open decision is `proposed`, a dropped task `cancelled`, a closed risk `resolved`.

| type | `x` |
|---|---|
| task, risk, blocker | `open`, `active` (in progress), `blocked`, `completed`; dropped: `superseded` |
| decision | `accepted`; open question `open`; replaced `superseded` |
| goal, project | `active`, then `completed` |
| requirement, assumption | `accepted`, then `superseded` |
| component, system, event, evidence, artifact | none |

- One fact per record: one-line `t`, one-sentence `d` stating the outcome.
- Sections: Overview (project, metrics), Architecture (components), Plan (goals, requirements, assumptions, tasks, risks, blockers), Decisions, Log (history, events, artifacts, evidence).
- Every record needs an explicit link path to the project: component, decision, goal, requirement, assumption, history and metric `part-of` project; event `implements` the decisions it carried out (else `part-of`); artifact `derives` its event; evidence `supports` a decision or risk; task `part-of` its goal; other tasks, risks and blockers `related` to what they concern.
- Replace a decision: `set x superseded` on the old one and `link replaces` from the new one.
- Events have `at` (ISO date or time) and a `ref` to the commit, PR or release.

## Dashboard and diagrams

The app draws each document's dashboard from its records and history, and Mermaid flowcharts in the body.

- A metric chart is one record's history: one `metric` per quantity with a stable id; each measurement is one patch setting `value` and `observed`, never a new record.
- `value` is a plain number (`-?digits[.digits]`); anything else shows as text. Keep `unit` constant (`percent` shows as `%`); a new unit starts a new series. `observed` is a full ISO time with a zone.
- Goal progress is the `completed` share of same-document tasks linked to it. The overview counts blocked tasks, open blockers and risks, and open decisions or requirements; `d` on `doc` is the summary, and `set doc view dashboard` opens the dashboard.
- Mermaid: only `flowchart` and `graph` blocks are drawn, the system diagram under Architecture. Label only `-->` edges; a labeled `==>` or `-.->` line is dropped.

## Errors

| code | cause → fix |
|---|---|
| `E_PRECONDITION` | a field you read changed, the id exists with other content, or a `place` target is gone (`details.conditions`) → reread, decide, resend with a new `request_id` |
| `E_TEMPLATE` | the write breaks the template; `details.diagnostics` names record, field, expected → fix them |
| `E_ACTION` | operations do not match the named action → use exactly its operations with `old`, or resend without `action` |
| `STALE_REVISION`, `E_CAS_REQUIRED` | with `base_revision`, another revision landed; `remove` or a body replacement without it → `gram_brief`, recheck, resend with a new `request_id` |
| `E_ARGUMENT` | field value not an array, `set` without `old` at the head, `place` with `edit-text`, or unknown section |
| `E_FIELD`, `E_LINK`, `E_TIME`, `E_MISSING_TITLE` | bad field key, unknown predicate, `effective_at` without time or zone, no `t` |
| `E_MISSING_TARGET`, `E_MISSING_SOURCE` | link target not added yet; `source` names a non-`source` record → add it first, or cite with `ref` |
| `E_AMBIGUOUS_TEXT` | `edit-text` `old` not found exactly once → copy from `gram_read`, widen it |
| `E_DUPLICATE_ID`, `E_DUPLICATE_FIELD` | id exists (with `base_revision`) → `set` that record; unknown `type` |
| `E_REQUEST_REUSE` | `request_id` already used for a different request → new id |
| `E_READ_ONLY`, `E_PATH` | read-only mount; bad path or nested vault-mount write |

One `request_id` per intended change. After an error, fix the request and use a new id. After a lost answer, resend the identical request with the same id; if it landed, Thegram replays the receipt (`"replayed": true`).

## Backfill

To build memory from project history, follow [backfill.md](backfill.md).
