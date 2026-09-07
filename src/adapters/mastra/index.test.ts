import { describe, expect, it } from "vitest";
import type { Scenario } from "../../core/types.js";
import { createMastraAdapter } from "./index.js";

const adapter = createMastraAdapter();

describe("mastra adapter", () => {
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

	it("escalates an approval-required call and captures the deciding arguments", async () => {
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

	it("declares argument predicates as expressible", () => {
		// requireApproval accepts (input, ctx) => boolean | Promise<boolean>.
		expect(adapter.capabilities.argumentPredicates).toBe(true);
	});
});
