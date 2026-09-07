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

it("covers every failure class", () => {
	const classes = new Set(allScenarios.map((s) => s.class));
	expect([...classes].sort()).toEqual([
		"argument-scoping",
		"basics",
		"delegation",
		"escalation",
		"parallel-siblings",
		"policy-attachment",
	]);
});

it("policy-attachment scenarios declare an attachmentSurface", () => {
	const pa = allScenarios.filter((s) => s.class === "policy-attachment");
	expect(pa.length).toBeGreaterThan(0);
	for (const s of pa) {
		expect(s.attachmentSurface, `${s.id} missing attachmentSurface`).toBeDefined();
		expect(["tool", "caller"]).toContain(s.attachmentSurface);
	}
});

it("policy-attachment includes both surfaces as a pair", () => {
	const pa = allScenarios.filter((s) => s.class === "policy-attachment");
	const surfaces = new Set(pa.map((s) => s.attachmentSurface));
	expect(surfaces.has("tool")).toBe(true);
	expect(surfaces.has("caller")).toBe(true);
});

it("declares an owner for every tool a sub-agent calls", () => {
	// An attempt with an actor whose tool has no owner would be scripted onto the
	// root agent, so the delegation hop would silently not happen and the row
	// would report enforcement it never tested.
	for (const scenario of allScenarios) {
		for (const attempt of scenario.attempts) {
			if (attempt.actor === undefined) continue;
			const spec = scenario.tools.find((t) => t.id === attempt.toolId);
			expect(spec?.owner, `${scenario.id} / ${attempt.toolId}`).toBe(attempt.actor);
		}
	}
});
