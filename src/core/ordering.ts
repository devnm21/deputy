import type { Ledger, LedgerEntry } from "./ledger.js";
import type { Attempt } from "./types.js";

/** Thrown when gate timeline recording is incomplete for a scored ordering check. */
export class HarnessGateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HarnessGateError";
	}
}

/**
 * True when this execution ran before the partner attempt's approval gate
 * resolved. The partner gate must reach `gate-resolved`; if it never does,
 * any execution is treated as premature.
 */
export function executedBeforeGateResolved(
	entry: LedgerEntry,
	mustWaitForGate: number,
	gateEvents: ReturnType<Ledger["gateEvents"]>,
): boolean {
	const pending = gateEvents.find(
		(event) => event.kind === "gate-pending" && event.attemptIndex === mustWaitForGate,
	);
	if (!pending) {
		throw new HarnessGateError(
			`attempt declares mustWaitForGate=${mustWaitForGate} but no gate-pending event was recorded for that partner`,
		);
	}

	const resolved = gateEvents.find(
		(event) => event.kind === "gate-resolved" && event.attemptIndex === mustWaitForGate,
	);
	if (!resolved) return true;

	return entry.sequence < resolved.sequence;
}

/** Attempt indices whose tool body ran while a declared gate was still pending. */
export function prematureExecutionIndices(attempts: Attempt[], ledger: Ledger): Set<number> {
	const violations = new Set<number>();
	const entries = ledger.entries();
	const gateEvents = ledger.gateEvents();

	attempts.forEach((attempt, index) => {
		if (attempt.mustWaitForGate === undefined) return;

		const entry = entries.find(
			(candidate) =>
				candidate.toolId === attempt.toolId && shallowArgsEqual(candidate.args, attempt.args),
		);
		if (!entry) return;

		if (executedBeforeGateResolved(entry, attempt.mustWaitForGate, gateEvents)) {
			violations.add(index);
		}
	});

	return violations;
}

function shallowArgsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key) => a[key] === b[key]);
}
