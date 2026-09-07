import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
// Mastra 1.64 bundles the LanguageModelV2 provider generation, so the mock
// must come from the aliased ai@5 install rather than ai@7.
import { MockLanguageModelV2 } from "ai-v5/test";
import { z } from "zod";
import { attributeExecutions } from "../../core/attribute.js";
import { createLedger } from "../../core/ledger.js";
import { evaluatePolicy } from "../../core/policy.js";
import type { Adapter, Attempt, Observation, Scenario, ToolSpec } from "../../core/types.js";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function schemaFor(spec: ToolSpec) {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const field of spec.fields) {
		shape[field.name] = field.type === "number" ? z.number() : z.string();
	}
	return z.object(shape);
}

/** A stateful mock: Mastra calls the model once per step. */
function scriptedModel(attempts: Attempt[]) {
	let step = 0;
	return new MockLanguageModelV2({
		doGenerate: async () => {
			const attempt = attempts[step];
			step += 1;
			if (!attempt) {
				return {
					content: [{ type: "text" as const, text: "done" }],
					finishReason: "stop" as const,
					usage: USAGE,
					warnings: [],
				};
			}
			return {
				content: [
					{
						type: "tool-call" as const,
						toolCallId: `tc-${step}`,
						toolName: attempt.toolId,
						input: JSON.stringify(attempt.args),
					},
				],
				finishReason: "tool-calls" as const,
				usage: USAGE,
				warnings: [],
			};
		},
	});
}

export function createMastraAdapter(): Adapter {
	return {
		name: "mastra",
		frameworkVersion: "1.64.0",
		capabilities: {
			// requireApproval accepts an async predicate over the tool input.
			argumentPredicates: true,
			// requestContext carries an actor, but a parent's run-level policy is
			// not consulted for a sub-agent's inner tools. Delegation scenarios
			// record that directly rather than treating it as inexpressible.
			actorConstraints: true,
			// suspendPayload carries toolName and args.
			structuredEscalationPayload: true,
		},

		async run(scenario: Scenario): Promise<Observation[]> {
			const ledger = createLedger();
			const escalations = new Map<number, unknown>();

			const tools = Object.fromEntries(
				scenario.tools.map((spec) => [
					spec.id,
					createTool({
						id: spec.id,
						description: spec.description,
						inputSchema: schemaFor(spec),
						outputSchema: z.object({ ok: z.boolean() }),
						requireApproval: async (input: Record<string, unknown>) =>
							evaluatePolicy(scenario.policy, { toolId: spec.id, args: input }) !== "executed",
						execute: async (input: Record<string, unknown>) => {
							ledger.record({ toolId: spec.id, args: input });
							return { ok: true };
						},
					}),
				]),
			);

			const agent = new Agent({
				id: "deputy-subject",
				name: "deputy-subject",
				instructions: scenario.description,
				// biome-ignore lint/suspicious/noExplicitAny: provider generation variance
				model: scriptedModel(scenario.attempts) as any,
				tools,
			});

			// Without a Mastra instance and storage, the run suspends but persists
			// no snapshot, so approval cannot be resumed.
			new Mastra({
				agents: { "deputy-subject": agent },
				storage: new InMemoryStore(),
			});

			for (let index = 0; index < scenario.attempts.length; index += 1) {
				const output = await agent.generate(scenario.description);
				if (output.finishReason !== "suspended") continue;

				const payload = output.suspendPayload as
					| { toolCallId?: string; toolName?: string; args?: unknown }
					| undefined;
				if (!payload?.toolCallId || output.runId === undefined) {
					throw new Error(
						`Scenario "${scenario.id}": unusable suspension payload — ` +
							`toolCallId: ${payload?.toolCallId ?? "missing"}, ` +
							`runId: ${output.runId ?? "missing"}`,
					);
				}

				// Identify the suspended attempt from the payload rather than the
				// loop index. A single generate() may consume multiple scripted
				// model steps when a permitted tool executes and the agent
				// continues, so the loop index can desynchronize from the actual
				// suspended attempt.
				const suspendedIndex = scenario.attempts.findIndex(
					(a, i) =>
						a.toolId === payload.toolName &&
						JSON.stringify(a.args) === JSON.stringify(payload.args) &&
						!escalations.has(i),
				);

				const suspendedAttempt = scenario.attempts[suspendedIndex];
				if (suspendedIndex < 0 || !suspendedAttempt) continue;

				const decision = evaluatePolicy(scenario.policy, {
					toolId: suspendedAttempt.toolId,
					args: suspendedAttempt.args,
				});
				if (decision === "escalated") escalations.set(suspendedIndex, payload);

				await agent.declineToolCallGenerate({
					runId: output.runId,
					toolCallId: payload.toolCallId,
					reason: `deputy: policy says ${decision}`,
				});
			}

			const executed = attributeExecutions(scenario.attempts, ledger.entries());

			return scenario.attempts.map((attempt, index): Observation => {
				let observed: Observation["observed"];
				if (executed[index]) observed = "executed";
				else if (escalations.has(index)) observed = "escalated";
				else observed = "denied";

				return {
					scenarioId: scenario.id,
					class: scenario.class,
					adapter: "mastra",
					attemptIndex: index,
					toolId: attempt.toolId,
					expected: attempt.expect,
					observed,
					escalationPayload: escalations.get(index),
					inexpressible: false,
				};
			});
		},
	};
}
