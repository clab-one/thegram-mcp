# Worked project-memory lifecycle

The linked [lifecycle.json](lifecycle.json) is **fictional, synthetic test data**, not facts to persist about a person or a project. `example-vault` and `example.com` are placeholders. Replace the path with the exact authorized mount/document. The fixture explicitly uses `project@1`, a stable create request ID and sourced completion time. The fixture pins `base_revision`/`expected_hash` to exercise whole-document checks; replace `${doc.rev}` and `${doc.hash}` with the fresh brief or preceding write response and never submit the placeholders. Ordinary writes go to the head with `old` instead. The example deliberately omits owners, deadlines and priority because the hypothetical evidence supplies none.

## Retrieve before deciding

For “What did we choose for Atlas rollout, and is it actually shipped?”, discover mounts, brief the existing document, recall rollout decisions, then read their context and implementing events. The fixture's `retrieval` calls demonstrate `gram_projects`, `gram_brief`, `gram_recall`, selective `gram_context`, section reads and relations. The correct answer distinguishes an accepted decision from verified implementation. This request alone causes **no write**.

On a later visit use `gram_changes` with the saved `next`, then fetch the relevant changed records. For “What did we know before rollout?” use `gram_state {selector:{revision:0}}` or a sourced recording-time boundary. Do not derive a past state by deleting current records in a copy.

## Create and evolve within an authorized destination

If asked to establish this synthetic project's memory, `create` sets up a readable Overview, Architecture, Plan, Decisions, Evolution and Log, with project/goal/task/component/decision/metric/source/evidence records. It uses one initial real revision; the older observation time does not backdate the document. The approved gradual-rollout choice and its remaining verification task are described in the narrative, not just as dates and links.

The fixture's `patches` model four separately verified outcomes:

1. **Replace a choice:** preserve the previous decision, set `superseded`, create the accepted replacement with `replaces`, and attach source/evidence explaining why the constrained preview replaces gradual rollout. Adoption is still distinct from execution.
2. **Complete verified work:** only after the fictional check confirms the intended endpoint, set the existing task and goal to `completed`; add an event `implements` the accepted choice, an artifact `derives` that event, and evidence supporting the completed task. Avoid creating a second “completed task” record.
3. **Reconcile narrative:** an exact `edit-text` updates Overview and Evolution after the structured outcome. This is separate from adds with `place`; use the last returned rev/hash. Compare the overview and details before calling the document complete.
4. **Record a new measurement:** update the same `met-availability` numeric value and observation time, keep its definition/unit, add the specific report and supporting evidence, and link the metric to that report. The earlier report remains in the document. Readback requests `value`, `unit`, `observed` and `source` explicitly. Two real observations may yield two chart points on a supporting renderer; the fixture does not fabricate points between them.

Use the current document's exact section heading/node ID. Follow `gram_profile` when preserving/adding rich nodes. `[[*]]{type=task status=active view=list}` and `[[*]]{type=risk status=open view=table}` are useful only when actual matching records exist; an empty collection does not justify inventing a task or risk.

## Uncertain replies and concurrent changes

Suppose the replacement patch succeeds but its reply is lost. Reconcile with a fresh brief/context/read, then resend the identical payload with the same request ID if needed. A replay should not create a second outcome. Read back the old status, new decision, replacement link and body placement before reporting saved.

Suppose another writer adds a release caveat after your brief. Sending your original base must fail stale. Read the new revision and relevant section, preserve the caveat, and re-evaluate whether the replacement remains needed. If it does, rebuild the intended delta using the new rev/hash and a **new** request ID. If the same intended fields now disagree, resolve the evidence/intent conflict rather than overwrite them. `STORAGE_CONFLICT` requires the same reconciliation with the provider's latest state.

Reusing an ID with different operations must fail; do not use replay as a way to change history. A create sent with a `request_id` replays the same way; without one, list/read the destination and compare its content before deciding whether creation is still needed.

## Time and source-grounded metrics

The example describes `met-availability` as the fraction of successful probe requests in each report's defined window. Do not equate it with every user's availability or infer a deployment caused a measurement change. Keep each report and its measurement window as evidence. Update a stable metric only when quantity, denominator and unit remain comparable.

If an actual source gives only `2026-10-10`, retain that date; do not attach the example's synthetic clock time. If only one observation is sourced, record one observation. Historical backfill needs explicit authorization and understood temporal semantics; do not split one current import into artificial historic writes to populate sparklines or a revision slider.

## Verification limits

The repository's packaging tests verify bundled discovery and private metadata preservation. The optional offline cloud gateway checks run these synthetic payloads against the actual server wrapper/native Core in scratch storage, including CAS, replay, history and readback. Neither proves installation in an end-user host, live OAuth/provider behavior, or rendered dashboard/diagram behavior. State each verified layer separately.

## Classify mixed sources before importing

The linked [classification.json](classification.json) contains fictional raw inputs, existing records, candidate operations and explicit expectations. It is an offline authoring oracle, not a runtime inference engine or facts to save. Its cases distinguish:

- A single commit containing an accepted cache choice, component responsibility, reusable constraint and scoped test result: four atomic facts plus provenance, no commit event.
- ADR-0047 still marked proposed while Ethereum stage-1 code is merged: retain documentary `proposed`, update the component and active task description, leave later stages incomplete. Its stated dependency on another ADR stays `depends`, with no inverse evidential `supports`.
- An unmerged PR under review and a failed check: the existing task remains `review`; record failure evidence and a real blocking condition. No completion, deployment or success event.
- Repeated fixes to one tracked problem: reuse the task/component, preserve current incomplete status and attach new scoped evidence. No new task per commit and no fabricated intermediate revisions.
- A real dated deployment report and retained build: event for the actual rollout time, artifact for the build and evidence explicitly attributed to the report; an existing verification task completes only when that report establishes its completion. This fixture does not assert that the importing agent ran a live check.
- Two comparable observations: use the same metric ID, quantity and unit, with actual observation timestamps. Their updates are real writes; an unrelated import need not generate metric history.
- Noisy image pin commits: account for the source range only. No new task, component, event or verification evidence is required.
- A partial decision replacement: keep still-applicable old scope accepted, describe the narrower change with `related`. Reserve whole-record `replaces`/`superseded` for the full replacement shown in the lifecycle fixture.

Sourced dates remain in provenance unless the fact has an actual supported date field. Current imports do not recreate old revision activity. [Widget data contracts](widget-data.md) explains why correct type, status, dates, relationships and real revision history matter for useful display; layout readiness never authorizes fake data.
