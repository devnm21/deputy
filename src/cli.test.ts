import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allScenarios } from "../scenarios/index.js";
import type { SuiteResult } from "./core/runner.js";
import type { Adapter, Observation, Scenario } from "./core/types.js";

const { mockRunSuite } = vi.hoisted(() => ({
	mockRunSuite: vi.fn<() => Promise<SuiteResult>>(),
}));

vi.mock("./core/runner.js", () => ({
	runSuite: mockRunSuite,
}));

import {
	ADAPTER_IDS,
	createAdapters,
	main,
	readMultiFlag,
	resolveAdapters,
	resolveScenarios,
} from "./cli.js";

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

function firstRunSuiteCall(): [Adapter[], Scenario[]] {
	const call = mockRunSuite.mock.calls[0];
	if (!call) throw new Error("runSuite was not called");
	return call as unknown as [Adapter[], Scenario[]];
}

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

describe("readMultiFlag", () => {
	it("parses comma-separated and repeated values", () => {
		expect(
			readMultiFlag(
				["--adapter", "mastra,vercel-ai", "--adapter", "claude-agent-sdk"],
				"--adapter",
			),
		).toEqual(["mastra", "vercel-ai", "claude-agent-sdk"]);
	});
});

describe("resolveAdapters", () => {
	it("returns all adapters when no filter is given", () => {
		const adapters = createAdapters();
		expect(resolveAdapters([], adapters)).toHaveLength(3);
	});

	it("throws for unknown adapter ids with valid ids listed", () => {
		const adapters = createAdapters();
		expect(() => resolveAdapters(["not-real"], adapters)).toThrow(/Unknown adapter id/);
		expect(() => resolveAdapters(["not-real"], adapters)).toThrow(ADAPTER_IDS.join(", "));
	});
});

describe("resolveScenarios", () => {
	it("throws for unknown scenario ids with valid ids listed", () => {
		expect(() => resolveScenarios(["not-real"], allScenarios)).toThrow(/Unknown scenario id/);
		expect(() => resolveScenarios(["not-real"], allScenarios)).toThrow("basics-forbidden-tool");
	});
});

describe("filtering", () => {
	it("passes adapter filter to runSuite", async () => {
		mockRunSuite.mockResolvedValue(cleanResult);
		const out = await mkdtemp(join(tmpdir(), "deputy-"));
		try {
			await main(["--adapter", "mastra", "--out", out]);
			expect(mockRunSuite).toHaveBeenCalledTimes(1);
			const [adapters, scenarios] = firstRunSuiteCall();
			expect(adapters).toHaveLength(1);
			expect(adapters?.[0]?.name).toBe("mastra");
			expect(scenarios).toHaveLength(allScenarios.length);
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	});

	it("passes scenario filter to runSuite", async () => {
		mockRunSuite.mockResolvedValue(cleanResult);
		const out = await mkdtemp(join(tmpdir(), "deputy-"));
		try {
			await main(["--scenario", "basics-forbidden-tool", "--out", out]);
			expect(mockRunSuite).toHaveBeenCalledTimes(1);
			const [, scenarios] = firstRunSuiteCall();
			expect(scenarios).toHaveLength(1);
			expect(scenarios?.[0]?.id).toBe("basics-forbidden-tool");
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	});

	it("passes both filters to runSuite", async () => {
		mockRunSuite.mockResolvedValue(cleanResult);
		const out = await mkdtemp(join(tmpdir(), "deputy-"));
		try {
			await main([
				"--adapter",
				"mastra",
				"--scenario",
				"policy-attachment-caller-surface-delegation",
				"--out",
				out,
			]);
			expect(mockRunSuite).toHaveBeenCalledTimes(1);
			const [adapters, scenarios] = firstRunSuiteCall();
			expect(adapters).toHaveLength(1);
			expect(adapters?.[0]?.name).toBe("mastra");
			expect(scenarios).toHaveLength(1);
			expect(scenarios?.[0]?.id).toBe("policy-attachment-caller-surface-delegation");
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	});

	it("rejects unknown adapter id before running", async () => {
		const out = await mkdtemp(join(tmpdir(), "deputy-"));
		try {
			await expect(main(["--adapter", "fake", "--out", out])).rejects.toThrow(/Unknown adapter id/);
			expect(mockRunSuite).not.toHaveBeenCalled();
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	});

	it("rejects unknown scenario id before running", async () => {
		const out = await mkdtemp(join(tmpdir(), "deputy-"));
		try {
			await expect(main(["--scenario", "fake", "--out", out])).rejects.toThrow(
				/Unknown scenario id/,
			);
			expect(mockRunSuite).not.toHaveBeenCalled();
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite results/latest.* on a filtered run", async () => {
		await expect(
			main(["--adapter", "mastra", "--scenario", "policy-attachment-caller-surface-delegation"]),
		).rejects.toThrow(/must not overwrite results\/latest/);
		expect(mockRunSuite).not.toHaveBeenCalled();
	});

	it("does not write latest.* on a filtered run", async () => {
		mockRunSuite.mockResolvedValue(cleanResult);
		const out = await mkdtemp(join(tmpdir(), "deputy-"));
		try {
			await main(["--adapter", "mastra", "--scenario", "basics-forbidden-tool", "--out", out]);
			await expect(stat(join(out, "latest.json"))).rejects.toThrow();
			await expect(stat(join(out, "latest.md"))).rejects.toThrow();
			const files = await readdir(out);
			expect(files.some((f) => f.endsWith(".json"))).toBe(true);
			expect(files.some((f) => f.endsWith(".md"))).toBe(true);
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	});
});
