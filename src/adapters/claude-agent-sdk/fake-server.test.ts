import { expect, it } from "vitest";
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
