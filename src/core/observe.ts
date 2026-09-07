import { attributeExecutions } from "./attribute.js";
import type { Ledger } from "./ledger.js";
import { prematureExecutionIndices } from "./ordering.js";
import type { Observation, Scenario } from "./types.js";

/** Build observations with ledger-derived execution and ordering violations. */
export function buildObservations(
	scenario: Scenario,
	ledger: Ledger,
	adapter: string,
	escalations: Map<number, unknown>,
	siblings: Map<number, number[]>,
	inexpressible: boolean | ((index: number) => boolean),
): Observation[] {
	const executed = attributeExecutions(scenario.attempts, ledger.entries());
	const premature = prematureExecutionIndices(scenario.attempts, ledger);

	return scenario.attempts.map((attempt, index): Observation => {
		let observed: Observation["observed"];
		if (executed[index]) observed = "executed";
		else if (escalations.has(index)) observed = "escalated";
		else observed = "denied";

		const inexpressibleValue =
			typeof inexpressible === "function" ? inexpressible(index) : inexpressible;

		return {
			scenarioId: scenario.id,
			class: scenario.class,
			adapter,
			attemptIndex: index,
			toolId: attempt.toolId,
			expected: attempt.expect,
			observed,
			escalationPayload: escalations.get(index),
			prematureExecution: premature.has(index),
			inexpressible: inexpressibleValue,
			parallelWith: siblings.get(index),
		};
	});
}
