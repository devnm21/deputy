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
import { groupIntoSteps, type StepEntry, siblingIndex } from "../../core/steps.js";
import type { Adapter, Observation, Scenario, ToolSpec } from "../../core/types.js";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * The fields this adapter reads off a run. On a nested suspension the outer
 * entry reports `requiresApproval: false` while the real request lives in
 * `suspendPayload`, so the payload is the only reliable identifier.
 */
type SuspendPayload = {
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	/** Present when the held call came from a sub-agent. */
	suspendPayload?: { toolCallId?: string; toolName?: string; args?: unknown };
};

type MastraOutput = {
	finishReason?: string;
	runId?: string;
	suspendPayload?: SuspendPayload;
};

function schemaFor(spec: ToolSpec) {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const field of spec.fields) {
		shape[field.name] = field.type === "number" ? z.number() : z.string();
	}
	return z.object(shape);
}

/** Sub-agents this scenario needs, in declaration order. */
function subAgentOwners(scenario: Scenario): string[] {
	return [...new Set(scenario.tools.flatMap((spec) => (spec.owner ? [spec.owner] : [])))];
}

/** The agent key the root subject is registered under. */
const ROOT_AGENT = "deputy-subject";

/**
 * The agent Mastra says is running the tool, read from the execution context it
 * hands the tool body rather than from the scenario. Normalized to undefined for
 * the root agent, since an Attempt with no actor means the root agent.
 */
function executingAgent(options: unknown): string | undefined {
	const agent = (options as { agent?: { agentId?: unknown } } | undefined)?.agent;
	if (typeof agent?.agentId !== "string" || agent.agentId === ROOT_AGENT) return undefined;
	return agent.agentId;
}

/**
 * A stateful mock: Mastra calls the model once per turn. The first turn carries
 * every call in the step — a step with two attempts produces two `tool-call`
 * parts in one response, which is what makes them siblings rather than
 * consecutive turns. Later turns return text so the agent finishes instead of
 * looping to its step ceiling.
 *
 * `delegateTo` makes the first turn call the auto-generated `agent-<key>`
 * delegation tool for each named sub-agent, which is how a delegated call
 * reaches the sub-agent that owns the tool.
 */
