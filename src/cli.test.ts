import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SuiteResult } from "./core/runner.js";
import type { Observation } from "./core/types.js";

const { mockRunSuite } = vi.hoisted(() => ({
	mockRunSuite: vi.fn<() => Promise<SuiteResult>>(),
}));

vi.mock("./core/runner.js", () => ({
	runSuite: mockRunSuite,
}));

import { main } from "./cli.js";

const sampleObservation: Observation = {
	scenarioId: "basics-forbidden-tool",
	class: "basics",
	adapter: "vercel-ai",
	attemptIndex: 0,
	toolId: "wipe_database",
	expected: "denied",
	observed: "executed",
	inexpressible: false,
};

const cleanResult: SuiteResult = {
	observations: [sampleObservation],
	failures: [],
};

const crashedResult: SuiteResult = {
	observations: [],
	failures: [
		{
			adapter: "vercel-ai",
			scenarioId: "basics-forbidden-tool",
			error: "adapter crashed",
		},
	],
};

beforeEach(() => {
	mockRunSuite.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

it("exits zero when no adapter crashed", async () => {
	mockRunSuite.mockResolvedValue(cleanResult);
	const out = await mkdtemp(join(tmpdir(), "deputy-"));
	try {
		const code = await main(["--out", out]);
		expect(code).toBe(0);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});

it("exits one when an adapter crashed", async () => {
	mockRunSuite.mockResolvedValue(crashedResult);
	const out = await mkdtemp(join(tmpdir(), "deputy-"));
	try {
		const code = await main(["--out", out]);
		expect(code).toBe(1);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});

it("writes a json report and exits zero", async () => {
	mockRunSuite.mockImplementation(async () => cleanResult);
	const out = await mkdtemp(join(tmpdir(), "deputy-"));
	try {
		const code = await main(["--out", out]);
		expect(code).toBe(0);

		const files = await readdir(out);
		expect(files.some((f) => f.endsWith(".json"))).toBe(true);

		const jsonFile = files.find((f) => f.endsWith(".json"));
		const parsed = JSON.parse(await readFile(join(out, jsonFile as string), "utf8"));
		expect(parsed.adapters.length).toBeGreaterThan(0);
		expect(parsed.observations.length).toBeGreaterThan(0);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});

it("rejects --out with a missing value", async () => {
	await expect(main(["--out"])).rejects.toThrow("--out requires a value");
	expect(mockRunSuite).not.toHaveBeenCalled();
});
