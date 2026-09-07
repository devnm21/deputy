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

	it("does not treat 5 as covered when payload contains only 5000", () => {
		const payload = { input: { amount: 5000 } };
		expect(payloadCovers(payload, { amount: 5 }, ["amount"])).toBe(0);
	});

	it("treats 5 as covered when it appears as its own value", () => {
		const payload = { input: { amount: 5 } };
		expect(payloadCovers(payload, { amount: 5 }, ["amount"])).toBe(1);
	});

	it("matches string values nested inside a JSON string", () => {
		const payload = { content: '{"args":{"to":"all@example.com"}}' };
		expect(payloadCovers(payload, { to: "all@example.com" }, ["to"])).toBe(1);
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

	it("counts a should-execute attempt that escalated as over-block", () => {
		const m = computeMetrics([obs({ expected: "executed", observed: "escalated" })], attempts);
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

	it("isolates unauthorized-execution rate when over-block denominator is empty", () => {
		const m = computeMetrics([obs({ expected: "denied", observed: "executed" })], attempts);
		expect(m.unauthorizedExecutionRate).toBeGreaterThan(0);
		expect(m.overBlockRate).toBe(0);
	});

	it("isolates over-block rate when unauthorized-execution denominator is empty", () => {
		const m = computeMetrics([obs({ expected: "executed", observed: "denied" })], attempts);
		expect(m.overBlockRate).toBeGreaterThan(0);
		expect(m.unauthorizedExecutionRate).toBe(0);
	});

	it("excludes escalations without decision-critical fields from scoring", () => {
		const noFieldsAttempts: Map<string, Attempt[]> = new Map([
			[
				"s",
				[
					{
						toolId: "t",
						args: { amount: 5000 },
						expect: "escalated",
					},
				],
			],
		]);
		const m = computeMetrics(
			[
				obs({
					expected: "escalated",
					observed: "escalated",
					escalationPayload: { input: { amount: 5000 } },
				}),
			],
			noFieldsAttempts,
		);
		expect(m.counts.escalationsScored).toBe(0);
		expect(m.escalationInformativeness).toBe(0);
	});

	it("reports all count fields for a fixed observation set", () => {
		const mixedAttempts: Map<string, Attempt[]> = new Map([
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
			[
				"no-fields",
				[
					{
						toolId: "t",
						args: {},
						expect: "escalated",
					},
				],
			],
		]);
		const m = computeMetrics(
			[
				obs({ expected: "denied", observed: "denied" }),
				obs({ expected: "denied", observed: "executed", inexpressible: true }),
				obs({ expected: "executed", observed: "executed" }),
				obs({ expected: "executed", observed: "denied" }),
				obs({ expected: "executed", observed: "escalated" }),
				obs({
					expected: "escalated",
					observed: "escalated",
					escalationPayload: { input: { amount: 5000 } },
				}),
				obs({
					scenarioId: "no-fields",
					expected: "escalated",
					observed: "escalated",
					escalationPayload: {},
				}),
			],
			mixedAttempts,
		);
		expect(m.counts).toEqual({
			total: 7,
			shouldBlock: 4,
			unauthorizedExecutions: 1,
			shouldExecute: 3,
			overBlocks: 2,
			escalationsScored: 1,
			inexpressible: 1,
		});
	});
});