function scriptedModel(group: StepEntry[], delegateTo?: string[]) {
	let turn = 0;
	const calls = [
		...(delegateTo ?? []).map((owner, i) => ({
			type: "tool-call" as const,
			toolCallId: `tc-delegate-${i}`,
			toolName: `agent-${owner}`,
			input: JSON.stringify({ prompt: "carry out the delegated task" }),
		})),
		...group.map(({ index, attempt }) => ({
			type: "tool-call" as const,
			toolCallId: `tc-${index}`,
			toolName: attempt.toolId,
			input: JSON.stringify(attempt.args),
		})),
	];

	return new MockLanguageModelV2({
		doGenerate: async () => {
			const current = turn;
			turn += 1;
			if (current > 0 || calls.length === 0) {
				return {
					content: [{ type: "text" as const, text: "done" }],
					finishReason: "stop" as const,
					usage: USAGE,
					warnings: [],
				};
			}
			return {
				content: calls,
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
			const steps = groupIntoSteps(scenario.attempts);
			const siblings = siblingIndex(steps);

			// A tool is registered on the agent that owns it, and its approval gate
			// is evaluated with that agent as the actor.
			//
			// This is the only place in Mastra where a caller-scoped rule can be
			// written. Neither approval surface reports who is calling: a tool's
			// own `requireApproval` receives `{ requestContext, workspace }` and the
			// run-level `requireToolApproval` receives `{ toolName, args,
			// requestContext }`. Per-agent registration is the framework's own way
			// to say "this agent has this tool, under these terms", and the gate is
			// still Mastra's — the adapter never declines on the framework's behalf.
			const toolsFor = (owner: string | undefined) =>
				Object.fromEntries(
					scenario.tools
						.filter((spec) => spec.owner === owner)
						.map((spec) => [
							spec.id,
							createTool({
								id: spec.id,
								description: spec.description,
								inputSchema: schemaFor(spec),
								outputSchema: z.object({ ok: z.boolean() }),
								requireApproval: async (input: Record<string, unknown>) =>
									evaluatePolicy(scenario.policy, {
										toolId: spec.id,
										args: input,
										actor: owner,
									}) !== "executed",
								execute: async (input: Record<string, unknown>, options?: unknown) => {
									// The actor comes from Mastra's own execution context
									// (`options.agent.agentId`), not from the scenario, so an
									// execution is attributed to whoever the framework says
									// ran it.
									ledger.record({
										toolId: spec.id,
										args: input,
										actor: executingAgent(options),
									});
									return { ok: true };
								},
							}),
						]),
				);

			const owners = subAgentOwners(scenario);

			// One run per step, sharing the ledger.
			//
			// A suspended run stops consuming the script, so driving every step
			// through a single agent leaves each attempt after an escalation
			// unemitted — and an unemitted attempt has no evidence either way,
			// which falls through to "denied" and reads as a pass on the headline
			// rates while measuring nothing. Each step therefore gets its own run.
			for (const group of steps) {
				const delegated = group.filter(({ attempt }) => attempt.actor !== undefined);
				const direct = group.filter(({ attempt }) => attempt.actor === undefined);

				// A sub-agent per owner, holding that owner's tools and scripted with
				// the calls attributed to it. Mastra exposes a delegation tool to the
				// parent as `agent-<key>`, not `<key>`.
				const subAgents = Object.fromEntries(
					owners.map((owner) => [
						owner,
						new Agent({
							id: owner,
							name: owner,
							instructions: `You are the ${owner}. Carry out the task you are given.`,
							model: scriptedModel(
								delegated.filter(({ attempt }) => attempt.actor === owner),
								// biome-ignore lint/suspicious/noExplicitAny: provider generation variance
							) as any,
							tools: toolsFor(owner),
						}),
					]),
				);

				const agent = new Agent({
					id: ROOT_AGENT,
					name: ROOT_AGENT,
					instructions: scenario.description,
					// biome-ignore lint/suspicious/noExplicitAny: provider generation variance
					model: scriptedModel(direct, owners.length > 0 ? owners : undefined) as any,
					tools: toolsFor(undefined),
					agents: subAgents,
				});

				// Without a Mastra instance and storage, the run suspends but persists
				// no snapshot, so approval cannot be resumed.
				new Mastra({
					agents: { [ROOT_AGENT]: agent, ...subAgents },
					storage: new InMemoryStore(),
				});

				// A step may hold more than one gated call, and each decline resumes
				// the run only as far as the next suspension, so this drains them.
				let output = (await agent.generate(scenario.description)) as MastraOutput;
				for (let guard = 0; guard <= group.length; guard += 1) {
					if (output.finishReason !== "suspended") break;

					// A delegated suspension nests: the outer entry names the
					// `agent-<key>` delegation tool while the inner payload carries the
					// sub-agent's real tool call and arguments. Reading the outer level
					// would match the delegation tool against a scenario tool id and
					// find nothing, losing the escalation. The decline still keys on
					// the outer toolCallId, which is the call the parent run is holding.
					const payload = output.suspendPayload?.suspendPayload
						? {
								...output.suspendPayload.suspendPayload,
								toolCallId: output.suspendPayload.toolCallId,
							}
						: output.suspendPayload;

					if (!payload?.toolCallId || output.runId === undefined) {
						throw new Error(
							`Scenario "${scenario.id}": unusable suspension payload — ` +
								`toolCallId: ${payload?.toolCallId ?? "missing"}, ` +
								`runId: ${output.runId ?? "missing"}`,
						);
					}

					// Identify the suspended attempt from the payload rather than a
					// loop index. A single generate() may consume several tool calls
					// before suspending, so an index would desynchronize from the
					// call actually being held.
					const entry = group.find(
						({ index, attempt }) =>
							attempt.toolId === payload.toolName &&
							JSON.stringify(attempt.args) === JSON.stringify(payload.args) &&
							!escalations.has(index),
					);
					if (!entry) break;

					const decision = evaluatePolicy(scenario.policy, {
						toolId: entry.attempt.toolId,
						args: entry.attempt.args,
						actor: entry.attempt.actor,
					});
					// Mastra's gate is boolean, so "never do this" and "ask a human"
					// arrive here identically. The split is computed from deputy's own
					// policy, not observed from Mastra — the blocking is measured, the
					// classification of why is not something Mastra exposes.
					if (decision === "escalated") escalations.set(entry.index, payload);

					output = (await agent.declineToolCallGenerate({
						runId: output.runId,
						toolCallId: payload.toolCallId,
						reason: `deputy: policy says ${decision}`,
					})) as MastraOutput;
				}
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
					parallelWith: siblings.get(index),
				};
			});
		},
	};
}
