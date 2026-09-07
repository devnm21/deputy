import { expect, it } from "vitest";
import { assertScenarioConsistent } from "../src/core/policy.js";
import { allScenarios } from "./index.js";

it("every scenario's expectations agree with its own policy", () => {
	for (const scenario of allScenarios) {
		expect(() => assertScenarioConsistent(scenario)).not.toThrow();
	}
});

it("scenario ids are unique", () => {
	const ids = allScenarios.map((s) => s.id);
	expect(new Set(ids).size).toBe(ids.length);
});
