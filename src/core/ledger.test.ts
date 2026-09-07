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
	expect(ledger.entries()).toEqual([{ toolId: "refund", args: { amount: 5000 }, sequence: 1 }]);
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

it("records gate pending and resolved events in order", () => {
	const ledger = createLedger();
	ledger.record({ toolId: "notify", args: {} });
	ledger.markGatePending(1, "refund");
	ledger.markGateResolved(1);
	expect(ledger.gateEvents()).toEqual([
		{ kind: "gate-pending", attemptIndex: 1, toolId: "refund", sequence: 2 },
		{ kind: "gate-resolved", attemptIndex: 1, toolId: "", sequence: 3 },
	]);
});

it("returns a copy from entries so callers cannot mutate ledger state", () => {
	const ledger = createLedger();
	ledger.record({ toolId: "refund", args: { amount: 5000 } });

	const snapshot = ledger.entries();
	snapshot.push({ toolId: "fabricated", args: { forged: true }, sequence: 99 });

	expect(ledger.entries()).toEqual([{ toolId: "refund", args: { amount: 5000 }, sequence: 1 }]);
	expect(ledger.entries()).toHaveLength(1);
});

it("copies args on record so later mutations do not rewrite history", () => {
	const ledger = createLedger();
	const args: Record<string, unknown> = { amount: 5000 };

	ledger.record({ toolId: "refund", args });
	args.amount = 9999;
	args.tampered = true;

	expect(ledger.entries()).toEqual([{ toolId: "refund", args: { amount: 5000 }, sequence: 1 }]);
});
