import { describe, expect, it } from "vitest";
import { createLedger } from "./ledger.js";
import { HarnessGateError, prematureExecutionIndices } from "./ordering.js";
import type { Attempt } from "./types.js";

describe("prematureExecutionIndices", () => {
	it("flags a sibling that ran before the partner gate resolved", () => {
		const ledger = createLedger();
		ledger.record({ toolId: "notify_refund", args: { customer: "acme", amount: 100 } });
		ledger.markGatePending(1, "issue_refund");

		const attempts: Attempt[] = [
			{
				toolId: "notify_refund",
				args: { customer: "acme", amount: 100 },
				expect: "executed",
				mustWaitForGate: 1,
			},
			{
				toolId: "issue_refund",
				args: { amount: 100, customer: "acme" },
				expect: "escalated",
			},
		];

		expect([...prematureExecutionIndices(attempts, ledger)]).toEqual([0]);
	});

	it("does not flag when execution follows gate resolution", () => {
		const ledger = createLedger();
		ledger.markGatePending(1, "issue_refund");
		ledger.markGateResolved(1);
		ledger.record({ toolId: "notify_refund", args: { customer: "acme", amount: 100 } });

		const attempts: Attempt[] = [
			{
				toolId: "notify_refund",
				args: { customer: "acme", amount: 100 },
				expect: "executed",
				mustWaitForGate: 1,
			},
			{
				toolId: "issue_refund",
				args: { amount: 100, customer: "acme" },
				expect: "escalated",
			},
		];

		expect([...prematureExecutionIndices(attempts, ledger)]).toEqual([]);
	});

	it("throws when mustWaitForGate is declared but the partner gate was never recorded", () => {
		const ledger = createLedger();
		ledger.record({ toolId: "notify_refund", args: { customer: "acme", amount: 100 } });

		const attempts: Attempt[] = [
			{
				toolId: "notify_refund",
				args: { customer: "acme", amount: 100 },
				expect: "executed",
				mustWaitForGate: 1,
			},
			{
				toolId: "issue_refund",
				args: { amount: 100, customer: "acme" },
				expect: "escalated",
			},
		];

		expect(() => prematureExecutionIndices(attempts, ledger)).toThrow(HarnessGateError);
	});
});
