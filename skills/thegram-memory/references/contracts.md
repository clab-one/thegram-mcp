# Current cloud MCP contract

This reference describes the inspected cloud contract, not an installation or permission grant. The current connection's schemas, `gram_capabilities` and `gram_profile` win when versions differ.

## Connection and storage

Every host uses Streamable HTTP at `https://vault.thegram.one/mcp`: ChatGPT and Claude authenticate with OAuth, while coding agents authenticate with scoped API keys. Both use the same `gram_*` tools and this shared workflow. `gram_projects` returns `mounts` with `{key,id,kind,name,count,access}`; use `key` as the path prefix. A cloud vault filename before `.gram` must start with a letter/digit and contain at most 96 letters/digits/`_`/`-`. Vaults and Drive support folders. `gram_folder` and `gram_move` change the user's storage only when requested; after a move, the old path returns `E_NOT_FOUND`. Never substitute display names for keys or switch mounts after denial/conflict.

The server may create a default vault when an account has no writable vault during discovery; discovery does not authorize the agent to create memory records or capture other sources. `CONSENT_REQUIRED` and `PROVIDER_AUTH_REQUIRED` require the user's sign-up/reconnection flow. Preserve the requested storage destination.

`clab-one/thegram-mcp:skills/thegram-memory` is the canonical workflow and reference source for all hosts. ChatGPT/Claude ZIPs keep their existing `thegram-cloud` skill name but contain the same body and references, pinned by content hashes. Local Node adapters may inject a repository brief and reminders, but do not define a second record/write policy. The API key's grants and lifetime apply in addition to membership and account policy. No desktop app or DMG is needed; local-only files are not exposed or silently migrated. A successful write requires `sync.state:synced` and fresh readback, regardless of authentication.

## Selective reads

