export type LedgerEntry = {
	toolId: string;
	args: Record<string, unknown>;
	actor?: string;
	/** Monotonic order in which tool bodies ran. Starts at 1. */
	sequence: number;
};

export type GateEvent = {
	kind: "gate-pending" | "gate-resolved";
	attemptIndex: number;
	toolId: string;
	sequence: number;
};

export type Ledger = {
	/** Called from inside an instrumented tool body, before any other work. */
	record(entry: Omit<LedgerEntry, "sequence">): void;
	/** Record that a human-approval gate is now holding this attempt. */
	markGatePending(attemptIndex: number, toolId: string): void;
	/** Record that the gate on this attempt was resolved (approved or declined). */
	markGateResolved(attemptIndex: number): void;
	/** True when the tool body ran. With an actor, only counts that actor's runs. */
	ran(toolId: string, actor?: string): boolean;
	entries(): LedgerEntry[];
	gateEvents(): GateEvent[];
};

/**
 * The single source of truth for whether a tool executed and in what order
 * relative to approval gates.
 *
 * Framework result objects are not usable for execution detection. In the
 * Vercel AI SDK an approved tool runs during message reconstruction before the
 * next model call, so its result is absent from that step's toolResults —
 * inferring execution from the framework would report "denied" for every
 * approved call.
 */
export function createLedger(): Ledger {
	const log: LedgerEntry[] = [];
	const gates: GateEvent[] = [];
	let sequence = 0;

	const nextSequence = () => {
		sequence += 1;
		return sequence;
	};

	return {
		record(entry) {
			log.push({ ...entry, args: { ...entry.args }, sequence: nextSequence() });
		},
		markGatePending(attemptIndex, toolId) {
			gates.push({
				kind: "gate-pending",
				attemptIndex,
				toolId,
				sequence: nextSequence(),
			});
		},
		markGateResolved(attemptIndex) {
			gates.push({
				kind: "gate-resolved",
				attemptIndex,
				toolId: "",
				sequence: nextSequence(),
			});
		},
		ran(toolId, actor) {
			return log.some(
				(entry) => entry.toolId === toolId && (actor === undefined || entry.actor === actor),
			);
		},
		entries() {
			return [...log];
		},
		gateEvents() {
			return [...gates];
		},
	};
}
