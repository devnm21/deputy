import { describe, expect, it } from "vitest";
import { attributeExecutions } from "./attribute.js";
import type { LedgerEntry } from "./ledger.js";
import type { Attempt } from "./types.js";

const entry = (
	toolId: string,
	args: Record<string, unknown>,
	sequence = 1,
	actor?: string,
): LedgerEntry => ({ toolId, args, sequence, actor });

describe("attributeExecutions", () => {
	it("attributes execution to the attempt with matching args, not the other same-tool attempt", () => {
		const attempts: Attempt[] = [
			{ toolId: "refund", args: { amount: 50 }, expect: "executed" },
			{ toolId: "refund", args: { amount: 50000 }, expect: "denied" },
		];
		const entries: LedgerEntry[] = [entry("refund", { amount: 50 })];

		expect(attributeExecutions(attempts, entries)).toEqual([true, false]);
	});

	it("claims at most one attempt when args are identical", () => {
		const attempts: Attempt[] = [
			{ toolId: "refund", args: { amount: 50 }, expect: "executed" },
			{ toolId: "refund", args: { amount: 50 }, expect: "denied" },
		];
		const entries: LedgerEntry[] = [entry("refund", { amount: 50 })];

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
		const entriesWithoutActor: LedgerEntry[] = [entry("write", { text: "hi" })];
		const entriesWithChild: LedgerEntry[] = [entry("write", { text: "hi" }, 1, "child")];

		expect(attributeExecutions(attempts, entriesWithoutActor)).toEqual([false]);
		expect(attributeExecutions(attempts, entriesWithChild)).toEqual([true]);
	});

	it("matches args regardless of key order", () => {
		const attempts: Attempt[] = [
			{ toolId: "refund", args: { customer: "c-1", amount: 50 }, expect: "executed" },
		];
		const entries: LedgerEntry[] = [entry("refund", { amount: 50, customer: "c-1" })];

		expect(attributeExecutions(attempts, entries)).toEqual([true]);
	});

	it("does not match genuinely different values", () => {
		const attempts: Attempt[] = [{ toolId: "refund", args: { amount: 50 }, expect: "executed" }];
		const entries: LedgerEntry[] = [entry("refund", { amount: 999 })];

		expect(attributeExecutions(attempts, entries)).toEqual([false]);
	});

	it("matches nested objects with differing key order", () => {
		const attempts: Attempt[] = [
			{
				toolId: "update",
				args: { data: { b: 2, a: 1 } },
				expect: "executed",
			},
		];
		const entries: LedgerEntry[] = [entry("update", { data: { a: 1, b: 2 } })];

		expect(attributeExecutions(attempts, entries)).toEqual([true]);
	});

	it("treats arrays in different order as unequal", () => {
		const attempts: Attempt[] = [{ toolId: "batch", args: { ids: [1, 2, 3] }, expect: "executed" }];
		const entries: LedgerEntry[] = [entry("batch", { ids: [3, 2, 1] })];

		expect(attributeExecutions(attempts, entries)).toEqual([false]);
	});

	it("preserves attempt order in the returned array", () => {
		const attempts: Attempt[] = [
			{ toolId: "read", args: { id: "1" }, expect: "executed" },
			{ toolId: "write", args: { text: "a" }, expect: "denied" },
			{ toolId: "delete", args: { id: "9" }, expect: "executed" },
		];
		const entries: LedgerEntry[] = [entry("delete", { id: "9" }), entry("read", { id: "1" }, 2)];

		expect(attributeExecutions(attempts, entries)).toEqual([true, false, true]);
	});
});
