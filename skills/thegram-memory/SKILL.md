---
name: thegram-memory
description: Read and write Thegram project memory and documents through the thegram MCP tools. Use for decisions, history, project documents (.gram by default) and backfilling memory from git history.
---

# Thegram project memory

Tools are the `thegram` MCP server's `gram_<name>` tools. In OMP, call one by writing its JSON arguments to `xd://mcp__thegram_gram_<name>`.

## Session

1. Start from the injected brief, or call `gram_brief {folder}`. If the plugin reported an error, call `gram_projects` first.
2. Only the main agent writes; subagents return candidate records. Write one patch per durable outcome when it happens: a decision, a shipped change or incident, a risk, task or blocker, a verified metric, a status change.
3. Before the final answer, every task you opened is `completed`, `blocked` or deliberately `active`, and every open question is a decision with `x open`.

## Documents

- `<project>/memory.gram` has Overview, Architecture, Plan, Decisions and Log. Other names and folders are free; reuse existing documents.
- Write project documents as `.gram`. Use `.md` only for README or when the user asks; no Markdown copies.
- Documents can hold any prose, tables and code; the durable-outcome rule only applies to memory records. See `gram_profile {task: "create"}` or `{task: "rich"}`.

## Mounts

`gram_projects` lists mounts (Google Drive, other vaults) with key, id, kind, name, document count and access. Use the exact key as the path prefix, e.g. `@mounts/<id>/proj/memory.gram`; the key alone is the folder for the whole mount. The name is display only. Everything else works as for local documents.

- Access never exceeds the agent approval for the Thegram folder. Read-only mounts reject writes with `E_READ_ONLY`.
- Vault mounts accept writes only to top-level `.gram` documents; nested writes fail with `E_PATH`.
- Reads use the local synced copy. A write reached the remote only when it returns `sync.state` `synced` (otherwise check `sync.error`).
- Semantic recall includes mounted documents.

## Read

- Orient: `gram_brief {folder}` gives each document's `rev`/`hash`, counts, open work and `next`; `gram_changes {folder, since}` lists later changes.
- Find: `gram_recall {query, folder}` returns `path#id` hits; read them with `gram_context {ids, fields: [...]}`. `gram_relations {from}` lists links both ways.
- `gram_read {path}` gives the outline; `{path, section}` gives one section. Lines look like ``**title** · type `id`[ · x][ · p][ · at][ · due date][ · value unit @ observed][ · replaces ids]``, with `d` on the next line. There is no `records` array.
- Decisions have no date field. Their date is the earliest event that `implements` them (shown in `gram_read`, and as `implemented` in `gram_context`/`gram_get`).
- Dates: use inclusive from/to filters or a date/month/year query. Default date field: event at, metric observed, task due, otherwise at; `date` picks another. Keep ids as short slugs; dates in titles are optional and never a search workaround.
- `scope` in recall means exact s-tag membership, not section or type; use `type` for record type. Semantic hits have no relevance floor, so prefer hybrid or keyword when they look loose. If hits miss, retry once with another mode, wording or date filter.
- History: `gram_range {path, query}` returns revisions that changed matching records; `gram_range {path, start: 0}` lists all revisions with `effective_at` (pass `more` back as `start`).
- Past state: `effective_at`, `revision` or `recorded_at` as arguments on `gram_read`, `gram_get` and `gram_list {path: <.gram>}`; inside `selector` on `gram_state`; inside each `ids[]` item on `gram_context`. `gram_list` with `select` ignores them; use its date filters.

## Write

Each `gram_patch` or `gram_create` is one revision:

```json
{"path": "<project>/memory.gram", "base_revision": 7, "expected_hash": "<16 hex>", "request_id": "<stable-slug>", "operations": []}
```

Take `base_revision`/`expected_hash` from `gram_brief` or from the `doc` of your last write. Pass `effective_at` only for past facts, as a full ISO time with a zone (`2025-01-02T03:04:05Z`). The app retries `E_BUSY` itself.

| op | shape |
|---|---|
| add | `{"op":"add","record":{"type":"decision","id":"dec-<slug>","fields":{"t":["…"],"d":["…"],"x":["accepted"]},"links":[["part-of","prj-<slug>"]]},"place":{"section":"Decisions"}}` |
| set | `{"op":"set","entity":"dec-<slug>","key":"x","value":"superseded"}` |
| link, unlink | `{"op":"link","entity":"dec-new","predicate":"replaces","target":"dec-old"}` |
| edit-text | `{"op":"edit-text","entity":"doc","kind":"rich","old":"<exact text, once>","new":"…"}` |

- `add` values are arrays; `set` takes one string.
- `place` is `{"section": "<heading>"}`, `{"after": "<id>"}` or `"end"`. Without `place` the record exists but is not in the body.
- `place` cannot share a patch with `edit-text`. Inside `edit-text`, `[[id]]` on its own line places a record and `[label](@id)` mentions one.
- Operations run in order, so later ones can link to or place after records added earlier in the same patch.
- Never remove a record; change its status.

A new memory is one `gram_create`. Records in it may link to each other in any order; only records placed as `[[id]]` in `text` are in the body.

```json
{"path": "<project>/memory.gram", "title": "…", "base_revision": null,
 "content": {"text": "# Overview\n\n[[prj-<slug>]]\n\n# Architecture\n\n# Plan\n\n# Decisions\n\n# Log\n",
             "fields": {"d": ["<one-line summary>"]},
             "records": [{"type": "project", "id": "prj-<slug>", "fields": {"t": ["…"], "d": ["…"], "x": ["active"]}}]}}
```

