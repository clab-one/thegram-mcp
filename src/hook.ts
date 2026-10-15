import {
	clipBlock,
	dropSessionState,
	isJson,
	newTurn,
	observeTool,
	orient,
	pruneSessionStates,
	renderOrientation,
	resetMemoryState,
	str,
	withSessionState,
} from "./core.ts";

const MAX_CONTEXT_CHARS = 9_500;

// Codex rejects any hook output field other than hookSpecificOutput.additionalContext.
export async function runHook(raw: string): Promise<string> {
	const input: unknown = JSON.parse(raw);
	if (!isJson(input)) return "";
	const event = str(input.hook_event_name);
	const sessionId = str(input.session_id);
	const cwd = str(input.cwd) ?? process.cwd();
	if (!event || !sessionId) return "";
	if (event === "SessionEnd") {
		await dropSessionState(sessionId);
		return "";
	}
	const context = await withSessionState(sessionId, async state => {
		if (event === "SessionStart") {
			if (str(input.source) === "compact") state.needBrief = true;
			else {
				resetMemoryState(state);
				await pruneSessionStates();
			}
			const orientation = await orient(state, cwd);
			return orientation && renderOrientation(orientation, MAX_CONTEXT_CHARS);
		}
		if (event === "UserPromptSubmit") {
			state.turn = newTurn();
			const orientation = await orient(state, cwd, str(input.prompt));
			return orientation && renderOrientation(orientation, MAX_CONTEXT_CHARS);
		}
		if (event === "PostToolUse") {
			if (input.agent_id || state.documentPath === undefined) return;
			return observeTool(state, {
				name: str(input.tool_name) ?? "",
				input: input.tool_input,
				output: input.tool_response,
			});
		}
	});
	if (!context) return "";
	return JSON.stringify({
		hookSpecificOutput: { hookEventName: event, additionalContext: clipBlock(context, MAX_CONTEXT_CHARS) },
	});
}
