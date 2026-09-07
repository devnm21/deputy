import { expect, it } from "vitest";
import { groupIntoSteps, siblingIndex } from "./steps.js";
import type { Attempt } from "./types.js";

const attempt = (toolId: string, step?: number): Attempt => ({
	toolId,
	args: {},
	expect: "executed",
	step,
});

it("gives each ungrouped attempt a step of its own, in source order", () => {
	const groups = groupIntoSteps([attempt("a"), attempt("b")]);
	expect(groups.map((g) => g.map((e) => e.attempt.toolId))).toEqual([["a"], ["b"]]);
});

it("groups attempts sharing a step index into one step", () => {
	const groups = groupIntoSteps([attempt("a", 0), attempt("b", 0)]);
	expect(groups).toHaveLength(1);
	expect(groups[0]?.map((e) => e.attempt.toolId)).toEqual(["a", "b"]);
});

it("keeps the original attempt index on every entry", () => {
	const groups = groupIntoSteps([attempt("a"), attempt("b", 0), attempt("c", 0)]);
	expect(groups[1]?.map((e) => e.index)).toEqual([1, 2]);
});

it("preserves source order when grouped and ungrouped attempts are mixed", () => {
	const groups = groupIntoSteps([attempt("a", 0), attempt("b"), attempt("c", 0)]);
	expect(groups.map((g) => g.map((e) => e.attempt.toolId))).toEqual([["a", "c"], ["b"]]);
});

it("reports each attempt's siblings without listing the attempt itself", () => {
	const siblings = siblingIndex(groupIntoSteps([attempt("a", 0), attempt("b", 0), attempt("c")]));
	expect(siblings.get(0)).toEqual([1]);
	expect(siblings.get(1)).toEqual([0]);
	expect(siblings.get(2)).toEqual([]);
});