## Records

- Types: `project goal requirement assumption decision task blocker risk event artifact evidence metric component system service source history knowledge context person agent run asset`. Others are rejected.
- Fields: t (required, one line), d, x, p (high, medium, low), owner, tag, source, ref, s (scope tag); due on tasks, at on events, value/unit/observed on metrics. Other valid keys are stored with `W_EXTENSION_FIELD`; use them only on purpose. Invalid keys fail with `E_FIELD`. `source` must name a `source` record; otherwise cite with `ref`.
- Predicates: `part-of implements depends derives related supports contradicts replaces blocks enables`. Other predicates are accepted on add but never returned by `gram_get`, `gram_context` or `gram_relations`.
- `x` accepts any string, and the brief shows a misspelled status as open. A task or risk without `x` never shows as open.

| type | `x` |
|---|---|
| task, risk, blocker | `open`, `active` (in progress), `blocked`, `completed`; dropped: `superseded` |
| decision | `accepted`; open question `open`; replaced `superseded` |
| goal, project | `active`, then `completed` |
| requirement, assumption | `accepted`, then `superseded` |
| component, system, event, evidence, artifact | none |

- One fact per record: one-line `t`, one-sentence `d` stating the outcome.
- Sections: Overview (project, metrics), Architecture (components), Plan (goals, requirements, assumptions, tasks, risks, blockers), Decisions, Log (history, events, artifacts, evidence).
- Every record needs a link path to the project; the graph draws only explicit links.
  - component `part-of` project; optionally `implements` a decision or `depends` on another component
  - decision, goal, requirement, assumption, history, metric `part-of` project
  - event `implements` the decisions it carried out, otherwise `part-of` project
  - artifact `derives` its event; evidence `supports` a decision or risk; task `part-of` its goal
  - other tasks, risks and blockers `related` to what they concern
- Replace a decision: `set x superseded` on the old one and `link replaces` from the new one.
- Events have `at` (ISO date or time) and a `ref` to the commit, PR or release.

## Projection views

Write source facts for deterministic template selection; the app/Viewer chooses the template. Do not create a screen or author `ViewSpec`. Journal: use `event` + `at` for occurrence time, not dated prose headings; set `effective_at` only for a sourced past fact. Project: give tasks `x` and link each task to its goal. Operations: give risks `x`; tag incident events `incident`, `outage` or `failure` and link them to the risk; link recovery events to evidence with `supports`; metrics need `value`, `unit` and `observed`. Unsupported states stay `unknown`. Follow `spec/projection.md` (“Evidence-based state”, “Dated section entries”, “View resolution and ViewSpec/1”, `status_counts` and `progress`).
## Dashboard and diagrams

The app draws a dashboard for every document from its records and history, and Mermaid flowcharts in the body.

- A metric chart is the history of one record. Keep one `metric` per quantity with a stable id and record each measurement in one patch: `set value` plus `set observed`, e.g. `{"op":"set","entity":"met-<slug>","key":"value","value":"42"}` and `{"op":"set","entity":"met-<slug>","key":"observed","value":"2026-10-10T09:00:00+09:00"}`. A new record per measurement is a single point, never a chart.
- `value` is a plain number (`-?digits[.digits]`, no unit, `,`, `~` or `%`); anything else shows as text. Keep `unit` constant (`percent` shows as `%`); a new unit starts a new series. `observed` is a full ISO time with a zone; when every point has one, the axis is time.
- Goal progress is the `completed` share of tasks in the same document linked to it (superseded excluded).
- The overview counts what needs a person: `blocked` tasks, open blockers and risks, and decisions or requirements with `x open`. Tasks show in status lanes, events on a timeline by `at`, and the document's `d` as its summary.
- `{"op":"set","entity":"doc","key":"view","value":"dashboard"}` opens the document as a dashboard; set `d` on `doc` the same way.
- Mermaid: use a `mermaid` code block. Only `flowchart` and `graph` are drawn; other kinds stay as source. Put the system diagram under Architecture. Label only `-->` edges; a labeled `==>` or `-.->` line is dropped.

## Errors

| code | cause → fix |
|---|---|
| `STALE_REVISION` | another revision landed → `gram_brief`, check the change is still needed, resend with a new `request_id` |
| `E_ARGUMENT` | field value not an array, `set` value not a string, `place` with `edit-text`, or unknown section |
| `E_MISSING_TITLE` | no `t` |
| `E_FIELD` | invalid field key |
| `E_MISSING_TARGET` | link target does not exist yet → add it first |
| `E_MISSING_SOURCE` | `source` names a non-`source` record → use `ref` |
| `E_AMBIGUOUS_TEXT` | `edit-text` `old` not found exactly once → copy from `gram_read`, widen it |
| `E_DUPLICATE_ID` | id exists → `set` that record or pick another id |
| `E_DUPLICATE_FIELD` | unknown `type` |
| `E_LINK` | `link`/`unlink` with an unknown predicate |
| `E_TIME` | `effective_at` without a time or zone |
| `E_REQUEST_REUSE` | `request_id` already used for a different request → new id |
| `E_READ_ONLY` | write to a read-only mount |
| `E_PATH` | bad path, or nested write in a vault mount |

One `request_id` per intended change. After an error, fix the request and use a new id. After a lost answer, resend the identical request with the same id; if it landed, Thegram replays the receipt (`"replayed": true`).

## Backfill

To build memory from project history, follow [backfill.md](backfill.md).