| Tool | Arguments and result to use |
| --- | --- |
| `gram_brief` | `{path}` or `{folder}`; `docs` rows are path/title/rev/hash/recorded/effective, then the template (`project@1` declared, `~project@1` Core's recommendation for an undeclared document, whose dashboard is read-only), plus open work and `next`. |
| `gram_changes` | `{path or folder, since}`; exclusive recording-time cursor. A requested historical window starts at an explicit ISO 8601 UTC `since` computed from the request time, not `gram_brief.next`; follow each `more`. One document also takes `since_revision`. |
| `gram_recall` | `{query, folder, mode?, type?, from?, to?, date?, top_k?, cursor?}`; `path#id` hits and document section hits. `scope` is exact `s` tag membership, not section/type. |
| `gram_context` | `{ids:[{path,entity}], fields:[...]}`; selected fields, links and bounded rich text. Request `observed` explicitly for metric dates; the default field set omits it. |
| `gram_read` | `{path}` gives outline; `{path,section}` gives one section's Markdown. Use outline heading/node IDs for ambiguous section names. |
| `gram_list` | `{path,select:{type?,status?,tag?,from?,to?,date?}}` selects current records (ignoring historical selectors); without `select` document rows end with the template mark. |
| `gram_relations` | `{from:{path,entity}, direction?, predicates?, depth?, paths?, limit?, cursor?}`; explicit edges, not relations inferred from prose. |
| `gram_range` | `{path,query?,start?,limit?}`; relevant revisions, or sequential history with `start:0`; pass `more` as the next start. |
| `gram_state` | `{path,selector:{revision}}`, `{path,selector:{recorded_at}}` or `{path,selector:{effective_at}}`; choose one selector. |

Date filters are inclusive; date-only `to` covers the whole day, and `YYYY-MM`/`YYYY` represent a span. Default record date: event `at`, metric `observed`, task `due`, otherwise `at`. `date` chooses another field. `auto` fuses keyword and semantic ranks; `gram_capabilities.semantic` reports whether the model is available and `index` how many documents are indexed. A recall that returns `mode`/`reason` used keyword matching for that call. Follow pagination and report incomplete coverage.

Historical selectors also work on `gram_read`, `gram_get`, `gram_list` without `select`, and in each `gram_context.ids[]` item. Such answers keep the current revision/hash and put the selected history under `at`; do not mistake a past projection for the current state.

`effective_at` selection walks revision order, uses `recorded_at` where effective time is absent, and stops when the next applicable timestamp exceeds the selected time. It is not a general merge of arbitrarily reordered historical facts. Prefer explicit revisions/recording-time queries for audit, and verify any authorized historical-state change at the affected dates.

## Structured writes

`gram_create` requires `{path,title,base_revision:null}` and `content` (text or `{text|rich,records,fields,blocks}`) unless `template` (`schedule@1`, `project@1`, `knowledge@1`) starts the body from its own headings. A template declares the document: Core then checks its records against `gram_profile {topic:"templates"}` and refuses violations with `E_TEMPLATE` and `details.diagnostics`. Give it a `request_id`: resending the identical create replays its receipt (`replayed:true`) instead of failing. Without one, a lost answer means inspecting the destination before retrying; never create a similarly named duplicate. An already existing path is not an overwrite route.

`gram_patch` requires `{path,request_id,operations}`; request ID is 1–128 characters and operations are nonempty. Without `base_revision`/`expected_hash` it writes to the head: each set/unset carries `old`, the value read (string, array in order, or `null`), and Core refuses with `E_PRECONDITION` and `details.conditions` only when such a field changed, an added ID exists with other content or a place target is gone. With a nonnegative `base_revision` and the opaque 16-hex `expected_hash` the whole document must be unchanged; `remove` and whole-body `text`/`drop-text`/`rich` need them. The cloud schema has no `action`/`action_target` (`E_ARGUMENT: Unknown argument action`); a template's required fields and values are still checked on ordinary operations. One successful call is one real revision.

| Operation | Shape |
| --- | --- |
| add | `{op:"add",record:{type,id,fields:{t:["Title"],d:["Outcome."]},links:[["part-of","prj-atlas"]]},place:{section:"Plan"}}` |
| set | `{op:"set",entity:"task-verify",key:"x",value:"completed",old:"active"}`; several values `values:["a","b"]` |
| link / unlink | `{op:"link",entity:"dec-new",predicate:"replaces",target:"dec-old"}` |
| edit-text | `{op:"edit-text",entity:"doc",kind:"rich",old:"exact unique text",new:"replacement"}` |

Add field values are arrays of strings; a set takes `value` (one string) or `values`. `t` is required and single-line. Current types: `project goal requirement assumption decision task blocker risk event artifact evidence metric component system service source history knowledge context person agent run asset`. Known predicates: `part-of implements depends derives related supports contradicts replaces blocks enables`. Unsupported add predicates can be stored without appearing in relation reads; do not use them as graph links. Valid extension fields may be stored with `W_EXTENSION_FIELD`, but prefer profile fields. Unknown record types fail. A template document accepts only its listed `x` values and required fields.

`source` refers to a real `source` record ID, not a URL. Put URLs in `ref`. Preserve sourced owners/deadlines and omit unknown ones. Raw `x` accepts strings; misspellings can appear as open work. Missing `x` can omit a task/risk from the open brief, so compare both brief and selected records.

`place` belongs on an add and supports `"end"`, `{after:"id"}` or `{section:"exact heading or node ID"}`. It requires a rich document body and cannot share a patch with `edit-text`, `rich`, `text` or `drop-text`. A record without placement can exist without being visible in the body. Operations run in order; add a target before linking to it in a patch. In create content, records may link to each other regardless of order; place them with standalone `[[id]]` lines or appropriate collections.

## Recovery and completion

1. Retain the exact patch payload and response. If the response is lost, inspect the document and retry the **identical** request with the same ID. The receipt may report `replayed:true`; there is no public `gram_receipt` tool.
2. `E_PRECONDITION`, `STALE_REVISION`, stale hash or `STORAGE_CONFLICT`: refresh the affected prose/records; preserve concurrent edits, check whether the intent remains needed and rebuild with a new request ID. Do not retry an old write blindly. Fix `E_TEMPLATE` by `details.diagnostics`; `E_CAS_REQUIRED` means the operation needs `base_revision`/`expected_hash`.
3. `E_REQUEST_REUSE` means the same ID was used for a different request. Use a new ID only after reconciling the actual outcome. A rare replay can return `intent_checked:false`; readback is required even when a receipt is successful.
4. Resolve `E_AMBIGUOUS_TEXT` by reading the exact text and selecting a unique span. Resolve missing/duplicate IDs by reusing the existing record or correcting the target, never by repeated imports.
5. Confirm `sync.state = synced`, then read the changed sections, selected fields and relations freshly. Check selected historical states if changed. A replay can report the document's newer current revision; verify the intended fields, not merely a revision number.

`AGENT_SCOPE_DENIED` identifies per-agent access denial and points to https://vault.thegram.one/settings/agents. Stop the operation, report the denial and let the user change access in Settings → Connected agents; do not retry unchanged, change credentials or redirect to another mount. After an approved scope change, rediscover mounts and fetch fresh revision/hash before an authorized retry. None mounts are hidden; read mounts are read-only. `E_FORBIDDEN` identifies other cloud access denials; local integrations may instead expose `E_READ_ONLY`. `E_PATH`, missing targets/sources, bad field types or bad timestamps require correcting the request within its original scope. Provider authentication, consent, quota or uncertain storage outcome remains a blocker; do not bypass it with another destination.

`at` accepts an event's known ISO date/time; task `due` can be date-only. Metric `observed` should retain the source's known precision. A timezone-bearing observation gives a supporting chart an actual time axis. `effective_at`, when deliberately used, requires a full ISO timestamp with a zone. Recording time is supplied by the runtime; never manufacture it.

## Document chat

A Thegram document chat request is a task bound server-side to one Vault document and the requesting account. Every chat tool takes `task_id` and none takes a path.

| Tool or method | Arguments and result |
| --- | --- |
| `events/list` | `chat.task.created`: no subscription arguments, webhook delivery; payload `{task_id, document_title, message, url}`. Only on the `2026-07-28` protocol. |
| `events/subscribe` | `{name:"chat.task.created", arguments:{}, delivery:{mode:"webhook", url, secret:"whsec_…"}}` → `{id, refreshBefore}`; the callback is challenge-verified and must be public HTTPS. The first subscription that accepts a delivery holds the task for its client. |
| `chat_task_list` | `{}` → `tasks` open for this connected agent, oldest first, with `task_id`, `document_title`, `message`, `status`, `deadline`. |
| `chat_task_get` | `{task_id}` claims the task → `task` (`message`, `selected_record?`, `timezone?`, `local_time?`, `deadline`), `conversation` (recent turns) and `document` (a `gram_brief` of the bound document). A finished task returns `task.result`. |
| `chat_doc_read` | `{task_id}` outline, `{task_id, section, cursor?}` one section as `gram_read`, or `{task_id, entities:[ids]}` as `gram_context`. |
| `chat_task_submit` | `{task_id, reply, operations?, base_revision?, expected_hash?, effective_at?}` → `{status:"done", changed, revision?, created}`. Operations are `gram_patch` operations (1–50) on the bound document, applied in one revision with request ID `chat-<task>-<digest>`; an identical resubmission returns `replayed:true`. |

Errors: `E_TASK_NOT_FOUND` (not this account's task), `E_TASK_FORBIDDEN` (another connected agent holds it), `E_TASK_CLOSED` (done, expired after 15 minutes or cancelled), `E_BUSY` (a submission is running). Write errors are those of `gram_patch` and leave the task open until its deadline. The person sees the reply, status and revision in the document chat; changes appear in the document's history under their account with the agent's name.

## Supported representations

Standalone `[[id]]` places a record. `[label](@id)` mentions a record. A field mention can be built with a rich text mark `{type:"mention",ref:"met-availability",field:"value"}` according to `gram_profile {task:"rich"}`; the mark's text should fit the sentence.

Collection examples supported by the current rich profile:

```text
[[*]]{type=risk status=open view=table}
[[*]]{type=task status=active view=list}
```

Only collection `list` and `table` are listed as supported; item `view` is ignored. A collection is a document projection, not a dashboard widget. Each document has one dashboard from its template: declared `project@1` Project Tracker, `schedule@1` Journal and `knowledge@1` Knowledge are editable there; an undeclared document shows its recommended type read-only, and an unknown template has no dashboard. Metrics use one stable entity's numeric `value`, constant `unit` and sourced `observed` history, never revision counts or recording time. Different units do not share comparisons, and a unit with one metric has no comparison bar. Goal progress counts only same-document tasks linked `part-of` the goal; `related` links do not count. A goal with no linked tasks shows its own state and no progress ring. Cancelled/superseded tasks remain in total task counts and are disclosed separately; record actual work rather than adjusting records to improve numbers.

Mermaid `flowchart`/`graph` blocks are supported by the inspected desktop renderer; other diagram kinds remain source. Labeled `-->` edges are supported there, while labeled `==>`/`-.->` can be dropped. Cloud storage accepting a code block does not prove a particular host renders it. Validate the target renderer and retain readable prose when rendering is unavailable.
