import { describe, expect, it } from "vitest";
import { computeMetrics, payloadCovers } from "./metrics.js";
import type { Attempt, Observation } from "./types.js";

const obs = (over: Partial<Observation>): Observation => ({
	scenarioId: "s",
	class: "basics",
	adapter: "test",
	attemptIndex: 0,
	toolId: "t",
	expected: "denied",
	observed: "denied",
	inexpressible: false,
	...over,
});

describe("payloadCovers", () => {
	it("scores 1 when every decision-critical value appears", () => {
		const payload = { input: { amount: 5000, to: "all@x.com" } };
		expect(payloadCovers(payload, { amount: 5000, to: "all@x.com" }, ["amount", "to"])).toBe(1);
	});

	it("scores 0.5 when half the values appear", () => {
		const payload = { input: { amount: 5000 } };
		expect(payloadCovers(payload, { amount: 5000, to: "all@x.com" }, ["amount", "to"])).toBe(0.5);
	});

	it("scores 0 for a payload naming only the tool", () => {
		expect(payloadCovers({ toolName: "refund" }, { amount: 5000 }, ["amount"])).toBe(0);
	});
});

describe("computeMetrics", () => {
	const attempts: Map<string, Attempt[]> = new Map([
		[
			"s",
			[
				{
					toolId: "t",
					args: { amount: 5000 },
					expect: "escalated",
					decisionCriticalFields: ["amount"],
				},
			],
		],
	]);

	it("counts an executed should-deny attempt as unauthorized execution", () => {
		const m = computeMetrics([obs({ expected: "denied", observed: "executed" })], attempts);
		expect(m.unauthorizedExecutionRate).toBe(1);
		expect(m.overBlockRate).toBe(0);
	});

	it("counts a denied should-execute attempt as over-block", () => {
		const m = computeMetrics([obs({ expected: "executed", observed: "denied" })], attempts);
		expect(m.overBlockRate).toBe(1);
		expect(m.unauthorizedExecutionRate).toBe(0);
	});

	it("treats an escalated should-deny attempt as authorized, not executed", () => {
		const m = computeMetrics([obs({ expected: "denied", observed: "escalated" })], attempts);
		expect(m.unauthorizedExecutionRate).toBe(0);
	});

	it("scores escalation informativeness from the payload", () => {
		const m = computeMetrics(
			[
				obs({
					expected: "escalated",
					observed: "escalated",
					escalationPayload: { input: { amount: 5000 } },
				}),
			],
			attempts,
		);
		expect(m.escalationInformativeness).toBe(1);
	});

	it("reports the expressiveness gap", () => {
		const m = computeMetrics(
			[obs({ inexpressible: true }), obs({ inexpressible: false })],
			attempts,
		);
		expect(m.expressivenessGap).toBe(0.5);
	});

	it("returns zero rates rather than NaN when a denominator is empty", () => {
		const m = computeMetrics([], attempts);
		expect(m.unauthorizedExecutionRate).toBe(0);
		expect(m.overBlockRate).toBe(0);
		expect(m.escalationInformativeness).toBe(0);
		expect(m.expressivenessGap).toBe(0);
	});
});
