import { expect, it } from "vitest";
import { buildReport, renderMarkdown } from "./report.js";
import type { Adapter, Observation, Scenario } from "./types.js";

const scenario: Scenario = {
	id: "s",
	class: "basics",
	description: "d",
	tools: [{ id: "t", description: "t", fields: [] }],
	policy: [{ kind: "deny-tool", toolId: "t" }],
	attempts: [{ toolId: "t", args: {}, expect: "denied" }],
};

const argumentScenario: Scenario = {
	id: "arg",
	class: "argument-scoping",
	description: "d",
	tools: [{ id: "t", description: "t", fields: [] }],
	policy: [{ kind: "deny-tool", toolId: "t" }],
	attempts: [{ toolId: "t", args: {}, expect: "denied" }],
};

const adapter: Adapter = {
	name: "fake",
	frameworkVersion: "1.2.3",
	capabilities: {
		argumentPredicates: true,
		actorConstraints: false,
		structuredEscalationPayload: true,
	},
	run: async () => [],
};

const leaked: Observation = {
	scenarioId: "s",
	class: "basics",
	adapter: "fake",
	attemptIndex: 0,
	toolId: "t",
	expected: "denied",
	observed: "executed",
	inexpressible: false,
};

const PAIRED_RATE = /^\d+% \/ \d+%$/;

/** Parse markdown table rows into trimmed cell arrays (excludes header and divider). */
function parseTableDataRows(markdown: string): string[][] {
	const rows = markdown
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.filter((line) => !line.includes("---"))
		.slice(1); // drop header
	return rows.map((row) =>
		row
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim()),
	);
}

/** Assert no table cell carries a lone rate — paired `X% / Y%` or em dash only. */
function assertNoSeparableRatesInRow(cells: string[]): void {
	for (let i = 2; i < cells.length; i++) {
		const cell = cells[i] ?? "";
		expect(cell === "—" || PAIRED_RATE.test(cell)).toBe(true);
	}
	for (const cell of cells) {
		if (/\d+%/.test(cell)) {
			expect(PAIRED_RATE.test(cell)).toBe(true);
		}
	}
}

it("records framework versions and per-class metrics", () => {
	const report = buildReport({ observations: [leaked], failures: [] }, [adapter], [scenario]);
	expect(report.adapters[0]?.frameworkVersion).toBe("1.2.3");
	expect(report.adapters[0]?.classes.basics?.unauthorizedExecutionRate).toBe(1);
});

it("renders unauthorized execution and over-block together in one cell", () => {
	const report = buildReport({ observations: [leaked], failures: [] }, [adapter], [scenario]);
	const markdown = renderMarkdown(report);
	const [row] = parseTableDataRows(markdown);
	expect(row).toBeDefined();
	assertNoSeparableRatesInRow(row ?? []);
});

it("renders em dash for a class an adapter never reported", () => {
	const basicsOnly: Observation = { ...leaked, adapter: "with-basics" };
	const argOnly: Observation = {
		...leaked,
		scenarioId: "arg",
		class: "argument-scoping",
		adapter: "with-args",
	};
	const adapters: Adapter[] = [
		{ ...adapter, name: "with-basics" },
		{ ...adapter, name: "with-args" },
	];
	const report = buildReport({ observations: [basicsOnly, argOnly], failures: [] }, adapters, [
		scenario,
		argumentScenario,
	]);
	const markdown = renderMarkdown(report);
	const rows = parseTableDataRows(markdown);
	const basicsRow = rows.find((r) => r[0] === "with-basics");
	const argsRow = rows.find((r) => r[0] === "with-args");
	// basics column is index 2, argument-scoping is index 3
	expect(basicsRow?.[2]).toMatch(PAIRED_RATE);
	expect(basicsRow?.[3]).toBe("—");
	expect(argsRow?.[2]).toBe("—");
	expect(argsRow?.[3]).toMatch(PAIRED_RATE);
});

it("renders a failures section naming adapter, scenario, and error", () => {
	const report = buildReport(
		{
			observations: [],
			failures: [
				{
					adapter: "fake",
					scenarioId: "s",
					error: "adapter exploded",
				},
			],
		},
		[adapter],
		[scenario],
	);
	const markdown = renderMarkdown(report);
	expect(markdown).toContain("### Adapter failures");
	expect(markdown).toContain("`fake` on `s`: adapter exploded");
});

it("carries adapter capabilities through to the adapter report", () => {
	const report = buildReport({ observations: [leaked], failures: [] }, [adapter], [scenario]);
	expect(report.adapters[0]?.capabilities).toEqual({
		argumentPredicates: true,
		actorConstraints: false,
		structuredEscalationPayload: true,
	});
});

it("keeps every observation for per-case reproduction", () => {
	const report = buildReport({ observations: [leaked], failures: [] }, [adapter], [scenario]);
	expect(report.observations).toHaveLength(1);
	expect(report.observations[0]?.scenarioId).toBe("s");
});
