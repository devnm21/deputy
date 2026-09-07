import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { allScenarios } from "../scenarios/index.js";
import { createMastraAdapter } from "./adapters/mastra/index.js";
import { createVercelAiAdapter } from "./adapters/vercel-ai/index.js";
import { buildReport, renderMarkdown } from "./core/report.js";
import { runSuite } from "./core/runner.js";
import type { Adapter } from "./core/types.js";

function readFlag(argv: string[], flag: string, fallback: string): string {
	const index = argv.indexOf(flag);
	if (index < 0) return fallback;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const outDir = readFlag(argv, "--out", "results");
	const adapters: Adapter[] = [createVercelAiAdapter(), createMastraAdapter()];

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
