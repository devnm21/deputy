import type { Attempt } from "./types.js";

export type StepEntry = { index: number; attempt: Attempt };

/**
 * Group attempts into steps. Attempts sharing a step index belong to one step
 * and are emitted together as parallel tool calls; attempts without a step index
 * each get a step of their own.
 *
 * Source order is preserved. Keying ungrouped attempts by a synthetic negative
 * index and sorting would emit them in reverse, which is harmless while
 * attribution matches on arguments but wrong for any order-sensitive scenario.
 *
 * Shared by all three adapters, because each of them needs the same grouping and
 * three copies would be three chances for them to disagree about what "parallel"
 * means — which would make the parallel-siblings column incomparable across rows.
 */
export function groupIntoSteps(attempts: Attempt[]): StepEntry[][] {
	const groups: StepEntry[][] = [];
	const byStep = new Map<number, StepEntry[]>();

	attempts.forEach((attempt, index) => {
		const entry = { index, attempt };
		if (attempt.step === undefined) {
			groups.push([entry]);
			return;
		}
		const existing = byStep.get(attempt.step);
		if (existing) {
			existing.push(entry);
			return;
		}
		const group = [entry];
		byStep.set(attempt.step, group);
		groups.push(group);
	});

	return groups;
}

/**
 * For each attempt index, the other attempt indices emitted in the same step.
 * Recorded on every observation so a reader of a parallel-siblings result can
 * check that the calls really were batched into one turn.
 */
export function siblingIndex(groups: StepEntry[][]): Map<number, number[]> {
	const siblings = new Map<number, number[]>();
	for (const group of groups) {
		for (const { index } of group) {
			siblings.set(
				index,
				group.map((e) => e.index).filter((i) => i !== index),
			);
		}
	}
	return siblings;
}
