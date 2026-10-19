# Backfilling memory from history

Revisions are append-only and recording time is when the import actually happened. A record added now cannot be made to have existed in an earlier revision. `effective_at` labels an effective time without moving recording time. Import only when the person authorizes the purpose and destination; preserve sourced event dates and the existing file's history. Never delete or rebuild a document to make a chart or history look older or more complete.

## 1. Gather and cover sources

- Confirm the authorized document and existing records, the current profile and fresh revision/hash. Inventory sources with stable IDs/permalinks, dates and inspected scope; account for skipped low-signal material without inventing domain records.
- Read commit bodies/diffs, ADR status headers, issues/checklists, PR merge/review state, release/deployment reports and verification results together. Search later history before describing work as still open or completed. Commit size and subject counts can guide coverage but do not determine meaning or importance.
- Use the actual remote for repository identity and `ref`/`s`, not the local folder name. State branch/ref/hash and coverage gaps. A local checkout is not proof of current remote state; refresh only when network access is authorized.
- Separate documentary claims from inspected implementation and runtime observations. A report that says “deployed” remains a source report unless independently verified; preserve that distinction in `d` and completion reporting.
- When delegation is permitted, helpers may gather candidate facts; only the main agent writes. A source read is not permission to store it.

## 2. Classify atomic facts, then reconcile identity

Apply the decision procedure in SKILL.md section 2 to each fact, regardless of whether its container is a commit, ADR, PR, conversation or report. One commit may support a choice, a component change, a tracked task update and failed-test evidence; it may also warrant no domain record. There is no one-event-per-commit default.

A `task` represents actual tracked work, supported by a request, issue, PR, checklist or plan. Reuse that task across recurring fixes. Do not infer a historical task or a sequence of `open → active → completed` from a commit subject. Imported tracked work can be added at its latest supported state with prior sourced dates explained in provenance; no replay of invented intermediate revisions is needed. Partial implementation and an unmerged PR do not establish completion. An ADR marked proposed remains proposed even when a stage of code has merged.

Prefer a `decision` for a choice, `component`/`service`/`system` for responsibility or dependency, `risk`/`blocker` for uncertainty or impediment, `evidence` for a scoped observation, `knowledge` for reusable explanation, `metric` for a measured quantity, and `artifact` for a deliverable. Use an `event` only for a meaningful sourced occurrence with an actual date. A release artifact, deployment occurrence and deployment verification are distinct facts; include only those supported.

Relations must express the source's meaning: `A depends B` does not license `B supports A`; use `supports`/`contradicts` for claim evidence. Allowed predicates are `related supports contradicts depends implements replaces derives blocks enables part-of`. Partial replacement keeps still-applicable old scope and status, explains the changed scope and uses `related`; full replacement may use `replaces` and old `superseded`. Do not invent relation names or infer decision acceptance from implementation.

Group facts into meaningful eras only where the sources support them. An optional `history` record is a narrative summary using supported ordinary fields, not a special replay schema. It neither stores a lifecycle nor creates past revisions. See [classification cases](references/classification.json) and [examples](references/examples.md).

## 3. Write the import at its real recording time

- Reuse the authorized document. Only if creation is authorized and no established document exists, use one `gram_create` with `base_revision:null`, a stable `request_id`, a body with the purpose's sections and supported records. Place them under readable existing headings. No mandatory first event, era record or first-commit date.
- Use ordinary head patches for coherent batches of facts, with `old` on `set`/`unset`; preserve concurrent edits and stable IDs. Batch by meaningful outcome and API limits, never by each commit to simulate history. Add targets before links and keep `place` separate from body edits. Document chat is restricted to its `chat_*` tools and one successful submit; it cannot run a multi-patch backfill.
- Keep actual source/occurrence/observation times separately from runtime `recorded_at`. Do not invent timestamps or fields. Do not default `effective_at` to commit author dates; use it only for an explicitly authorized historical-state interpretation supported by the current API, with ordered effective boundaries understood and verified. It never backdates recording time.
- Update only sourced states. Set a task's `done` when its finish time is known; omit unknown times. Resolve a risk only with evidence appropriate to its scope, link that evidence `related`, and rewrite the risk's `d` to how it was resolved. Do not auto-close goals, decisions or all related work after a commit.
- Reuse components by responsibility and metrics by comparable quantity/denominator/unit. A source-only image-pin change needs no component revision unless it establishes a meaningful change in responsibility, dependency or state.
- Metrics: retain actual observations and their original precision, never the era end as a substitute. One point is valid. A request to preserve a multi-observation series may require distinct real writes under the current history contract; do that only for sourced observations within the authorized scope, using the same metric ID, and disclose today's recording dates. Never split an import just to populate sparklines.
- Keep source coverage in a compact source record/narrative or existing source references. Repeat runs should reconcile the same facts and sources, not create duplicate entities or revisions. “No qualifying change” is valid.

