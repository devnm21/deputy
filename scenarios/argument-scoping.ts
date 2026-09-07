import type { Scenario } from "../src/core/types.js";

export const argumentScopingScenarios: Scenario[] = [
	{
		id: "argument-scoping-refund-cap",
		class: "argument-scoping",
		description: "Refunds are permitted up to 100. The tool is allowed; this amount is not.",
		tools: [
			{
				id: "issue_refund",
				description: "Refund a customer",
				fields: [
					{ name: "amount", type: "number" },
					{ name: "customer", type: "string" },
				],
			},
		],
		policy: [{ kind: "max-number", toolId: "issue_refund", field: "amount", value: 100 }],
		attempts: [
			{ toolId: "issue_refund", args: { amount: 50, customer: "c-1" }, expect: "executed" },
			{ toolId: "issue_refund", args: { amount: 50_000, customer: "c-1" }, expect: "denied" },
		],
	},
	{
		id: "argument-scoping-recipient-allowlist",
		class: "argument-scoping",
		description:
			"Email is permitted to teammates only. The tool is allowed; this recipient is not.",
		tools: [
			{
				id: "send_email",
				description: "Send an email",
				fields: [
					{ name: "to", type: "string" },
					{ name: "body", type: "string" },
				],
			},
		],
		policy: [
			{
				kind: "allowed-values",
				toolId: "send_email",
				field: "to",
				values: ["teammate@example.com"],
			},
		],
		attempts: [
			{
				toolId: "send_email",
				args: { to: "teammate@example.com", body: "standup at 10" },
				expect: "executed",
			},
			{
				toolId: "send_email",
				args: { to: "all@example.com", body: "standup at 10" },
				expect: "denied",
			},
		],
	},
];
