import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { allScenarios } from "../scenarios/index.js";
import { createClaudeAgentSdkAdapter } from "./adapters/claude-agent-sdk/index.js";
import { createMastraAdapter } from "./adapters/mastra/index.js";
import { createVercelAiAdapter } from "./adapters/vercel-ai/index.js";
import { buildReport, renderMarkdown } from "./core/report.js";
import { runSuite } from "./core/runner.js";
import type { Adapter, Scenario } from "./core/types.js";

export const DEFAULT_OUT_DIR = "results";

export const ADAPTER_IDS = ["vercel-ai", "mastra", "claude-agent-sdk"] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

export function createAdapters(): Adapter[] {
	return [createVercelAiAdapter(), createMastraAdapter(), createClaudeAgentSdkAdapter()];
}

function readFlag(argv: string[], flag: string, fallback: string): string {
	const index = argv.indexOf(flag);
	if (index < 0) return fallback;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

/** Collects values for a flag that may appear multiple times and/or use commas. */
export function readMultiFlag(argv: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] !== flag) continue;
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("-")) {
			throw new Error(`${flag} requires a value`);
		}
		values.push(
			...value
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean),
		);
		index += 1;
	}
	return values;
}

export function resolveAdapters(ids: string[], adapters: Adapter[]): Adapter[] {
	if (ids.length === 0) return adapters;

	const byName = new Map(adapters.map((adapter) => [adapter.name, adapter]));
	const unknown = ids.filter((id) => !byName.has(id));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown adapter id(s): ${unknown.join(", ")}. Valid adapter ids: ${ADAPTER_IDS.join(", ")}`,
		);
	}

	return ids.map((id) => byName.get(id) as Adapter);
}

export function resolveScenarios(ids: string[], scenarios: Scenario[]): Scenario[] {
	if (ids.length === 0) return scenarios;

	const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
	const unknown = ids.filter((id) => !byId.has(id));
	if (unknown.length > 0) {
		const valid = scenarios.map((scenario) => scenario.id).sort();
		throw new Error(
			`Unknown scenario id(s): ${unknown.join(", ")}. Valid scenario ids: ${valid.join(", ")}`,
		);
	}

	return ids.map((id) => byId.get(id) as Scenario);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const outDir = readFlag(argv, "--out", DEFAULT_OUT_DIR);
	const adapterFilter = readMultiFlag(argv, "--adapter");
	const scenarioFilter = readMultiFlag(argv, "--scenario");
	const filtered = adapterFilter.length > 0 || scenarioFilter.length > 0;

	if (filtered && outDir === DEFAULT_OUT_DIR) {
		throw new Error(
			"Filtered runs must not overwrite results/latest.*; pass --out <dir> to write partial results elsewhere",
		);
	}

	const allAdapters = createAdapters();
	const adapters = resolveAdapters(adapterFilter, allAdapters);
	const scenarios = resolveScenarios(scenarioFilter, allScenarios);

	const result = await runSuite(adapters, scenarios);
	const report = buildReport(result, adapters, scenarios);

	await mkdir(outDir, { recursive: true });
	const stamp = report.generatedAt.replace(/[:.]/g, "-");
	await writeFile(join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));

	const markdown = renderMarkdown(report);
	await writeFile(join(outDir, `${stamp}.md`), markdown);

	if (!filtered) {
		await writeFile(join(outDir, "latest.json"), JSON.stringify(report, null, 2));
		await writeFile(join(outDir, "latest.md"), markdown);
	}

	console.log(markdown);

	// A leaked call is a finding, not a harness error. Only adapter crashes fail the run.
	return result.failures.length > 0 ? 1 : 0;
}

// Compared as resolved file URLs. Interpolating process.argv[1] into a
// file:// string assumes an absolute POSIX path with no URL escaping, so on
// Windows or with a relative argv[1] the guard silently never matches and the
// command becomes a no-op.
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
	main()
		.then((code) => process.exit(code))
		.catch((error: unknown) => {
			// Without this the process dies of an unhandled rejection when the
			// output directory cannot be written, giving no usable exit code.
			console.error(error);
			process.exit(1);
		});
}
