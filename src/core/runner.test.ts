import { expect, it, vi } from "vitest";
import { runSuite } from "./runner.js";
import type { Adapter, Observation, Scenario } from "./types.js";

const scenario: Scenario = {
	id: "s",
	class: "basics",
	description: "d",
	tools: [{ id: "t", description: "t", fields: [] }],
	policy: [{ kind: "deny-tool", toolId: "t" }],
	attempts: [{ toolId: "t", args: {}, expect: "denied" }],
};

const observation: Observation = {
	scenarioId: "s",
	class: "basics",
	adapter: "fake",
	attemptIndex: 0,
	toolId: "t",
	expected: "denied",
	observed: "denied",
	inexpressible: false,
};

const fakeAdapter = (over: Partial<Adapter> = {}): Adapter => ({
	name: "fake",
	frameworkVersion: "0.0.0",
	capabilities: {
		argumentPredicates: true,
		actorConstraints: true,
		structuredEscalationPayload: true,
	},
	run: vi.fn(async () => [observation]),
	...over,
});

it("collects observations from every adapter", async () => {
	const result = await runSuite([fakeAdapter(), fakeAdapter({ name: "other" })], [scenario]);
	expect(result.observations).toHaveLength(2);
	expect(result.failures).toEqual([]);
});

it("records an adapter throw as a failure without aborting the suite", async () => {
	const broken = fakeAdapter({
		name: "broken",
		run: vi.fn(async () => {
			throw new Error("adapter exploded");
		}),
	});
	const result = await runSuite([broken, fakeAdapter()], [scenario]);
	expect(result.failures).toHaveLength(1);
	expect(result.failures[0]).toMatchObject({
		adapter: "broken",
		scenarioId: "s",
		error: "adapter exploded",
	});
	expect(result.failures[0]?.stack).toContain("Error: adapter exploded");
	expect(result.observations).toHaveLength(1);
});

it("rejects an inconsistent scenario before running any adapter", async () => {
	const adapter = fakeAdapter();
	const broken: Scenario = {
		...scenario,
		attempts: [{ toolId: "t", args: {}, expect: "executed" }],
	};
	await expect(runSuite([adapter], [broken])).rejects.toThrow(/attempt 0/);
	expect(adapter.run).not.toHaveBeenCalled();
});
