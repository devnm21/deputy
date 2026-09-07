import { expect, it } from "vitest";
import { buildReport, renderMarkdown } from "./report.js";
import type { Adapter, Observation, Scenario } from "./types.js";

const scenario: Scenario = {
	id: "s",
	class: "basics",
	description: "d",
	tools: [{ id: "t", description: "t", fields: [] }],
	policy: [{ kind: "deny-tool", toolId: "t" }],
	attempts: [{ toolId: "t", args: {}, expect: "denied" }],
};

const adapter: Adapter = {
	name: "fake",
	frameworkVersion: "1.2.3",
	capabilities: {
		argumentPredicates: true,
		actorConstraints: false,
		structuredEscalationPayload: true,
	},
	run: async () => [],
};

const leaked: Observation = {
	scenarioId: "s",
	class: "basics",
	adapter: "fake",
	attemptIndex: 0,
	toolId: "t",
	expected: "denied",
	observed: "executed",
	inexpressible: false,
};

it("records framework versions and per-class metrics", () => {
	const report = buildReport({ observations: [leaked], failures: [] }, [adapter], [scenario]);
	expect(report.adapters[0]?.frameworkVersion).toBe("1.2.3");
	expect(report.adapters[0]?.classes.basics?.unauthorizedExecutionRate).toBe(1);
});

it("renders unauthorized execution and over-block together in one cell", () => {
	const report = buildReport({ observations: [leaked], failures: [] }, [adapter], [scenario]);
	const markdown = renderMarkdown(report);
	expect(markdown).toContain("100%");
	// Both numbers share a cell so neither can be quoted alone.
	expect(markdown).toMatch(/100% \/ \d+%/);
});

it("keeps every observation for per-case reproduction", () => {
	const report = buildReport({ observations: [leaked], failures: [] }, [adapter], [scenario]);
	expect(report.observations).toHaveLength(1);
	expect(report.observations[0]?.scenarioId).toBe("s");
});
