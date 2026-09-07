import {
	type AttemptIndex,
	computeMetrics,
	type Metrics,
	type RateDenominator,
	type ScenarioIndex,
	type ScenarioMetrics,
} from "./metrics.js";
import type { SuiteResult } from "./runner.js";
import type { Adapter, Capabilities, FailureClass, Observation, Scenario } from "./types.js";

export type ClassMetrics = Metrics & {
	scenarios: ScenarioMetrics[];
};

export type AdapterReport = {
	name: string;
	frameworkVersion: string;
	capabilities: Capabilities;
	overall: Metrics;
	classes: Partial<Record<FailureClass, ClassMetrics>>;
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
	"policy-attachment",
];

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function formatRate(metrics: Metrics): string {
	const uer = metrics.denominators.unauthorizedExecution;
	const over = metrics.denominators.overBlock;
	const uerPart =
		uer.denominator > 0
			? `${percent(metrics.unauthorizedExecutionRate)} (${uer.numerator}/${uer.denominator})`
			: `${percent(metrics.unauthorizedExecutionRate)}`;
	const overPart =
		over.denominator > 0
			? `${percent(metrics.overBlockRate)} (${over.numerator}/${over.denominator})`
			: `${percent(metrics.overBlockRate)}`;
	return `${uerPart} / ${overPart}`;
}

/** Policy-attachment is not applicable when the framework has only one scoreable surface. */
function classApplicable(
	adapter: Adapter,
	failureClass: FailureClass,
	subset: Observation[],
): boolean {
	if (subset.length === 0) return false;
	if (failureClass === "policy-attachment" && !adapter.capabilities.distinctCallerPolicySurface) {
		return false;
	}
	return true;
}

function orderingViolationRate(
	scenarioId: string,
	observations: Observation[],
	attempts: AttemptIndex,
): RateDenominator | undefined {
	const scenarioAttempts = attempts.get(scenarioId);
	if (!scenarioAttempts?.some((a) => a.mustWaitForGate !== undefined)) return undefined;
	const waitCount = scenarioAttempts.filter((a) => a.mustWaitForGate !== undefined).length;
	const subset = observations.filter((o) => o.scenarioId === scenarioId);
	const premature = subset.filter((o) => o.prematureExecution).length;
	return {
		numerator: premature,
		denominator: waitCount,
		label: `${waitCount} must-wait-for-gate attempt${waitCount === 1 ? "" : "s"}`,
	};
}

function buildClassMetrics(
	subset: Observation[],
	attempts: AttemptIndex,
	scenarioIndex: ScenarioIndex,
): ClassMetrics {
	const scenarioIds = [...new Set(subset.map((o) => o.scenarioId))].sort();
	const scenarios: ScenarioMetrics[] = scenarioIds.map((scenarioId) => ({
		scenarioId,
		metrics: computeMetrics(
			subset.filter((o) => o.scenarioId === scenarioId),
			attempts,
			scenarioIndex,
		),
		orderingViolation: orderingViolationRate(scenarioId, subset, attempts),
	}));

	return {
		...computeMetrics(subset, attempts, scenarioIndex),
		scenarios,
	};
}

export function buildReport(
	result: SuiteResult,
	adapters: Adapter[],
	scenarios: Scenario[],
): Report {
	const attempts: AttemptIndex = new Map(scenarios.map((s) => [s.id, s.attempts]));
	const scenarioIndex: ScenarioIndex = new Map(scenarios.map((s) => [s.id, s]));

	return {
		generatedAt: new Date().toISOString(),
		adapters: adapters.map((adapter) => {
			const mine = result.observations.filter((o) => o.adapter === adapter.name);
			const classes: Partial<Record<FailureClass, ClassMetrics>> = {};
			for (const failureClass of CLASSES) {
				const subset = mine.filter((o) => o.class === failureClass);
				if (subset.length === 0) continue;
				const classMetrics = buildClassMetrics(subset, attempts, scenarioIndex);
				classes[failureClass] = {
					...classMetrics,
					applicable: classApplicable(adapter, failureClass, subset),
				};
			}
			return {
				name: adapter.name,
				frameworkVersion: adapter.frameworkVersion,
				capabilities: adapter.capabilities,
				overall: computeMetrics(mine, attempts, scenarioIndex),
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
			if (!metrics.applicable) return "—";
			return formatRate(metrics);
		});
		return [adapter.name, adapter.frameworkVersion, ...cells].join(" | ");
	});

	const lines = [
		"Each cell is **unauthorized execution rate / over-block rate**. Lower is better on both.",
		"Rates show `(numerator/denominator)`; denominators count should-block attempts plus premature-execution flags for UER, and should-execute attempts for over-block.",
		"`—` means the class was not measured on this row (e.g. policy-attachment when the framework offers only one scoreable surface).",
		"",
		`| ${header} |`,
		`| ${divider} |`,
		...rows.map((row) => `| ${row} |`),
	];

	const detailClasses = present.filter(
		(failureClass) => failureClass === "parallel-siblings" || failureClass === "policy-attachment",
	);

	if (detailClasses.length > 0) {
		lines.push("", "### Per-scenario rates", "");
		for (const failureClass of detailClasses) {
			lines.push(`#### ${failureClass}`, "");
			lines.push("| Framework | Scenario | UER | Over-block | Denominator |");
			lines.push("| --- | --- | --- | --- | --- |");
			for (const adapter of report.adapters) {
				const classMetrics = adapter.classes[failureClass];
				if (!classMetrics?.applicable) {
					lines.push(`| ${adapter.name} | — | — | — | not applicable (single surface) |`);
					continue;
				}
				for (const scenario of classMetrics.scenarios) {
					const uer = scenario.metrics.denominators.unauthorizedExecution;
					const over = scenario.metrics.denominators.overBlock;
					const ordering = scenario.orderingViolation;
					const uerCell =
						ordering !== undefined
							? `${percent(scenario.metrics.unauthorizedExecutionRate)} (${uer.numerator}/${uer.denominator}); ordering ${percent(ordering.numerator / ordering.denominator)} (${ordering.numerator}/${ordering.denominator})`
							: `${percent(scenario.metrics.unauthorizedExecutionRate)} (${uer.numerator}/${uer.denominator})`;
					lines.push(
						`| ${adapter.name} | ${scenario.scenarioId} | ${uerCell} | ${percent(scenario.metrics.overBlockRate)} (${over.numerator}/${over.denominator}) | ${uer.label} |`,
					);
				}
			}
			lines.push("");
		}
	}

	const informativenessRows = report.adapters.flatMap((adapter) => {
		const escalation = adapter.classes.escalation;
		if (!escalation?.applicable && escalation === undefined) return [];
		return [
			`| ${adapter.name} | ${escalation ? percent(escalation.escalationInformativeness) : "—"} | Claude-only prompt-text term; equal weight among applicable terms per adapter |`,
		];
	});
	if (informativenessRows.length > 0) {
		lines.push(
			"### Escalation informativeness",
			"",
			"Not in the headline table. Scores are comparable on labeled arguments, tool legibility, and distinguishability; the prompt-text term applies only where the SDK documents pre-rendered fields (Claude).",
			"",
			"| Framework | Score | Scope |",
			"| --- | --- | --- |",
			...informativenessRows,
		);
	}

	if (report.failures.length > 0) {
		lines.push("", "### Adapter failures", "");
		for (const failure of report.failures) {
			lines.push(`- \`${failure.adapter}\` on \`${failure.scenarioId}\`: ${failure.error}`);
		}
	}

	return lines.join("\n");
}
