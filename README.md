# thegram-memory

A plugin that makes Thegram the durable project memory and canonical document store for coding agents. One repository supports Claude Code, Codex, opencode v1/v2, and OMP, installing Thegram MCP connectivity, memory/document-policy injection hooks, recording policy, and the `thegram-memory` skill.

## Document rules

- Keep project memory in `memory.gram` in the mapped vault folder, using its existing five sections.
- Write project documents as `.gram` by default. Use `.md` only for README files or explicit user requests. Keep `.gram` canonical without duplicate Markdown originals.
- Choose other document names, folders, and divisions based on the content and existing structure. No fixed profiles or file lists are required. Ordinary document content is not limited by the permanent-fact filter for memory records.
- Existing session-start/compaction policy-injection hooks and post-edit reminders communicate these defaults and user-requested exceptions. They do not block filesystem writes or classify user intent by keywords. Distinguish platform-read plugin inputs such as `policy.md` and `SKILL.md` from ordinary project documents, and preserve each platform tool's required input format.

## Behavior

| Component | Behavior |
|---|---|
| MCP | The `thegram` server. `dist/thegram-memory.mjs mcp` forwards stdio MCP to the Thegram app's Unix socket (`socket` in `~/Library/Application Support/Thegram/mcp.json`). |
| Read injection | Injects recording policy and the project brief at session start and after compaction. Adds `gram_recall` results to the first substantive prompt; later prompts receive only changes by other authors. |
| Write reminder | Reminds once if a turn has at least 3 file edits or a git commit and no Thegram write. The main agent writes with `gram_patch`; subagents do not receive the reminder. |
| Policy | `policy.md`. Put user-specific rules in `~/.config/thegram-memory/policy.md` to append them after the policy for all agents. |
| Skill | `skills/thegram-memory` documents tool-call formats, recording vocabulary, error codes, app-rendered dashboard and Mermaid rules, and history backfill (`backfill.md`). |
| App unavailable | Adds one informational line and continues the session. MCP calls return a JSON-RPC error. |

| Agent | Loads |
|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `skills/` |
| Codex | `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json` (Codex does not expand `${CLAUDE_PLUGIN_ROOT}` in MCP arguments), `hooks/hooks.json`, `skills/`. Hooks require the `hooks` feature and user trust. |
| OMP | Marketplace installation loads `package.json#omp.extensions` (`src/omp.ts`). With `claude-plugins` disabled, configure MCP and skills directly as below to enable injection, reading, and writing. With `skillful: false`, the skill is read from `skill://thegram-memory`. |
| opencode | `package.json#exports` (`src/opencode.ts`). One default export supports v2 `setup()` and v1 `server()` and registers MCP and skills itself. |

## Requirements

- The Thegram app on macOS, with agent access set to write.
- Node 22 or later, with `node` on `PATH`. Hooks and the MCP server run `dist/thegram-memory.mjs` with Node.
- This repository is private; installation requires Git credentials that can read `clab-one` repositories.

## Installation

```sh
# Claude Code
claude plugin marketplace add clab-one/thegram-mcp
claude plugin install thegram-memory@thegram-memory

# Codex: approve hooks with "Trust all and continue" on the first run after installation.
codex features enable hooks
codex plugin marketplace add clab-one/thegram-mcp
codex plugin add thegram-memory@thegram-memory

# OMP
omp plugin marketplace add clab-one/thegram-mcp
omp plugin install thegram-memory@thegram-memory

# opencode v2
opencode plugin add github:clab-one/thegram-mcp
```

For opencode v1, add `github:clab-one/thegram-mcp` to the `plugin` array in `opencode.json`. Remove any manually registered MCP server with the same name. Start a new session after installation.

To use OMP with `claude-plugins` disabled, register the server in `~/.omp/agent/mcp.json`:

```json
{"mcpServers":{"thegram":{"type":"stdio","command":"/Applications/Thegram.app/Contents/MacOS/thegram-mcp","timeout":120000}}}
```

Add `"skills": {"customDirectories": ["~/.omp/plugins/node_modules/thegram-memory/skills"]}` to OMP settings. With `skillful: false`, read the skill from `skill://thegram-memory`.

## Project mapping

A Git repository maps to a vault folder named after the repository, based on its common dir. Worktrees share the original repository's folder. The app hides dot-prefixed folders from the project list, so a repository such as `.dotfiles` maps to `dotfiles` (without the leading dot). Add exceptions as directory prefixes in `~/.config/thegram-memory/projects.json`; the longest matching prefix wins.

```json
{
	"~/.omp": "omp"
}
```

A directory that is neither a Git repository nor explicitly mapped receives no injection.

## Diagnostics and development

```sh
node dist/thegram-memory.mjs doctor [dir]
```

Shows app connectivity, the vault, the directory's project folder, local settings, and the hook-state path. Exits with code 1 if the app is unreachable.

```sh
bun run bundle  # src → dist/thegram-memory.mjs. Commit dist. Installation does not build; adding scripts such as `build` or `prepare` makes npm's Git installation run npm install in the repository and fail in opencode.
bun run check   # Type-check using types from the local oh-my-pi checkout.
bun run e2e [claude codex opencode opencode1 omp] [--installed] [--keep]
```

E2E creates a temporary Git repository and same-named vault folder for each agent. It seeds one decision and checks that (1) the agent answers its decision ID using only injected memory, without tools, and (2) after a coding task that does not mention Thegram, the agent records to Thegram on its own. Results are saved in `e2e/artifacts/*.json`; temporary directories are removed even on failure. `--installed` runs the installed plugin without `--plugin-dir` or a local path. Codex always runs a copy from the plugin cache, so dev runs stop if runtime-file hashes differ from the working tree. Claude dev runs stop if a marketplace installation exists. OMP dev runs load only `src/omp.ts` directly and obtain the MCP server from user settings. The harness stops immediately if the agent changes this repository's HEAD or files. Codex runs use `--dangerously-bypass-hook-trust` because the harness cannot answer the hook-trust prompt.

For a release, bump `version` in `package.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` together. Claude Code does not install a new commit if the version is unchanged. Codex and OMP also use the version in their installation-cache paths.

## Limitations

- The official Thegram app release is still blocked (see the `thegram-desktop` README). Without the app, this plugin only displays an informational message.
- `gram_profile {task: "memory"}` does not define the format for an add operation, so the policy and reminder document the verified format.
- Thegram rejects unknown field keys with `E_FIELD`.
- Semantic recall has no relevance floor: a relevant answer scored as low as 0.671 and an unrelated answer as high as 0.721 in codex memory. A single cutoff cannot separate them, so recall runs only for the first substantive prompt after the brief.
- Repositories with the same name (`~/a/api`, `~/b/api`) share a vault folder. Separate them with `projects.json` when their memories must not mix.
- The MCP proxy supports only session-based (legacy) Streamable HTTP. Clients using the 2026-07-28 stateless mode may be rejected by the app.
