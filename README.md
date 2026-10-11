# thegram-memory

Gives coding agents a shared project memory in [Thegram](https://thegram.one). Works with Claude Code, Codex, opencode and OMP.

To install, hand this README to your agent:

> Install the thegram-memory plugin by following https://github.com/clab-one/thegram-mcp

## Requirements

- macOS with the Thegram app running and agent access set to **write**
- Node 22 or later on `PATH`

## Install

Claude Code

```sh
claude plugin marketplace add clab-one/thegram-mcp
claude plugin install thegram-memory@thegram-memory
```

Codex (choose "Trust all and continue" for the hooks on the first run)

```sh
codex features enable hooks
codex plugin marketplace add clab-one/thegram-mcp
codex plugin add thegram-memory@thegram-memory
```

OMP

```sh
omp plugin marketplace add clab-one/thegram-mcp
omp plugin install thegram-memory@thegram-memory
```

opencode v2

```sh
opencode plugin add github:clab-one/thegram-mcp
```

opencode v1: add `"github:clab-one/thegram-mcp"` to the `plugin` array in `opencode.json`.

Remove any MCP server you registered by hand under the name `thegram`, then start a new session.

## Check

From the installed plugin directory:

```sh
node dist/thegram-memory.mjs doctor
```

It prints the app connection, the vault, and the project folder for the current directory. Exit code 1 means the app is not reachable.

## How it works

- Each git repository uses the vault folder with the same name. Worktrees share it.
- At session start the agent gets the project brief; later prompts get changes made by others.
- If a turn edits files or commits without writing to Thegram, the agent gets one reminder.
- Google Drive: after you sign in to Google Drive in the Thegram app, agents can read and write it under `@mounts/<id>/…`.

Map a directory to a different folder in `~/.config/thegram-memory/projects.json` (longest prefix wins):

```json
{ "~/.omp": "omp" }
```

Add your own rules for every agent in `~/.config/thegram-memory/policy.md`.

## Development

```sh
bun run bundle
```

Commit `dist/` with the source; installs do not build. For a release, bump `version` in `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.
