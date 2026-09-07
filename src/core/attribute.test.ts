import { describe, expect, it } from "vitest";
import { attributeExecutions } from "./attribute.js";
import type { LedgerEntry } from "./ledger.js";
import type { Attempt } from "./types.js";

describe("attributeExecutions", () => {
	it("attributes execution to the attempt with matching args, not the other same-tool attempt", () => {
		const attempts: Attempt[] = [
			{ toolId: "refund", args: { amount: 50 }, expect: "executed" },
			{ toolId: "refund", args: { amount: 50000 }, expect: "denied" },
		];
		const entries: LedgerEntry[] = [{ toolId: "refund", args: { amount: 50 } }];

		expect(attributeExecutions(attempts, entries)).toEqual([true, false]);
	});

	it("claims at most one attempt when args are identical", () => {
		const attempts: Attempt[] = [
			{ toolId: "refund", args: { amount: 50 }, expect: "executed" },
			{ toolId: "refund", args: { amount: 50 }, expect: "denied" },
		];
		const entries: LedgerEntry[] = [{ toolId: "refund", args: { amount: 50 } }];

		expect(attributeExecutions(attempts, entries)).toEqual([true, false]);
	});

	it("returns false when the tool never ran", () => {
		const attempts: Attempt[] = [{ toolId: "refund", args: { amount: 50000 }, expect: "denied" }];
		const entries: LedgerEntry[] = [];

		expect(attributeExecutions(attempts, entries)).toEqual([false]);
	});

	it("matches actor when the attempt specifies one", () => {
		const attempts: Attempt[] = [
			{ toolId: "write", args: { text: "hi" }, expect: "executed", actor: "child" },
		];
		const entriesWithoutActor: LedgerEntry[] = [{ toolId: "write", args: { text: "hi" } }];
		const entriesWithChild: LedgerEntry[] = [
			{ toolId: "write", args: { text: "hi" }, actor: "child" },
		];

		expect(attributeExecutions(attempts, entriesWithoutActor)).toEqual([false]);
		expect(attributeExecutions(attempts, entriesWithChild)).toEqual([true]);
	});

	it("preserves attempt order in the returned array", () => {
		const attempts: Attempt[] = [
			{ toolId: "read", args: { id: "1" }, expect: "executed" },
			{ toolId: "write", args: { text: "a" }, expect: "denied" },
			{ toolId: "delete", args: { id: "9" }, expect: "executed" },
		];
		const entries: LedgerEntry[] = [
			{ toolId: "delete", args: { id: "9" } },
			{ toolId: "read", args: { id: "1" } },
		];

		expect(attributeExecutions(attempts, entries)).toEqual([true, false, true]);
	});
});
