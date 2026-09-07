// src/core/ledger.test.ts
import { expect, it } from "vitest";
import { createLedger } from "./ledger.js";

it("reports nothing ran on a fresh ledger", () => {
	const ledger = createLedger();
	expect(ledger.ran("refund")).toBe(false);
	expect(ledger.entries()).toEqual([]);
});

it("records an execution and reports it ran", () => {
	const ledger = createLedger();
	ledger.record({ toolId: "refund", args: { amount: 5000 } });
	expect(ledger.ran("refund")).toBe(true);
	expect(ledger.entries()).toEqual([{ toolId: "refund", args: { amount: 5000 } }]);
});

it("distinguishes executions by actor", () => {
	const ledger = createLedger();
	ledger.record({ toolId: "write", args: {}, actor: "child" });
	expect(ledger.ran("write", "child")).toBe(true);
	expect(ledger.ran("write", "root")).toBe(false);
	expect(ledger.ran("write")).toBe(true);
});

it("records repeat executions separately", () => {
	const ledger = createLedger();
	ledger.record({ toolId: "delete", args: { id: 1 } });
	ledger.record({ toolId: "delete", args: { id: 2 } });
	expect(ledger.entries()).toHaveLength(2);
});
