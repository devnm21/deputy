import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4, mockId } from "ai/test";
import { z } from "zod";
import { createLedger } from "../../core/ledger.js";
import { evaluatePolicy } from "../../core/policy.js";
import type { Adapter, Attempt, Observation, Scenario, ToolSpec } from "../../core/types.js";

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

function toolCallStep(calls: Array<{ id: string; attempt: Attempt }>) {
	return {
		content: calls.map(({ id, attempt }) => ({
			type: "tool-call" as const,
			toolCallId: id,
			toolName: attempt.toolId,
			input: JSON.stringify(attempt.args),
		})),
		finishReason: { unified: "tool-calls" as const, raw: undefined },
		usage: USAGE,
		warnings: [],
	};
}

function textStep(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		finishReason: { unified: "stop" as const, raw: undefined },
		usage: USAGE,
		warnings: [],
	};
}

function schemaFor(spec: ToolSpec) {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const field of spec.fields) {
		shape[field.name] = field.type === "number" ? z.number() : z.string();
	}
	return z.object(shape);
}

/** Group attempts into steps. Attempts sharing a step index are emitted together. */
function groupIntoSteps(attempts: Attempt[]): Array<Array<{ index: number; attempt: Attempt }>> {
	const groups = new Map<number, Array<{ index: number; attempt: Attempt }>>();
	attempts.forEach((attempt, index) => {
		const key = attempt.step ?? -1 - index;
		const group = groups.get(key) ?? [];
		group.push({ index, attempt });
		groups.set(key, group);
	});
	return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
}

export function createVercelAiAdapter(): Adapter {
	return {
		name: "vercel-ai",
		frameworkVersion: "7.0.93",
		capabilities: {
			// needsApproval and toolApproval both receive parsed arguments.
			argumentPredicates: true,
			// No first-class notion of which agent issued a call.
			actorConstraints: false,
			// The approval request carries the full parsed tool call.
			structuredEscalationPayload: true,
		},

		async run(scenario: Scenario): Promise<Observation[]> {
			const ledger = createLedger();
			const steps = groupIntoSteps(scenario.attempts);

			const tools = Object.fromEntries(
				scenario.tools.map((spec) => [
					spec.id,
					tool({
						description: spec.description,
						inputSchema: schemaFor(spec),
						execute: async (args: Record<string, unknown>) => {
							ledger.record({ toolId: spec.id, args });
							return { ok: true };
						},
					}),
				]),
			);

			const script = [
				...steps.map((group, stepIndex) =>
					toolCallStep(
						group.map(({ index, attempt }) => ({ id: `call-${stepIndex}-${index}`, attempt })),
					),
				),
				textStep("done"),
			];

			const escalations = new Map<number, unknown>();

			// Translate policy into a per-call approval decision. The framework
			// consults this; we record what it asked about.
			const result = await generateText({
				model: new MockLanguageModelV4({ doGenerate: script }),
				tools,
				toolApproval: async ({ toolCall }) => {
					const decision = evaluatePolicy(scenario.policy, {
						toolId: toolCall.toolName,
						args: toolCall.input as Record<string, unknown>,
					});
					if (decision === "denied") return "denied";
					if (decision === "escalated") return "user-approval";
					return "not-applicable";
				},
				stopWhen: stepCountIs(steps.length + 2),
				prompt: scenario.description,
				_internal: { generateId: mockId({ prefix: "approval" }) },
			});

			for (const part of result.content) {
				if (part.type === "tool-approval-request" && part.isAutomatic !== true) {
					const index = scenario.attempts.findIndex(
						(attempt, i) =>
							attempt.toolId === part.toolCall.toolName &&
							JSON.stringify(attempt.args) === JSON.stringify(part.toolCall.input) &&
							!escalations.has(i),
					);
					if (index >= 0) escalations.set(index, part);
				}
			}

			return scenario.attempts.map((attempt, index): Observation => {
				let observed: Observation["observed"];
				if (ledger.ran(attempt.toolId)) observed = "executed";
				else if (escalations.has(index)) observed = "escalated";
				else observed = "denied";

				return {
					scenarioId: scenario.id,
					class: scenario.class,
					adapter: "vercel-ai",
					attemptIndex: index,
					toolId: attempt.toolId,
					expected: attempt.expect,
					observed,
					escalationPayload: escalations.get(index),
					// This adapter has no actor concept, so actor rules are inexpressible.
					inexpressible:
						attempt.actor !== undefined ||
						scenario.policy.some((rule) => rule.kind === "actor-deny"),
				};
			});
		},
	};
}
