import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	callTool,
	errorCode,
	newMemoryState,
	newTurn,
	observeTool,
	orient,
	renderOrientation,
	resolveProject,
	str,
} from "./core.ts";

function isMainSession(ctx: ExtensionContext): boolean {
	const ref = AgentRegistry.global()
		.list()
		.find(entry => entry.session?.sessionManager === ctx.sessionManager);
	return !ref || ref.kind === "main";
}

export default function thegramMemory(pi: ExtensionAPI): void {
	let state = newMemoryState();
	let reminder: string | undefined;

	const reset = (): void => {
		const folder = state.folder;
		state = newMemoryState();
		state.folder = folder;
		reminder = undefined;
	};

	pi.on("session_switch", reset);
	pi.on("session_branch", reset);
	pi.on("session_tree", reset);
	pi.on("session_compact", () => {
		state.needBrief = true;
	});

	pi.on("session.compacting", () => {
		if (!state.folder || !state.exists) return;
		return {
			context: [
				`Thegram memory for this project lives in folder \`${state.folder}\`${state.vault ? ` of the vault \`${state.vault}\`` : ""}. Durable outcomes from the compacted span that were not recorded yet still belong there.`,
			],
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isMainSession(ctx)) return;
		state.turn = newTurn();
		reminder = undefined;
		const orientation = await orient(state, ctx.cwd, event.prompt);
		if (!orientation) return;
		if (ctx.hasUI) ctx.ui.setStatus("thegram", `thegram ${orientation.project}`);
		return {
			message: {
				customType: "thegram-memory",
				content: renderOrientation(orientation),
				display: false,
				attribution: "agent" as const,
			},
		};
	});

	pi.on("tool_result", (event, ctx) => {
		if (!isMainSession(ctx) || state.folder === undefined) return;
		let name = event.toolName;
		if (name === "write") {
			const target = String(event.input.path ?? "");
			if (target.startsWith("xd://")) name = target.slice("xd://".length);
		}
		const nudge = observeTool(state, { name, input: event.input, output: event.content, isError: event.isError });
		if (nudge) reminder = nudge;
		if (state.turn.wrote) reminder = undefined;
	});

	pi.on("context", (event, ctx) => {
		if (!reminder || !isMainSession(ctx)) return;
		const message: AgentMessage = {
			role: "custom",
			customType: "thegram-memory-reminder",
			content: `<system-reminder>\n${reminder}\n</system-reminder>`,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		return { messages: [...event.messages, message] };
	});

	pi.registerCommand("thegram", {
		description: "Show Thegram memory status for this project",
		handler: async (_args, ctx) => {
			const project = await resolveProject(ctx.cwd);
			if (!project) {
				ctx.ui.notify("thegram: no project for this directory (not a git repository and no mapping)", "warning");
				return;
			}
			try {
				const projects = await callTool("gram_projects", {});
				const exists = Array.isArray(projects.projects) && projects.projects.some(row => Array.isArray(row) && row[0] === project);
				if (!exists) {
					ctx.ui.notify(`thegram: folder ${project} does not exist yet in ${str(projects.vault)}`, "info");
					return;
				}
				const brief = await callTool("gram_brief", { folder: project });
				const docs = Array.isArray(brief.docs)
					? brief.docs.map(row => (Array.isArray(row) ? `${row[0]} r${row[2]}` : "")).join(", ")
					: "";
				const open = Array.isArray(brief.open) ? brief.open.length : 0;
				ctx.ui.notify(`thegram: ${project} · ${docs} · open ${open} · next ${str(brief.next)}`, "info");
			} catch (error) {
				ctx.ui.notify(`thegram: unavailable (${errorCode(error)})`, "error");
			}
		},
	});
}
