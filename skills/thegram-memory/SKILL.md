---
name: thegram-memory
description: Read and write a project's Thegram memory (~/gram/<project>/*.gram) with the thegram MCP tools. Use it to orient in a project, to record decisions, events, risks and tasks as they happen instead of repository docs, to read past states, and to backfill a memory from git history.
---

# Thegram project memory

Decisions, status and history are recorded here, not in `docs/` or other md files. The tools are the `thegram` MCP server's `gram_<name>` tools; in OMP, call one by writing its JSON arguments to `xd://mcp__thegram_gram_<name>`. Tool behaviour below is for Thegram 0.5.2, where section lines carry ids, dates and values.

## Session

1. Start from the brief that the thegram-memory plugin injected, or call `gram_brief {folder}`. If the plugin reported an error, call `gram_projects` first.
2. Only the main agent writes; a subagent returns candidate records. Write one patch per durable outcome (a decision, a shipped change or incident, a risk, task or blocker, a verified metric, a status change) when it happens.
3. Before the final answer, every task you opened is `completed`, `blocked` or deliberately `active`, and every open question is a decision with `x open`.

## Read

- Orient: `gram_brief {folder}` returns each document's `rev`/`hash`, counts, open work and `next`; `gram_changes {folder, since}` lists later changes.
- Find: `gram_recall {query, folder}` returns `path#id` hits; read selected records with `gram_context {ids, fields: [...]}`. `gram_read {path}` gives the outline; `{path, section}` gives one section. Lines are ``**title** · type `id`[ · x][ · p][ · at][ · due date][ · value unit @ observed][ · replaces ids]``; type/x/p are raw, `d` follows next, and there is no `records` array.
- Cheapest read: explore with recall summaries, then read the records you act on with `gram_context` and only the `fields` you need; use `gram_read {path, section}` when a whole section is needed. `keyword` requires every query word inside one record, so prefer `auto` or `hybrid`. Semantic hits have no relevance floor: judge them by their summaries.
- When and why: `gram_range {path, query}` returns revisions that changed matching records.
- Past reads: `effective_at` (or `revision`, `recorded_at`) works on `gram_read`, `gram_get` and `gram_list {path: <.gram>}` as arguments, on `gram_state` inside `selector` and on `gram_context` inside each `ids[]` item. `gram_list` with `select` ignores `revision` and `effective_at`. `gram_range {path, start: 0}` lists revisions with their `effective_at` (pass `more` as `start`).

## Write

Each `gram_patch` or `gram_create` is one revision:

```json
{"path": "<project>/memory.gram", "base_revision": 7, "expected_hash": "<16 hex>", "request_id": "<stable-slug>", "operations": []}
```

`base_revision` and `expected_hash` come from `gram_brief`, or from the `doc` of the write you just made. Give `effective_at` only for a past fact, as a full ISO time with a zone (`2025-01-02T03:04:05Z`, `2025-01-02T12:04:05+09:00`).

| op | shape |
|---|---|
| add | `{"op":"add","record":{"type":"decision","id":"dec-<slug>","fields":{"t":["…"],"d":["…"],"x":["accepted"]},"links":[["part-of","prj-<slug>"]]},"place":{"section":"Decisions"}}` |
| set | `{"op":"set","entity":"dec-<slug>","key":"x","value":"superseded"}` |
| link, unlink | `{"op":"link","entity":"dec-new","predicate":"replaces","target":"dec-old"}` |
| edit-text | `{"op":"edit-text","entity":"doc","kind":"rich","old":"<exact text, once>","new":"…"}` |

- `add` field values are arrays; `set` takes one string.
- `place` is `{"section": "<heading>"}`, `{"after": "<id>"}` or `"end"`. A record added without `place` exists but is not in the body.
- `place` cannot share a patch with `edit-text`. In `edit-text`, `[[id]]` on its own line places a record and `[label](@id)` mentions one.
- Operations apply in order, so a later one may link to or place after a record added earlier in the same patch.
- Never `remove` a record; change its status instead.

## Records

- Types: `project goal requirement assumption decision task blocker risk event artifact evidence metric component system service source history knowledge context person agent run asset`. Any other type fails with a misleading `E_DUPLICATE_FIELD`.
- Fields: `t` (required, one line), `d`, `x`, `p` (`high`, `medium`, `low`), `owner`, `tag`, `source`, `ref`; `due` on a task, `at` on an event, `value`, `unit` and `observed` on a metric. `source` must name a `source` record; otherwise cite with `ref`.
- Predicates: use only `part-of implements depends derives related supports contradicts replaces blocks enables`. An `add` with another predicate succeeds, but `gram_get`, `gram_context` and `gram_relations` never return that link.
- Status `x` accepts any string, and the brief lists a misspelled status as open. A task or risk without `x` never appears in the brief's open list.

