# thegram-memory

Gives Claude Code, Codex, OpenCode and OMP shared project memory through [Thegram](https://thegram.one). Connect directly to the same Cloud MCP used by the ChatGPT and Claude OAuth integrations. No desktop app or DMG is required.

The canonical skill and references live at `skills/thegram-memory/` in this repository. ChatGPT and Claude OAuth ZIPs in
[`thegram-one/thegram-plugin`](https://github.com/thegram-one/thegram-plugin) import this committed directory and pin each file's hash.
Their existing cloud skill name stays `thegram-cloud`; only that frontmatter name differs. The body, reference files, classification
rules, authorization, status semantics, field preconditions, conflict handling and synchronized readback are otherwise identical.
Cloud packages use OAuth; local coding agents use an API key against the same Cloud MCP. Host context injection and reminders
are adapters, not an independent memory policy.

Change workflow rules here, commit them, then run `python3 scripts/sync_skill.py --source /path/to/thegram-mcp` in the cloud
plugin checkout before building its host ZIPs. Cloud builds reject workflow/reference drift from `skill-source.lock.json`.
Version 3.1 includes the shared references and reduces the local adapter policy to connection, binding and skill-loading guidance.

## Semantic records and widget data (3.2.1)

Classify atomic facts by meaning before writing: commits and PRs are provenance, not automatic events. Reuse existing tasks/components/metrics, keep proposed ADRs and incomplete work at their supported states, and retain scoped evidence separately from runtime verification. A meaningful dated deployment can be an event; routine image pins may need source coverage only. Never replay invented task lifecycles or historical revisions.

The shared references map data to the 60-kind widget catalog, including task/goal relationships, status-class progress, actual occurrence/observation dates, stable metric history and runtime capability limits. Saved-layout readiness is separate from useful rendering. Local OMP installs the same skill with its API-key adapter; source/install checks do not establish live widget rendering.

Scheduled automations (3.3.0): a document a scheduled run writes records one `run` event per run (`failed:<source>` tags for unread sources), keeps each found item under one stable ID with `ref`, `at` and `source:`/`topic:` tags linked `derives` only to the run that first found it, and tags watched things `target`. The 리서치, 감시·알림 and 수집 일지 dashboards in thegram-ui 3.31.0 read exactly this shape.

Document chat read mode (3.5.0): `chat_task_get` returns whether a request was sent in read or edit mode. In read mode answer with the reply alone and never submit operations; if an edit is refused with `E_READ_ONLY`, resubmit the reply without operations.

Agent work (3.4.0): an agent records each piece of work as one `task` (`owner` its agent name, `s` the repository, `start`, `done`), moves `x` as the work moves (`review` for the person's review, `waiting` with the question, `blocked` with what stops it, `completed` with the outcome), and records each PR, merge, release, deployment or verification as one step `event` linked `part-of` that task, never one per commit or test run. The AI 작업 보드 dashboard in thegram-ui 3.32.0 reads exactly this shape.

## Search-first project memory (3.5.1)

Version 3.5.1 removes local document-path bindings and selected-vault fallback. Existing credentials still work, but `projects.json`, saved mount choices and `THEGRAM_MCP_MOUNT` no longer choose a destination; `connect --mount` is removed. The adapter searches currently authorized Vault documents by the repository tag and requires exactly one matching project record. It does not create a replacement when a document is missing.

Update the plugin and restart the host session. If an existing project record lacks a repository tag, associate that record once with `node dist/thegram-memory.mjs bind --document @mounts/<vault-id>/<document>.gram [--project <id>]` from its repository. No credential replacement or permission expansion is needed. Non-Git directories have no inferred repository identity.

Rollback installs the previous plugin release without changing Cloud documents or credentials; it also restores that release's local-path behavior.


Release verification uses the complete local E2E in Development after all builds; the CI workflow builds the distributable and host adapters without running separate unit or slice tests.

## Requirements

- Node.js 22 or later
- A Thegram account and an API key issued in **Settings → Agents** with access to the intended Cloud vault

## Install

Claude Code:

```sh
claude plugin marketplace add thegram-one/thegram-mcp
claude plugin install thegram-memory@thegram-memory
```

Codex:

```sh
codex features enable hooks
codex plugin marketplace add thegram-one/thegram-mcp
codex plugin add thegram-memory@thegram-memory
```

OMP:

```sh
omp plugin marketplace add thegram-one/thegram-mcp
omp plugin install thegram-memory@thegram-memory
# Existing installation:
omp plugin marketplace update thegram-memory
omp plugin upgrade thegram-memory@thegram-memory --scope user
```

OpenCode v2:

```sh
opencode plugin add github:thegram-one/thegram-mcp
```

For OpenCode v1, add `github:thegram-one/thegram-mcp` to the `plugin` array in `opencode.json`.

## Connect

Open [Thegram](https://vault.thegram.one/), issue a key in **Settings → Agents**, and select only the vaults and permissions the coding agent needs. The secret is shown once. Do not paste it into chat, a repository, a shell command argument or an agent instruction file.

From the installed plugin directory:

```sh
node dist/thegram-memory.mjs connect
node dist/thegram-memory.mjs doctor
```

`connect` hides terminal input and verifies the key by discovering the mounts available to that credential. Noninteractive input passes the key on stdin; no vault is selected or persisted locally. The credential is saved in `~/.config/thegram-memory/connection.json` with directory mode `0700` and file mode `0600` on POSIX. `XDG_CONFIG_HOME` changes the configuration root. Keep that file private.

For a managed secret store, supply `THEGRAM_API_KEY` through the host's environment instead of saving the key. The MCP endpoint is `https://vault.thegram.one/mcp`. `THEGRAM_MCP_URL` selects an explicitly configured HTTPS endpoint; HTTP is accepted only on a loopback IP for local E2E. A saved key cannot be redirected to another endpoint by changing the URL alone.

Restart the agent session after installation. Remove any old manually registered `thegram` MCP server so only this plugin supplies that binding. All coding hosts use the same API-key connection. ChatGPT and Claude cloud users install their respective OAuth ZIP from `thegram-one/thegram-plugin`; updating those ZIPs keeps their stable plugin/server identity rather than replacing OAuth with an API key.

`disconnect` removes this machine's saved credential. To disable a key everywhere, revoke it in Thegram Settings → Agents. The server refuses expired or revoked keys; the plugin never falls back to the desktop app or another storage destination.

## Project memory

Each Git repository is resolved afresh from the exact `repo:<host>/<repository-path>` tag on an existing project record, searching currently authorized Vault documents and following every result page. Exactly one project record must match, including within a shared document; missing and duplicate associations stop memory use without guessing a path, creating a document or issuing a write reminder. Git worktrees share the origin identity. For an existing document, run `node dist/thegram-memory.mjs bind --document @mounts/<vault-id>/<document>.gram` in the repository (add `--project <id>` if it contains multiple project records); the command only adds the server-side repository tag and refuses an association already claimed elsewhere. A known remote identity may be supplied explicitly with `--repository <host>/<repository-path>`, including nested groups, but is never cached as a local destination. A non-Git directory has no automatic project binding; choose its existing document explicitly for any intended work. `projects.json` and old saved mount selections are ignored and never used as destinations.

At session start the adapter injects the exact document's brief, recalls only within that document and then reads incremental changes. Source edits, commits, pushes, releases and deploys can trigger a reminder; a Stop hook (Claude Code, Codex) or `session_stop` (OMP) can ask once for a continuation. The adapter does not authorize storage: the shared skill requires the person's established purpose/destination authorization, and a read-only key never authorizes a write reminder. The agent records only a qualifying authorized outcome or explains why nothing was saved.

Add personal instructions in `~/.config/thegram-memory/policy.md`. Google Drive access is granted separately in Thegram; automatic repository discovery selects only Vault documents visible to the current key.

## Development

```sh
bun run bundle
python3 e2e/cloud-local.py --vaultd /path/to/vaultd --accessd /path/to/accessd --core /path/to/gram --work /path/to/disposable-work --evidence /path/to/evidence
```

Build all binaries and host adapters first, then run the complete local E2E once. It starts real loopback Vault, Access and Core with isolated synthetic accounts, covers discovery pagination, stale settings, moves, ambiguity, account changes, live grant changes, CLI/stdio and real terminal secret input, and retains redacted `report.json`, `tty.json`, `runner.json` and server logs. Fixture processes stop before their private data is removed. It never accesses production or existing credentials.

```sh
node e2e/authoring/run.mjs --skill skills/thegram-memory --variant <name> --doc-root '@mounts/<vault>/<folder>' --out /path/to/evidence --ui /path/to/thegram-ui
```

The authoring E2E has a real agent (Codex CLI, the skill as `AGENTS.md`, only this Cloud MCP auto-approved, shell read-only) record each scenario in `e2e/authoring/scenarios.json` into Cloud documents (two scheduled runs, or three work sessions by different agents for `agent-work`), then reads them back and scores the contract: run records and failed sources, one record per item with `ref`, `at`, source tag and `derives` only to its first run, shared topics, targets and their detections, `at`→`end` windows, tasks with due dates (never already overdue), risks and placement; for agent work, one task per piece of work with its agent, repository, start, final status and done time, what a waiting task asks, and one step per PR, merge, release or deployment. With `--ui` it also reports what the automation or agent work widgets would show. Point `--skill` at another skill checkout to compare versions on fresh documents (one per variant).

Commit `dist/` with the source; installation does not build. Keep `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` versions aligned. Version 3 switches from desktop sockets to scoped Cloud API keys; it has no local-app fallback. It preserves template-aware creation and head-mode field preconditions; native-only `action`/`action_target` metadata is replaced by explicit Cloud operations.
