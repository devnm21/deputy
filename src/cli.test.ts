import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { main } from "./cli.js";

it("writes a json report and exits zero", async () => {
	const out = await mkdtemp(join(tmpdir(), "deputy-"));
	const code = await main(["--out", out]);
	expect(code).toBe(0);

	const files = await readdir(out);
	expect(files.some((f) => f.endsWith(".json"))).toBe(true);

	const jsonFile = files.find((f) => f.endsWith(".json"));
	const parsed = JSON.parse(await readFile(join(out, jsonFile as string), "utf8"));
	expect(parsed.adapters.length).toBeGreaterThan(0);
	expect(parsed.observations.length).toBeGreaterThan(0);
});
