import { describe, expect, it } from "vitest";
import { assertScenarioConsistent, evaluatePolicy } from "./policy.js";
import type { PolicyRule, Scenario } from "./types.js";

describe("evaluatePolicy", () => {
	it("denies a tool with a deny-tool rule", () => {
		const policy: PolicyRule[] = [{ kind: "deny-tool", toolId: "wipe" }];
		expect(evaluatePolicy(policy, { toolId: "wipe", args: {} })).toBe("denied");
	});

	it("executes a tool with no governing rule", () => {
		expect(evaluatePolicy([], { toolId: "read", args: {} })).toBe("executed");
	});

	it("denies when a numeric argument exceeds its cap", () => {
		const policy: PolicyRule[] = [
			{ kind: "max-number", toolId: "refund", field: "amount", value: 100 },
		];
		expect(evaluatePolicy(policy, { toolId: "refund", args: { amount: 5000 } })).toBe("denied");
		expect(evaluatePolicy(policy, { toolId: "refund", args: { amount: 50 } })).toBe("executed");
	});

	it("denies when a max-number governed field is missing", () => {
		const policy: PolicyRule[] = [
			{ kind: "max-number", toolId: "refund", field: "amount", value: 100 },
		];
		expect(evaluatePolicy(policy, { toolId: "refund", args: {} })).toBe("denied");
	});

	it("denies when a max-number governed field has the wrong type", () => {
		const policy: PolicyRule[] = [
			{ kind: "max-number", toolId: "refund", field: "amount", value: 100 },
		];
		expect(evaluatePolicy(policy, { toolId: "refund", args: { amount: "50" } })).toBe("denied");
	});

	it("denies when a string argument is outside the allowed set", () => {
		const policy: PolicyRule[] = [
			{ kind: "allowed-values", toolId: "email", field: "to", values: ["a@x.com"] },
		];
		expect(evaluatePolicy(policy, { toolId: "email", args: { to: "all@x.com" } })).toBe("denied");
		expect(evaluatePolicy(policy, { toolId: "email", args: { to: "a@x.com" } })).toBe("executed");
	});

	it("denies when an allowed-values governed field is missing", () => {
		const policy: PolicyRule[] = [
			{ kind: "allowed-values", toolId: "email", field: "to", values: ["a@x.com"] },
		];
		expect(evaluatePolicy(policy, { toolId: "email", args: {} })).toBe("denied");
	});

	it("denies when an allowed-values governed field has the wrong type", () => {
		const policy: PolicyRule[] = [
			{ kind: "allowed-values", toolId: "email", field: "to", values: ["a@x.com"] },
		];
		expect(evaluatePolicy(policy, { toolId: "email", args: { to: 1 } })).toBe("denied");
	});

	it("denies a call from a forbidden actor", () => {
		const policy: PolicyRule[] = [{ kind: "actor-deny", actor: "child", toolId: "write" }];
		expect(evaluatePolicy(policy, { toolId: "write", args: {}, actor: "child" })).toBe("denied");
		expect(evaluatePolicy(policy, { toolId: "write", args: {} })).toBe("executed");
	});

	it("escalates when approval is required and nothing denies", () => {
		const policy: PolicyRule[] = [{ kind: "require-approval", toolId: "refund" }];
		expect(evaluatePolicy(policy, { toolId: "refund", args: {} })).toBe("escalated");
	});

	it("prefers denial over escalation when require-approval precedes max-number", () => {
		const policy: PolicyRule[] = [
			{ kind: "require-approval", toolId: "refund" },
			{ kind: "max-number", toolId: "refund", field: "amount", value: 100 },
		];
		expect(evaluatePolicy(policy, { toolId: "refund", args: { amount: 999 } })).toBe("denied");
	});

	it("prefers denial over escalation when max-number precedes require-approval", () => {
		const policy: PolicyRule[] = [
			{ kind: "max-number", toolId: "refund", field: "amount", value: 100 },
			{ kind: "require-approval", toolId: "refund" },
		];
		expect(evaluatePolicy(policy, { toolId: "refund", args: { amount: 999 } })).toBe("denied");
	});

	it("prefers denial over escalation when deny-tool precedes require-approval", () => {
		const policy: PolicyRule[] = [
			{ kind: "deny-tool", toolId: "wipe" },
			{ kind: "require-approval", toolId: "wipe" },
		];
		expect(evaluatePolicy(policy, { toolId: "wipe", args: {} })).toBe("denied");
	});

	it("prefers denial over escalation when require-approval precedes deny-tool", () => {
		const policy: PolicyRule[] = [
			{ kind: "require-approval", toolId: "wipe" },
			{ kind: "deny-tool", toolId: "wipe" },
		];
		expect(evaluatePolicy(policy, { toolId: "wipe", args: {} })).toBe("denied");
	});
});

describe("assertScenarioConsistent", () => {
	const base: Scenario = {
		id: "s",
		class: "argument-scoping",
		description: "d",
		tools: [{ id: "refund", description: "r", fields: [{ name: "amount", type: "number" }] }],
		policy: [{ kind: "max-number", toolId: "refund", field: "amount", value: 100 }],
		attempts: [{ toolId: "refund", args: { amount: 5000 }, expect: "denied" }],
	};

	it("accepts a scenario whose expectations match its policy", () => {
		expect(() => assertScenarioConsistent(base)).not.toThrow();
	});

	it("rejects a scenario whose expectation contradicts its policy", () => {
		const broken: Scenario = {
			...base,
			attempts: [{ toolId: "refund", args: { amount: 5000 }, expect: "executed" }],
		};
		expect(() => assertScenarioConsistent(broken)).toThrow(
			/attempt 0 expects "executed" but its policy implies "denied"/,
		);
	});

	it("rejects a scenario referencing an undeclared tool", () => {
		const broken: Scenario = {
			...base,
			attempts: [{ toolId: "ghost", args: {}, expect: "executed" }],
		};
		expect(() => assertScenarioConsistent(broken)).toThrow(/ghost/);
	});
});
