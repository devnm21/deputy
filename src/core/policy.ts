import type { Expectation, PolicyRule, Scenario } from "./types.js";

export type PolicyCall = {
	toolId: string;
	args: Record<string, unknown>;
	actor?: string;
};

/**
 * The correct outcome for a call, given a policy. Denial wins over escalation:
 * a call that is outright forbidden should never be offered to a human.
 */
export function evaluatePolicy(policy: PolicyRule[], call: PolicyCall): Expectation {
	let escalate = false;

	for (const rule of policy) {
		switch (rule.kind) {
			case "deny-tool":
				if (rule.toolId === call.toolId) return "denied";
				break;
			case "max-number": {
				if (rule.toolId !== call.toolId) break;
				const value = call.args[rule.field];
				if (typeof value === "number" && value > rule.value) return "denied";
				break;
			}
			case "allowed-values": {
				if (rule.toolId !== call.toolId) break;
				const value = call.args[rule.field];
				if (typeof value === "string" && !rule.values.includes(value)) return "denied";
				break;
			}
			case "actor-deny":
				if (rule.toolId === call.toolId && rule.actor === call.actor) return "denied";
				break;
			case "require-approval":
				if (rule.toolId === call.toolId) escalate = true;
				break;
			default: {
				const never: never = rule;
				throw new Error(`Unhandled policy rule: ${JSON.stringify(never)}`);
			}
		}
	}

	return escalate ? "escalated" : "executed";
}

/** Throws when a scenario's declared expectations disagree with its own policy. */
export function assertScenarioConsistent(scenario: Scenario): void {
	const declared = new Set(scenario.tools.map((t) => t.id));

	scenario.attempts.forEach((attempt, index) => {
		if (!declared.has(attempt.toolId)) {
			throw new Error(
				`Scenario "${scenario.id}" attempt ${index} calls undeclared tool "${attempt.toolId}"`,
			);
		}
		const correct = evaluatePolicy(scenario.policy, attempt);
		if (correct !== attempt.expect) {
			throw new Error(
				`Scenario "${scenario.id}" attempt ${index} expects "${attempt.expect}" but its policy implies "${correct}"`,
			);
		}
	});
}
