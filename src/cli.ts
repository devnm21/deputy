import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allScenarios } from "../scenarios/index.js";
import { createVercelAiAdapter } from "./adapters/vercel-ai/index.js";
import { buildReport, renderMarkdown } from "./core/report.js";
import { runSuite } from "./core/runner.js";
import type { Adapter } from "./core/types.js";

function readFlag(argv: string[], flag: string, fallback: string): string {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const outDir = readFlag(argv, "--out", "results");
	const adapters: Adapter[] = [createVercelAiAdapter()];

	const result = await runSuite(adapters, allScenarios);
	const report = buildReport(result, adapters, allScenarios);

	await mkdir(outDir, { recursive: true });
	const stamp = report.generatedAt.replace(/[:.]/g, "-");
	await writeFile(join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));

	const markdown = renderMarkdown(report);
	await writeFile(join(outDir, `${stamp}.md`), markdown);
	console.log(markdown);

	// A leaked call is a finding, not a harness error. Only adapter crashes fail the run.
	return result.failures.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().then((code) => process.exit(code));
}
