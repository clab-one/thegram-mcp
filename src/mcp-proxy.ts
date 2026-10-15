import { createInterface } from "node:readline";
import { connectionId, errorCode, isJson, type McpResponse, parseMcpMessages, postMcp } from "./core.ts";

const REQUEST_TIMEOUT_MS = 120_000;

export async function runMcpProxy(): Promise<void> {
	let sessionId: string | undefined;
	let protocol: string | undefined;
	let initBody: string | undefined;
	let initEndpoint: string | undefined;
	let lost = false;
	const write = (message: unknown): void => {
		process.stdout.write(`${JSON.stringify(message)}\n`);
	};

	const send = async (body: string): Promise<McpResponse> => {
		const headers: Record<string, string> = {};
		if (protocol) headers["MCP-Protocol-Version"] = protocol;
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		return postMcp(body, headers, REQUEST_TIMEOUT_MS);
	};
	// Reinitialize when the server or credential changes so sessions cannot cross connections.
	const reinitialize = async (body: string): Promise<void> => {
		sessionId = undefined;
		sessionId = (await send(body)).sessionId;
		await send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
		initEndpoint = await connectionId();
		lost = false;
	};

	const forward = async (message: unknown): Promise<void> => {
		const id = isJson(message) && "id" in message ? message.id : undefined;
		const isInitialize = isJson(message) && message.method === "initialize";
		const body = JSON.stringify(message);
		try {
			if (isInitialize) {
				initBody = body;
				sessionId = undefined;
			} else if (initBody && (lost || (await connectionId()) !== initEndpoint)) await reinitialize(initBody);
			const response = await send(body);
			if (response.sessionId) sessionId = response.sessionId;
			if (isInitialize) initEndpoint = await connectionId();
			const replies = parseMcpMessages(response);
			for (const reply of replies) {
				if (isInitialize && isJson(reply) && isJson(reply.result) && typeof reply.result.protocolVersion === "string") {
					protocol = reply.result.protocolVersion;
				}
				write(reply);
			}
			if (replies.length === 0 && response.status >= 400 && id !== undefined) {
				write({ jsonrpc: "2.0", id, error: { code: -32000, message: `Thegram answered HTTP ${response.status}` } });
			}
		} catch (error) {
			if (errorCode(error) === "E_CONNECT") lost = true;
			if (id === undefined) return;
			const text = error instanceof Error ? error.message : String(error);
			write({ jsonrpc: "2.0", id, error: { code: -32000, message: text, data: { code: errorCode(error) } } });
		}
	};

	let chain = Promise.resolve();
	for await (const line of createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
		if (!line.trim()) continue;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			continue;
		}
		chain = chain.then(() => forward(message));
	}
	await chain;
}
