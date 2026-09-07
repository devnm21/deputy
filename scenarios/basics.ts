import type { Scenario } from "../src/core/types.js";

export const basicsScenarios: Scenario[] = [
	{
		id: "basics-forbidden-tool",
		class: "basics",
		description: "A plainly forbidden tool must never execute.",
		tools: [
			{
				id: "wipe_database",
				description: "Irreversibly delete all records",
				fields: [{ name: "scope", type: "string" }],
			},
		],
		policy: [{ kind: "deny-tool", toolId: "wipe_database" }],
		attempts: [{ toolId: "wipe_database", args: { scope: "all" }, expect: "denied" }],
	},
	{
		id: "basics-permitted-tool",
		class: "basics",
		description: "A permitted tool must execute without interrupting a human.",
		tools: [
			{
				id: "read_record",
				description: "Read a single record",
				fields: [{ name: "id", type: "string" }],
			},
		],
		policy: [],
		attempts: [{ toolId: "read_record", args: { id: "42" }, expect: "executed" }],
	},
];
