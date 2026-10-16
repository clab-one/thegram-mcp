# thegram-memory

Gives Claude Code, Codex, OpenCode and OMP shared project memory through [Thegram](https://thegram.one). Connect directly to the same Cloud MCP used by the ChatGPT and Claude OAuth integrations. No desktop app or DMG is required.

## Requirements

- Node.js 22 or later
- A Thegram account and an API key issued in **Settings → Agents** with access to the intended Cloud vault

## Install

Claude Code:

```sh
claude plugin marketplace add clab-one/thegram-mcp
claude plugin install thegram-memory@thegram-memory
```

Codex:

```sh
codex features enable hooks
codex plugin marketplace add clab-one/thegram-mcp
codex plugin add thegram-memory@thegram-memory
```

OMP:

```sh
omp plugin marketplace add clab-one/thegram-mcp
omp plugin install thegram-memory@thegram-memory
```

OpenCode v2:

```sh
opencode plugin add github:clab-one/thegram-mcp
```

For OpenCode v1, add `github:clab-one/thegram-mcp` to the `plugin` array in `opencode.json`.

## Connect

Open [Thegram](https://vault.thegram.one/), issue a key in **Settings → Agents**, and select only the vaults and permissions the coding agent needs. The secret is shown once. Do not paste it into chat, a repository, a shell command argument or an agent instruction file.

From the installed plugin directory:

```sh
node dist/thegram-memory.mjs connect
node dist/thegram-memory.mjs doctor
```

`connect` hides terminal input, verifies the key and asks you to choose a Cloud vault when more than one is accessible. For noninteractive input, pass the key on stdin and select the exact mount with `--mount @mounts/<vault-id>`. It is saved in `~/.config/thegram-memory/connection.json` with directory mode `0700` and file mode `0600` on POSIX. `XDG_CONFIG_HOME` changes the configuration root. Keep that file private.

For a managed secret store, supply `THEGRAM_API_KEY` and `THEGRAM_MCP_MOUNT` through the host's environment instead of saving the key. The MCP endpoint is `https://vault.thegram.one/mcp`. `THEGRAM_MCP_URL` selects an explicitly configured HTTPS endpoint; HTTP is accepted only on a loopback IP for local E2E. A saved key cannot be redirected to another endpoint by changing the URL alone.

Restart the agent session after installation. Remove any old manually registered `thegram` MCP server so only this plugin supplies that binding. All supported coding hosts use the same API-key connection; ChatGPT's published plugin and Claude's OAuth connector keep OAuth.

`disconnect` removes this machine's saved credential. To disable a key everywhere, revoke it in Thegram Settings → Agents. The server refuses expired or revoked keys; the plugin never falls back to the desktop app or another storage destination.

## Project memory

Each Git repository binds to one document: the document whose root project record carries the tag `repo:<host/owner/name>` of its `origin` remote, in any folder of any vault the key can read (the selected vault first), else `@mounts/<selected-vault-id>/<repository>.gram`; worktrees share the same document. Documents created by the plugin carry the tag. For an older document, run `node dist/thegram-memory.mjs bind` in the repository once (`--project <id>` when it has several project records); after that it can be moved into a folder without the plugin creating a duplicate at the root. `doctor` shows how the repository is bound. Names that cannot be Cloud filenames receive a deterministic hash suffix. Existing local-only memory is not uploaded or silently migrated.

At session start the plugin injects the exact document's brief, recalls only within that document and then reads incremental changes. After source changes, a commit, or a push, release or deploy command it reminds the agent to record durable outcomes; if the agent is about to finish without writing, the Stop hook (Claude Code, Codex) or `session_stop` (OMP) asks for one continuation, and the agent either records or states why nothing qualified. A read-only key never authorizes a write reminder.

Map a directory to a different Cloud document, folders allowed, in `~/.config/thegram-memory/projects.json` (longest prefix wins; a mapping wins over the tag):

```json
{ "~/work/my-project": "@mounts/<vault-id>/shared-project.gram" }
```

Old desktop-folder mappings must be replaced with explicit Cloud document paths. Add personal instructions in `~/.config/thegram-memory/policy.md`. Google Drive access is granted separately in Thegram; these automatic repository bindings select Cloud vault documents, while the MCP tools can access other mounts permitted by the key.

## Development

```sh
bun run bundle
THEGRAM_E2E_STATE=/path/to/local-fixture-state.json THEGRAM_E2E_REPORT=/path/to/report.json node --experimental-strip-types e2e/cloud.mjs
python3 e2e/hidden_tty.py --state /path/to/local-fixture-state.json --evidence /path/to/tty-report.json
```

The E2Es use the real loopback Vault/key-authority fixture, issue and revoke scratch keys, exercise the packaged CLI, stdio MCP and project hooks, and retain redacted JSON reports. The terminal regression types immediately when the prompt appears and verifies that the key is never echoed. Private temporary configurations are removed; fixtures and writable vaults must be disposable.

Commit `dist/` with the source; installation does not build. Keep `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` versions aligned. Version 3 switches from desktop sockets to scoped Cloud API keys; it has no local-app fallback. It preserves template-aware creation and head-mode field preconditions; native-only `action`/`action_target` metadata is replaced by explicit Cloud operations.
