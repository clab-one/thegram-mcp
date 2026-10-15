# Backfilling memory from history

Revisions are append-only. A record added later never shows up in an older revision, and `effective_at` only labels a revision; it does not move it. Write oldest first, and make each revision hold everything that existed in its period. Rebuilding means deleting the file, so ask the user first.

## 1. Gather facts

- Milestones: `git log --shortstat` per month ranked by size, release tags with dates, the first commit of each package (`git log --diff-filter=A --format='%h %aI' -- '<glob>/Cargo.toml'`), and READMEs and design docs at the first commit and at HEAD.
- Reasons: the body of each decision commit; subjects rarely say why.
- Themes: count words in commit subjects per period; sampling misses streams of small commits.
- Open work: before calling anything open, scaffold or planned, search later history for its follow-ups.
- Totals: era commit counts add up to the total commit count.

## 2. Plan the eras

Pick 4 to 8 eras. For each, list the goals, requirements, assumptions, decisions, components, events, risks, tasks, blockers and evidence that start, close or carry over; adding them after their era is written forces a rebuild. Also pick a few metrics you can measure at every era end, such as total commits, packages or release tags.

## 3. Write oldest first

- r0 is one `gram_create` with `effective_at` set to the first commit's author date. `content.text` has the five headings with each record placed as `[[id]]` on its own line; `content.records` holds the project, the first day's goals, requirements, assumptions and evidence, and the first event.
- Then one `gram_patch` per era or milestone group, with `effective_at` set to the latest event in it. It holds the era's `history` record (opening the era in Log), its decisions, components, events and plan records, `set x` on earlier items it resolves plus `link related` to the resolving event, and any `set d` fixes.
- Metrics: add each series once, in the era it is first measured. In every later era, `set value` and `set observed` (the era's end) on the same record so the dashboard draws a chart. Never add one metric record per era.
- Place records in time order with `place: {"after": "<id>"}`, chained inside the patch.
- Add an item in the era whose source states it, never earlier. Mark inference with `[INFERENCE]` in `d`.
- 30 to 60 operations per patch works. Carry `doc.rev` and `doc.hash` from each answer into the next patch. In OMP you can send them from Python eval with the `gram()` helper in step 5.

## 4. Facts and wording

- `d` says only what the commit, its body or the document says. No superlatives; no "first" or "only" unless checked.
- `at` is the cited commit's author date with its zone (`git log -1 --format=%aI <hash>`). Never invent a time.
- `ref` is one URI: a commit URL with a 10-character hash, a blob URL at a pinned commit, or a release tag URL.
- Evidence `supports` its decision or risk. A metric's scope goes in `d`; keep its numbers out of prose. A release artifact `derives` its event.
- Public documents: no personal names unless asked.
- Last pass: rewrite Overview and Architecture prose in the present tense with `edit-text`, draw the current components as a Mermaid flowchart under Architecture, add an era table that mentions records (`[label](@id)`) instead of copying numbers, and `set d` on retired components.

## 5. Verify

1. `gram_brief`: counts by type look right, and the open list holds only real open work.
2. Every record reaches the project through links. In OMP, run this in Python eval (raise the eval timeout for large documents); elsewhere, do the same walk over `gram_list` and `gram_context` results. Cross-document targets show up under `dangling`:

   ```python
   import json

   async def gram(name, **args):
       text = (await tool.write({"path": f"xd://mcp__thegram_gram_{name}", "content": json.dumps(args)}))["text"]
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
5. Every metric draws a chart: `gram_changes {path, since_revision: 0}` lists each metric id under `set` with `value` or `observed` in later revisions.
