import type { LedgerEntry } from "./ledger.js";
import type { Attempt } from "./types.js";

export function attributeExecutions(attempts: Attempt[], entries: LedgerEntry[]): boolean[] {
	const claimed = new Set<number>();

	return attempts.map((attempt) => {
		for (let i = 0; i < entries.length; i++) {
			if (claimed.has(i)) continue;

			const entry = entries[i];
			if (entry === undefined) continue;
			if (entry.toolId !== attempt.toolId) continue;
			if (JSON.stringify(entry.args) !== JSON.stringify(attempt.args)) continue;
			if (attempt.actor !== undefined) {
				if (entry.actor !== attempt.actor) continue;
			} else if (entry.actor !== undefined) {
				continue;
			}

			claimed.add(i);
			return true;
		}
		return false;
	});
}
