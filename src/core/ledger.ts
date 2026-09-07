export type LedgerEntry = {
	toolId: string;
	args: Record<string, unknown>;
	actor?: string;
};

export type Ledger = {
	/** Called from inside an instrumented tool body, before any other work. */
	record(entry: LedgerEntry): void;
	/** True when the tool body ran. With an actor, only counts that actor's runs. */
	ran(toolId: string, actor?: string): boolean;
	entries(): LedgerEntry[];
};

/**
 * The single source of truth for whether a tool executed.
 *
 * Framework result objects are not usable for this. In the Vercel AI SDK an
 * approved tool runs during message reconstruction before the next model call,
 * so its result is absent from that step's toolResults — inferring execution
 * from the framework would report "denied" for every approved call.
 */
export function createLedger(): Ledger {
	const log: LedgerEntry[] = [];

	return {
		// Copied on capture. Adapters pass the live args object their framework
		// handed them, which the framework may reuse or mutate after the call.
		record(entry) {
			log.push({ ...entry, args: { ...entry.args } });
		},
		ran(toolId, actor) {
			return log.some(
				(entry) => entry.toolId === toolId && (actor === undefined || entry.actor === actor),
			);
		},
		entries() {
			return [...log];
		},
	};
}
