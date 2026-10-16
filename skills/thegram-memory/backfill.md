# Backfilling memory from history

Revisions are append-only and recording time is when the import actually happened. A record added now cannot be made to have existed in an earlier revision. `effective_at` labels an effective time without moving recording time. Import only when the person authorizes the purpose and destination; preserve sourced event dates and the existing file's history. Never delete or rebuild a document to make a chart or history look older or more complete.

## 1. Gather facts

- Milestones: `git log --shortstat` per month ranked by size, release tags with dates, the first commit of each package (`git log --diff-filter=A --format='%h %aI' -- '<glob>/Cargo.toml'`), and READMEs and design docs at the first commit and at HEAD.
- Reasons: the body of each decision commit; subjects rarely say why.
- Themes: count words in commit subjects per period; sampling misses streams of small commits.
- Open work: before calling anything open, scaffold or planned, search later history for its follow-ups.
- Totals: era commit counts add up to the total commit count.
- Several repositories in one document: read each one's remote default branch after `git fetch` (local checkouts can be stale), and take the repository name for `ref` and `s` from `git remote get-url origin`, not from the directory name.
- Large histories: when the person permits delegation, a subagent may gather candidate records as JSON; only the main agent writes. An explicit no-delegation instruction forbids this.

## 2. Plan the eras

Group sourced history into meaningful eras without inventing phases, decisions or reasons. For each, identify the goals, requirements, decisions, components, events, risks, tasks and evidence actually supported by its sources. Add later-found facts as present-day corrections with their sourced event dates, not by deleting and replaying earlier history. Use a metric only when its quantity and values can actually be measured for the cited dates.

Commits, merges and releases are `event`s. A `task` is tracked work with its own source: an issue, a PR, a milestone checklist, a TODO or roadmap item. Add it in the era it was planned, `part-of` its goal, and close it in the era it finished (`set x completed`, `set done`). Never turn commit subjects into tasks to fill the progress ring: a history without tracked work shows only its open follow-ups, and that is the truthful picture (see "What the dashboard counts" in SKILL.md).

## 3. Write oldest first

- r0 is one `gram_create` with `template: "project@1"` and `effective_at` set to the latest event it holds (the first commit's author date if it holds none). `content.text` has the five headings with each record placed as `[[id]]` on its own line, the first era's `history` record before its events in Log; `content.records` holds the project, the first day's components, goals, requirements, assumptions and evidence, and the first event.
- Then one `gram_patch` per era or milestone group, with `effective_at` set to the latest event in it. Effective times must rise with every revision. It holds the era's `history` record (opening the era in Log), its decisions, components, events and plan records, `set x` (with `old`) on earlier items it resolves plus `link related` to the resolving event, `set x completed` on goals reached in the era, and any `set d` fixes.
- A decision replaced in a later era: in that era's patch, `set x superseded` on the old one and `link replaces` from the new one.
- Components: one per repository or package, added in the era of its first commit; add `depends` links in the era where both ends exist. In a shared document give every record `s: [<repository>]`.
- Metrics: add each series once, in the era it is first measured. In every later era, `set value` and `set observed` (the era's end) on the same record so the dashboard draws a chart. Never add one metric record per era. `observed` is never in the future: for the current era use the time of the latest counted commit.
- Place records in time order with `place: {"after": "<id>"}`, chained inside the patch, or append them to the section in time order.
- Add an item in the era whose source states it, never earlier. Mark inference with `[INFERENCE]` in `d`. Corrections after the backfill go in a normal head patch without `effective_at`.
- Open items another Thegram document already tracks: copy them as your own `risk`/`task` with that document's URL in `ref`; links across documents stay unresolved.
- 30 to 60 operations per patch works. In OMP you can send them from Python eval with the `gram()` helper in step 5.

## 4. Facts and wording

- `d` says only what the commit, its body or the document says. No superlatives; no "first" or "only" unless checked.
- `at` is the cited commit's author date with its zone (`git log -1 --format=%aI <hash>`). Never invent a time.
- `ref` is one URI: a commit URL with a 10-character hash, a blob URL at a pinned commit, or a release tag URL.
- Evidence `supports` its decision or risk. A metric's scope goes in `d`; keep its numbers out of prose. A release artifact `derives` its event.
- Public documents: no personal names unless asked.
- Last pass, in its own patch (body edits cannot share a patch with `place`): rewrite Overview and Architecture prose in the present tense with `edit-text`, draw the current components as a Mermaid flowchart under Architecture, add an era table that mentions records (`[label](@id)`) instead of copying numbers, `set d` on retired components, and `set doc view dashboard` when the user wants the dashboard first.

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

3. `gram_range {path, start: 0}` (pass `more` back as `start`): effective times rise with revision numbers. `gram_state {path, entity, selector: {revision: N}}` returns an item only from the revision that added it.
4. `gram_recall` answers a real question with the right decision and risk.
5. Every metric has a history: `gram_changes {path, since_revision: 0}` lists each metric id under `set` with `value` or `observed` in later revisions, and `gram_state {path, entity, selector: {revision: N}}` returns each era's value.
6. The dashboard tells the truth: tasks are tracked work (none is a commit subject), each task links `part-of` a goal or the project, each goal's steps link `part-of` it, and resolved risks carry a closing status. Do not change records to improve a number; report a misleading one.
