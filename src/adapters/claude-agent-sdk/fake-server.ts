import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type ScriptTurn =
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "text"; text: string };

export type FakeServer = {
	baseUrl: string;
	requests(): number;
	close(): Promise<void>;
};

const frame = (event: string, data: unknown): string =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function framesFor(turn: ScriptTurn): string {
	const start = frame("message_start", {
		type: "message_start",
		message: {
			id: "msg_fake",
			type: "message",
			role: "assistant",
			model: "claude-fake",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 1 },
		},
	});

	const body =
		turn.type === "tool_use"
			? frame("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: turn.id, name: turn.name, input: {} },
				}) +
				frame("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.input) },
				}) +
				frame("content_block_stop", { type: "content_block_stop", index: 0 })
			: frame("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}) +
				frame("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: turn.text },
				}) +
				frame("content_block_stop", { type: "content_block_stop", index: 0 });

	const stop = turn.type === "tool_use" ? "tool_use" : "end_turn";

	return (
		start +
		body +
		frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stop, stop_sequence: null },
			usage: { output_tokens: 1 },
		}) +
		frame("message_stop", { type: "message_stop" })
	);
}

/**
 * A local Anthropic Messages endpoint that returns a fixed script.
 *
 * The Claude Agent SDK exposes no pluggable model, but it spawns a Claude Code
 * subprocess, so pointing that subprocess here with ANTHROPIC_BASE_URL gives
 * deterministic tool calls with no egress. Responses must be streamed: a
 * gateway that buffers complete responses stalls the client.
 */
export async function startFakeAnthropic(script: ScriptTurn[]): Promise<FakeServer> {
	let count = 0;

	const server: Server = createServer((req, res) => {
		const url = req.url ?? "";

		if (req.method === "HEAD" && url.startsWith("/api/hello")) {
			res.writeHead(200).end();
			return;
		}

		// Match on path, not full URL: the SDK appends ?beta=true.
		if (req.method === "POST" && url.split("?")[0] === "/v1/messages") {
			const turn = script[count] ?? { type: "text" as const, text: "DONE" };
			count += 1;
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(framesFor(turn));
			res.end();
			return;
		}

		res.writeHead(404).end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests: () => count,
		close: () =>
			new Promise<void>((resolve, reject) => {
				// closeAllConnections, or a keep-alive socket the SDK subprocess
				// left open holds the server (and the port) past close().
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
