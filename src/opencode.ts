import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
	CLI_PATH,
	isJson,
	type MemoryState,
	newMemoryState,
	newTurn,
	observeTool,
	orient,
	renderOrientation,
	SKILLS_DIR,
	str,
} from "./core.ts";

const SERVER = "thegram";
const SKILL = "thegram-memory";
const MCP_COMMAND = ["node", CLI_PATH, "mcp"];

interface Registration {
	dispose(): Promise<void>;
}

interface SystemPart {
	type: "text";
	text: string;
}

interface V2Context {
	location: { directory: string };
	session: {
		get(input: { sessionID: string }): Promise<unknown>;
		hook(name: "prompt", callback: (event: { sessionID: string; prompt: { text?: string } }) => Promise<void>): Promise<Registration>;
		hook(name: "context", callback: (event: { sessionID: string; system: SystemPart[] }) => void): Promise<Registration>;
	};
	tool: {
		hook(
			name: "execute.after",
			callback: (event: {
				tool: string;
				sessionID: string;
				input: unknown;
				status: "completed" | "error";
				result?: unknown;
			}) => void,
		): Promise<Registration>;
	};
	mcp: {
		transform(callback: (editor: { get(name: string): unknown; set(name: string, config: Json): void }) => void): Promise<Registration>;
	};
	skill: {
		transform(callback: (editor: { get(id: string): unknown; add(skill: Json): void }) => void): Promise<Registration>;
	};
}

interface V1Input {
	directory: string;
}

type Json = Record<string, unknown>;

interface Session {
	state: MemoryState;
	memory: string[];
	turn?: string;
	reminder?: string;
}

function createSessions(directory: () => string) {
	const sessions = new Map<string, Session>();
	const get = (id: string): Session => {
		let session = sessions.get(id);
		if (!session) {
			session = { state: newMemoryState(), memory: [] };
			sessions.set(id, session);
		}
		return session;
	};
	return {
		async prompt(id: string, text: string): Promise<void> {
			const session = get(id);
			session.state.turn = newTurn();
			session.turn = undefined;
			session.reminder = undefined;
			const orientation = await orient(session.state, directory(), text);
			if (!orientation) return;
			const rendered = renderOrientation(orientation);
			if (orientation.policy) session.memory = [rendered];
			else session.turn = rendered;
		},
		system(id: string): string[] {
			const session = sessions.get(id);
			if (!session) return [];
			const parts = [...session.memory];
			if (session.turn) parts.push(session.turn);
			if (session.reminder && !session.state.turn.wrote) parts.push(`<thegram-memory-reminder>\n${session.reminder}\n</thegram-memory-reminder>`);
			return parts;
		},
		tool(id: string, name: string, input: unknown, output: unknown, isError: boolean): void {
			const session = sessions.get(id);
			if (!session || session.state.folder === undefined) return;
			const nudge = observeTool(session.state, { name, input, output, isError });
			if (nudge) session.reminder = nudge;
		},
		drop(id: string): void {
			sessions.delete(id);
		},
	};
}

async function readSkill(): Promise<Json> {
	const file = path.join(SKILLS_DIR, SKILL, "SKILL.md");
	const content = await readFile(file, "utf8");
	const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
	return { id: SKILL, name: SKILL, description, path: file, content };
}

async function setup(ctx: V2Context): Promise<void> {
	const sessions = createSessions(() => ctx.location.directory);
	const skill = await readSkill();
	await ctx.mcp.transform(editor => {
		// codemode would hide gram_patch behind a code tool.
		if (!editor.get(SERVER)) editor.set(SERVER, { type: "local", command: MCP_COMMAND, codemode: false });
	});
	await ctx.skill.transform(editor => {
		if (!editor.get(SKILL)) editor.add(skill);
	});
	await ctx.session.hook("prompt", async event => {
		const info = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined);
		if (isJson(info) && str(info.parentID)) return;
		await sessions.prompt(event.sessionID, event.prompt.text ?? "");
	});
	await ctx.session.hook("context", event => {
		for (const text of sessions.system(event.sessionID)) event.system.push({ type: "text", text });
	});
	await ctx.tool.hook("execute.after", event => {
		sessions.tool(event.sessionID, event.tool, event.input, event.result, event.status === "error");
	});
}

async function server(input: V1Input) {
	const sessions = createSessions(() => input.directory);
	const children = new Set<string>();
	return {
		config: async (config: Json): Promise<void> => {
			const mcp = isJson(config.mcp) ? config.mcp : {};
			if (!mcp[SERVER]) config.mcp = { ...mcp, [SERVER]: { type: "local", command: MCP_COMMAND } };
			const skills = isJson(config.skills) ? config.skills : {};
			const paths = Array.isArray(skills.paths) ? skills.paths : [];
			if (!paths.includes(SKILLS_DIR)) config.skills = { ...skills, paths: [...paths, SKILLS_DIR] };
		},
		"chat.message": async (
			hook: { sessionID: string },
			output: { parts: { type?: string; text?: string; synthetic?: boolean }[] },
		): Promise<void> => {
			if (children.has(hook.sessionID)) return;
			if (output.parts.length > 0 && output.parts.every(part => part.synthetic)) return;
			const text = output.parts
				.filter(part => part.type === "text" && !part.synthetic)
				.map(part => part.text ?? "")
				.join("\n");
			await sessions.prompt(hook.sessionID, text);
		},
		"experimental.chat.system.transform": async (
			hook: { sessionID?: string },
			output: { system: string[] },
		): Promise<void> => {
			if (hook.sessionID) output.system.push(...sessions.system(hook.sessionID));
		},
		"tool.execute.after": async (
			hook: { tool: string; sessionID: string; args: unknown },
			output: { output: string },
		): Promise<void> => {
			sessions.tool(hook.sessionID, hook.tool, hook.args, output.output, false);
		},
		event: async ({ event }: { event: { type: string; properties?: Json } }): Promise<void> => {
			const info = event.properties?.info;
			if (!isJson(info) || typeof info.id !== "string") return;
			if ((event.type === "session.created" || event.type === "session.updated") && str(info.parentID)) children.add(info.id);
			if (event.type === "session.deleted") {
				sessions.drop(info.id);
				children.delete(info.id);
			}
		},
	};
}

export default { id: "thegram-memory", setup, server };
