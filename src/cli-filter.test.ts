import { describe, expect, it } from "vitest";
import { allScenarios } from "../scenarios/index.js";
import { createMastraAdapter } from "./adapters/mastra/index.js";
import { runSuite } from "./core/runner.js";

describe("filtered run parity", () => {
	it("matches the full-suite observation for the same adapter and scenario", async () => {
		const scenarioId = "policy-attachment-caller-surface-delegation";
		const adapter = createMastraAdapter();
		const scenario = allScenarios.find((entry) => entry.id === scenarioId);
		expect(scenario).toBeDefined();

		const full = await runSuite([adapter], allScenarios);
		const filtered = await runSuite([adapter], [scenario as NonNullable<typeof scenario>]);

		const fromFull = full.observations.filter(
			(observation) => observation.scenarioId === scenarioId,
		);
		expect(filtered.observations).toEqual(fromFull);
	});
});