| type | `x` |
|---|---|
| task, risk, blocker | `open`, `active` (work under way; shown as in progress), `blocked`, `completed`; a dropped task `superseded` |
| decision | `accepted`; an open question `open`; a replaced one `superseded` |
| goal, project | `active`, then `completed` |
| requirement, assumption | `accepted`, then `superseded` |
| component, system, event, evidence, artifact | none |

- One fact per record: `t` is one line and `d` is one sentence that states the outcome.
- Sections: Overview (project, metrics), Architecture (components), Plan (goals, requirements, assumptions, tasks, risks, blockers), Decisions, Log (history, events, artifacts, evidence).
- The graph draws only explicit links, and every record needs a path to the project. Link a component `part-of` the project, and optionally `implements` a decision or `depends` another component. Link a decision, goal, requirement, assumption or history record `part-of` the project. Link an event `implements` the decisions it carried out, otherwise `part-of` the project. Link an artifact `derives` its event, evidence `supports` a decision or risk, a task `part-of` the goal it serves, a metric `part-of` the project, and otherwise a task, risk or blocker `related` to what it concerns.
- To replace a decision, `set x superseded` on the old record and `link replaces` from the new one.
- An event has `at` (ISO date or time) and a `ref` to its commit, PR or release.

A new project memory is one `gram_create`. Records in it may link to each other in any order; a record not placed as `[[id]]` in `text` is not in the body.

```json
{"path": "<project>/memory.gram", "title": "…", "base_revision": null,
 "content": {"text": "# Overview\n\n[[prj-<slug>]]\n\n# Architecture\n\n# Plan\n\n# Decisions\n\n# Log\n",
             "fields": {"d": ["<one-line summary>"]},
             "records": [{"type": "project", "id": "prj-<slug>", "fields": {"t": ["…"], "d": ["…"], "x": ["active"]}}]}}
```

## What the app draws

The desktop app draws a dashboard (대시보드) for every document from its records and history, and Mermaid flowcharts in the body.

- A metric's chart is the history of that one record. Keep one `metric` per measured quantity with a stable id, and record each new measurement in one patch: `{"op":"set","entity":"met-<slug>","key":"value","value":"42"}` plus `{"op":"set","entity":"met-<slug>","key":"observed","value":"2026-10-10T09:00:00+09:00"}`. A new record per measurement or per era is a single point and never becomes a chart.
- `value` is one plain number (`-?digits[.digits]`: no unit, `,`, `~` or `%`); anything else shows as text without a chart. Keep `unit` constant (`percent` shows as `%`); another unit starts a new series. `observed` is when the value was measured, as a full ISO time with a zone; when every point has one, the chart's axis is time.
- A goal shows progress as the `completed` share of the tasks in the same document that link to it, superseded ones excluded, so link each task to its goal.
- The overview counts what needs a person: `blocked` tasks, open blockers and risks, and decisions or requirements with `x open`. Tasks appear in status lanes, events on a timeline by `at`, and the document's `d` as its summary line.
- `{"op":"set","entity":"doc","key":"view","value":"dashboard"}` makes the document open as a dashboard; set `d` on `doc` the same way.
- Diagrams: write Mermaid in a code block with language `mermaid`; the document view draws `flowchart` and `graph` diagrams, and other kinds stay as source. Put the system diagram under Architecture. Label only `-->` edges: a line with a label on `==>` or `-.->` is silently dropped.

## Errors

| code | cause → fix |
|---|---|
| `STALE_REVISION` | another revision landed → `gram_brief`, check the change is still needed, resend under a new `request_id` |
| `E_ARGUMENT` | field value not an array, `set` value not a string, `place` with `edit-text`, or unknown section |
| `E_MISSING_TITLE` | no `t` |
| `E_FIELD` | field key outside the list (e.g. `next_action`) |
| `E_MISSING_TARGET` | a link names an id that does not exist yet → add the target first |
| `E_MISSING_SOURCE` | `source` names a non-`source` record → use `ref` |
| `E_AMBIGUOUS_TEXT` | `edit-text` `old` not found exactly once → copy it from `gram_read`, widen it |
| `E_DUPLICATE_ID` | id exists → `set` that record or pick another id |
| `E_DUPLICATE_FIELD` | unknown `type` |
| `E_LINK` | `link`/`unlink` with an unknown predicate |
| `E_TIME` | `effective_at` without a time or zone |
| `E_REQUEST_REUSE` | the `request_id` already succeeded with a different request → new id |

Use one `request_id` per intended change. After an error, fix the request and resend it under a new id. After a lost answer, resend the identical request with the same id; if it had landed, Thegram replays its receipt (`"replayed": true`).

## Backfill

To build a memory from project history, follow [backfill.md](backfill.md).