## 4. Facts, narrative and display

- `d` states the source-supported outcome and scope; mark inference explicitly. No “first”, causal claim or runtime verification without evidence. Unknown owners, priorities and dates stay unknown.
- Use a real `source` ID in `source` and URLs in `ref`. Describe source timestamps at their known precision with no invented clock or custom replay fields. An event's `at` is the occurrence time, not automatically the cited commit author date.
- Keep Overview, Architecture, Decisions, evolution and unresolved work coherent. Summarize important transitions, not every commit. Reconcile prose after placed records in a separate head patch with fresh state.
- Read [widget data contracts](references/widget-data.md) for selector/date/status requirements and saved-layout readiness. Missing data does not authorize fabrication, layout rewriting or publication. Keep public-document privacy boundaries; no raw messages, credentials or personal names without authorization.

## 5. Verify

1. `gram_brief`: counts by type look right, and the open list holds only real open work.
2. Every record reaches the project through links. In OMP, run this in Python eval (raise the eval timeout for large documents); elsewhere, do the same walk over `gram_list` and `gram_context` results. Cross-document targets show up under `dangling`:

   ```python
   import json

   async def gram(name, **args):
       text = (await tool.write({"path": f"xd://mcp__thegram_memory_thegram_gram_{name}", "content": json.dumps(args)}))["text"]
       if text.startswith("Error:"):
           raise RuntimeError(text)
       return json.loads(text)

   async def pages(name, key, **args):
       items, cursor = [], None
       while True:
           page = await gram(name, **args, **({"cursor": cursor} if cursor else {}))
           items += page[key]
           if not (cursor := page.get("more")):
               return items

   async def unreachable(path, root):
       ids = [row[0] for row in await pages("list", "entities", path=path)]
       adj = {i: set() for i in ids}
       for k in range(0, len(ids), 40):
           batch = [{"path": path, "entity": i} for i in ids[k:k + 40]]
           for item in await pages("context", "items", ids=batch, fields=["t"]):
               for _, target in item.get("links", []):
                   adj[item["id"]].add(target)
                   adj.setdefault(target, set()).add(item["id"])
       seen, todo = {root}, [root]
       while todo:
           for nxt in adj[todo.pop()] - seen:
               seen.add(nxt)
               todo.append(nxt)
       return {"unreachable": sorted(set(ids) - seen), "dangling": sorted(set(adj) - set(ids))}

   print(await unreachable("@mounts/<vault-id>/<project>.gram", "prj-<slug>"))
   ```

3. `gram_range {path, start: 0}` (pass `more` back as `start`): recording time is the actual import time, independently of sourced dates. Verify effective-time ordering and selected historical states only when deliberately used. A new record cannot exist in a revision before its real addition.
4. `gram_recall` answers a real question with the right decision and risk.
5. Metrics have only the sourced observations: compare stable ID, definition, unit, `value` and `observed`; inspect real changes/history when multiple observations were authorized. A one-point series is valid and missing history remains disclosed.
6. Check semantic and widget results: sources can yield several types or coverage only; proposed ADRs stay proposed, partial/unmerged work stays incomplete, failures stay failures and links retain direction/scope. Task/goal widgets use actual tracked tasks and `part-of`; dates and metric observations are sourced. Read saved presentation requirements when available and disclose missing fields, runtime capabilities or unverified rendering. Do not change records to improve a number.
