import { assertScenarioConsistent } from "./policy.js";
import type { Adapter, Observation, Scenario } from "./types.js";

export type SuiteFailure = {
	adapter: string;
	scenarioId: string;
	error: string;
};

export type SuiteResult = {
	observations: Observation[];
	failures: SuiteFailure[];
};

/**
 * Runs every scenario against every adapter.
 *
 * Scenario consistency is checked up front and throws: an inconsistent scenario
 * would silently corrupt every metric, so it is a bug in the corpus rather than
 * a result. An adapter that throws is recorded and the suite continues, since
 * one broken adapter should not cost the whole run.
 */
export async function runSuite(adapters: Adapter[], scenarios: Scenario[]): Promise<SuiteResult> {
	for (const scenario of scenarios) {
		assertScenarioConsistent(scenario);
	}

	const observations: Observation[] = [];
	const failures: SuiteFailure[] = [];

	for (const adapter of adapters) {
		for (const scenario of scenarios) {
			try {
				observations.push(...(await adapter.run(scenario)));
			} catch (error) {
				failures.push({
					adapter: adapter.name,
					scenarioId: scenario.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return { observations, failures };
}
