import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
	callTool,
	configDir,
	endpointFile,
	errorCode,
	loadProjectMap,
	PACKAGE_ROOT,
	resolveProject,
	socketPath,
	stateDir,
	str,
} from "./core.ts";
import { runHook } from "./hook.ts";
import { runMcpProxy } from "./mcp-proxy.ts";

const USAGE = `thegram-memory <command>

  mcp              stdio MCP server that forwards to the Thegram app
  hook             Claude Code / Codex command hook (event JSON on stdin)
  doctor [dir]     check the app connection and the project for a directory
  version          print the package version`;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function packageVersion(): Promise<string> {
	const pkg: unknown = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
	return typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "unknown";
}

async function doctor(dir: string): Promise<number> {
	const lines = [`thegram-memory ${await packageVersion()} · node ${process.version}`, `endpoint: ${endpointFile()}`];
	let failed = false;
	try {
		lines.push(`socket: ${await socketPath()}`);
		const projects = await callTool("gram_projects", {});
		const folders = Array.isArray(projects.projects) ? projects.projects.length : 0;
		lines.push(`vault: ${str(projects.vault)} · access ${str(projects.access)} · ${folders} project folders`);
		const project = await resolveProject(dir);
		if (!project) lines.push(`project: none for ${dir} (not a git repository and no mapping)`);
		else {
			const exists =
				Array.isArray(projects.projects) &&
				projects.projects.some(row => Array.isArray(row) && row[0] === project);
			lines.push(`project: ${project} for ${dir} · ${exists ? "folder exists" : "folder not created yet"}`);
		}
	} catch (error) {
		failed = true;
		lines.push(`app: unavailable (${errorCode(error)}: ${error instanceof Error ? error.message : String(error)})`);
	}
	const mapped = Object.keys(await loadProjectMap()).length;
	const localPolicy = await readFile(path.join(configDir(), "policy.md"), "utf8").then(
		() => "present",
		() => "absent",
	);
	lines.push(`config: ${configDir()} · ${mapped} mapped directories · local policy ${localPolicy}`);
	lines.push(`hook state: ${stateDir()}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	return failed ? 1 : 0;
}

async function main(): Promise<number> {
	const [command, ...args] = process.argv.slice(2);
	switch (command) {
		case "mcp":
			await runMcpProxy();
			return 0;
		case "hook":
			try {
				process.stdout.write(await runHook(await readStdin()));
			} catch (error) {
				process.stderr.write(`thegram-memory hook: ${error instanceof Error ? error.message : String(error)}\n`);
			}
			return 0;
		case "doctor":
			return doctor(path.resolve(args[0] ?? process.cwd()));
		case "version":
			process.stdout.write(`${await packageVersion()}\n`);
			return 0;
		default:
			process.stdout.write(`${USAGE}\n`);
			return command ? 1 : 0;
	}
}

process.exitCode = await main();
