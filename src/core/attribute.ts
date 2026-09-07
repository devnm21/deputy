import type { LedgerEntry } from "./ledger.js";
import type { Attempt } from "./types.js";

/**
 * Order-insensitive structural deep equal. Key insertion order in objects is
 * irrelevant; array element order is significant and preserved.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;

	if (Array.isArray(a)) {
		if (!Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}

	if (typeof a === "object" && typeof b === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj);
		const bKeys = Object.keys(bObj);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
	}

	return false;
}

export function attributeExecutions(attempts: Attempt[], entries: LedgerEntry[]): boolean[] {
	const claimed = new Set<number>();

	return attempts.map((attempt) => {
		for (let i = 0; i < entries.length; i++) {
			if (claimed.has(i)) continue;

			const entry = entries[i];
			if (entry === undefined) continue;
			if (entry.toolId !== attempt.toolId) continue;
			if (!deepEqual(entry.args, attempt.args)) continue;
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
