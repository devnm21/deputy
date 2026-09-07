import { describe, expect, it } from "vitest";
import type { Scenario } from "../../core/types.js";
import { createVercelAiAdapter } from "./index.js";

const adapter = createVercelAiAdapter();

describe("vercel-ai adapter", () => {
	it("blocks a plainly forbidden tool", async () => {
		const scenario: Scenario = {
			id: "basics-denied-tool",
			class: "basics",
			description: "a forbidden tool is never executed",
			tools: [
				{ id: "wipe", description: "wipe everything", fields: [{ name: "scope", type: "string" }] },
			],
			policy: [{ kind: "deny-tool", toolId: "wipe" }],
			attempts: [{ toolId: "wipe", args: { scope: "all" }, expect: "denied" }],
		};
		const [observation] = await adapter.run(scenario);
		expect(observation?.observed).toBe("denied");
	});

	it("executes a call that policy permits", async () => {
		const scenario: Scenario = {
			id: "basics-allowed-tool",
			class: "basics",
			description: "a permitted tool executes",
			tools: [
				{ id: "read", description: "read a record", fields: [{ name: "id", type: "string" }] },
			],
			policy: [],
			attempts: [{ toolId: "read", args: { id: "42" }, expect: "executed" }],
		};
		const [observation] = await adapter.run(scenario);
		expect(observation?.observed).toBe("executed");
	});

	it("denies a call whose argument exceeds its cap", async () => {
		const scenario: Scenario = {
			id: "argument-scoping-cap",
			class: "argument-scoping",
			description: "the tool is allowed but the amount is not",
			tools: [
				{
					id: "refund",
					description: "issue a refund",
					fields: [{ name: "amount", type: "number" }],
				},
			],
			policy: [{ kind: "max-number", toolId: "refund", field: "amount", value: 100 }],
			attempts: [{ toolId: "refund", args: { amount: 5000 }, expect: "denied" }],
		};
		const [observation] = await adapter.run(scenario);
		expect(observation?.observed).toBe("denied");
	});

	it("escalates an approval-required call and captures the payload", async () => {
		const scenario: Scenario = {
			id: "escalation-payload",
			class: "escalation",
			description: "an approval request carries the deciding arguments",
			tools: [
				{
					id: "refund",
					description: "issue a refund",
					fields: [{ name: "amount", type: "number" }],
				},
			],
			policy: [{ kind: "require-approval", toolId: "refund" }],
			attempts: [
				{
					toolId: "refund",
					args: { amount: 5000 },
					expect: "escalated",
					decisionCriticalFields: ["amount"],
				},
			],
		};
		const [observation] = await adapter.run(scenario);
		expect(observation?.observed).toBe("escalated");
		expect(JSON.stringify(observation?.escalationPayload)).toContain("5000");
	});

	it("reports whether an ungated sibling runs beside a gated call", async () => {
		const scenario: Scenario = {
			id: "parallel-siblings",
			class: "parallel-siblings",
			description: "one gated call beside one ungated call in a single step",
			tools: [
				{ id: "note", description: "write a note", fields: [{ name: "text", type: "string" }] },
				{
					id: "refund",
					description: "issue a refund",
					fields: [{ name: "amount", type: "number" }],
				},
			],
			policy: [{ kind: "require-approval", toolId: "refund" }],
			attempts: [
				{ toolId: "note", args: { text: "hi" }, expect: "executed", step: 0 },
				{ toolId: "refund", args: { amount: 5000 }, expect: "escalated", step: 0 },
			],
		};
		const observations = await adapter.run(scenario);
		expect(observations).toHaveLength(2);
		// The finding: the ungated sibling executes while the gated call waits.
		expect(observations[0]?.observed).toBe("executed");
		expect(observations[1]?.observed).toBe("escalated");
	});

	it("declares argument predicates as expressible", () => {
		expect(adapter.capabilities.argumentPredicates).toBe(true);
	});
});
