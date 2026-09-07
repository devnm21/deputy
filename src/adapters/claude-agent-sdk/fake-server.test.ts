import { expect, it } from "vitest";
import type { ScriptTurn } from "./fake-server.js";
import { startFakeAnthropic } from "./fake-server.js";

it("answers the warm-up probe", async () => {
	const server = await startFakeAnthropic([{ type: "text", text: "hi" }]);
	try {
		const response = await fetch(`${server.baseUrl}/api/hello`, { method: "HEAD" });
		expect(response.status).toBe(200);
	} finally {
		await server.close();
	}
});

it("streams a scripted tool_use block as SSE", async () => {
	const server = await startFakeAnthropic([
		{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/tmp/x" } },
	]);
	try {
		const response = await fetch(`${server.baseUrl}/v1/messages?beta=true`, {
			method: "POST",
			body: JSON.stringify({ messages: [] }),
		});
		const body = await response.text();
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(body).toContain("content_block_start");
		expect(body).toContain("toolu_1");
		expect(body).toContain('"stop_reason":"tool_use"');
	} finally {
		await server.close();
	}
});

it("advances through the script across turns and ends the turn after it", async () => {
	const server = await startFakeAnthropic([
		{ type: "tool_use", id: "toolu_1", name: "Write", input: {} },
	]);
	try {
		const post = () =>
			fetch(`${server.baseUrl}/v1/messages?beta=true`, { method: "POST", body: "{}" }).then((r) =>
				r.text(),
			);

		expect(await post()).toContain("tool_use");
		expect(await post()).toContain("end_turn");
		expect(server.requests()).toBe(2);
	} finally {
		await server.close();
	}
});

it("emits two tool_use blocks in one message with indices 0 and 1", async () => {
	const turn: ScriptTurn = {
		type: "tool_use",
		blocks: [
			{ id: "toolu_0", name: "Write", input: { file_path: "/a" } },
			{ id: "toolu_1", name: "Bash", input: { command: "echo hi" } },
		],
	};
	const server = await startFakeAnthropic([turn]);
	try {
		const response = await fetch(`${server.baseUrl}/v1/messages?beta=true`, {
			method: "POST",
			body: "{}",
		});
		const body = await response.text();

		// Both block ids appear
		expect(body).toContain("toolu_0");
		expect(body).toContain("toolu_1");

		// Indices 0 and 1 in content_block_start events
		const starts = [...body.matchAll(/"content_block_start".*?"index":(\d+)/g)];
		expect(starts.map((m) => m[1])).toEqual(["0", "1"]);

		// Single stop_reason: "tool_use" (not two messages)
		const stops = [...body.matchAll(/"stop_reason":"tool_use"/g)];
		expect(stops).toHaveLength(1);

		// Only one message_start / message_stop pair
		const msgStarts = [...body.matchAll(/"message_start"/g)];
		const msgStops = [...body.matchAll(/"message_stop"/g)];
		expect(msgStarts).toHaveLength(1);
		expect(msgStops).toHaveLength(1);
	} finally {
		await server.close();
	}
});
