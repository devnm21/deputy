import { type AttemptIndex, computeMetrics, type Metrics } from "./metrics.js";
import type { SuiteResult } from "./runner.js";
import type { Adapter, Capabilities, FailureClass, Observation, Scenario } from "./types.js";

export type AdapterReport = {
	name: string;
	frameworkVersion: string;
	capabilities: Capabilities;
	overall: Metrics;
	classes: Partial<Record<FailureClass, Metrics>>;
};

export type Report = {
	generatedAt: string;
	adapters: AdapterReport[];
	failures: SuiteResult["failures"];
	/** Every observation, so a reader can re-run a single disputed case. */
	observations: Observation[];
};

const CLASSES: FailureClass[] = [
	"basics",
	"argument-scoping",
	"delegation",
	"escalation",
	"parallel-siblings",
];

const percent = (value: number): string => `${Math.round(value * 100)}%`;

export function buildReport(
	result: SuiteResult,
	adapters: Adapter[],
	scenarios: Scenario[],
): Report {
	const attempts: AttemptIndex = new Map(scenarios.map((s) => [s.id, s.attempts]));

	return {
		generatedAt: new Date().toISOString(),
		adapters: adapters.map((adapter) => {
			const mine = result.observations.filter((o) => o.adapter === adapter.name);
			const classes: Partial<Record<FailureClass, Metrics>> = {};
			for (const failureClass of CLASSES) {
				const subset = mine.filter((o) => o.class === failureClass);
				if (subset.length > 0) classes[failureClass] = computeMetrics(subset, attempts);
			}
			return {
				name: adapter.name,
				frameworkVersion: adapter.frameworkVersion,
				capabilities: adapter.capabilities,
				overall: computeMetrics(mine, attempts),
				classes,
			};
		}),
		failures: result.failures,
		observations: result.observations,
	};
}

/**
 * Renders unauthorized-execution and over-block rates in a single cell.
 * They are never separable in the output, because either number alone is
 * misleading: a gate that denies everything scores perfectly on the first.
 */
export function renderMarkdown(report: Report): string {
	const present = CLASSES.filter((c) => report.adapters.some((a) => a.classes[c] !== undefined));

	const header = ["Framework", "Version", ...present.map((c) => c)].join(" | ");
	const divider = ["---", "---", ...present.map(() => "---")].join(" | ");

	const rows = report.adapters.map((adapter) => {
		const cells = present.map((failureClass) => {
			const metrics = adapter.classes[failureClass];
			if (!metrics) return "—";
			return `${percent(metrics.unauthorizedExecutionRate)} / ${percent(metrics.overBlockRate)}`;
		});
		return [adapter.name, adapter.frameworkVersion, ...cells].join(" | ");
	});

	const lines = [
		"Each cell is **unauthorized execution rate / over-block rate**. Lower is better on both.",
		"",
		`| ${header} |`,
		`| ${divider} |`,
		...rows.map((row) => `| ${row} |`),
	];

	if (report.failures.length > 0) {
		lines.push("", "### Adapter failures", "");
		for (const failure of report.failures) {
			lines.push(`- \`${failure.adapter}\` on \`${failure.scenarioId}\`: ${failure.error}`);
		}
	}

	return lines.join("\n");
}
