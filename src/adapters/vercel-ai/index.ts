import { Experimental_Agent, generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4, mockId } from "ai/test";
import { z } from "zod";
import { attributeExecutions } from "../../core/attribute.js";
import { createLedger } from "../../core/ledger.js";
import { evaluatePolicy } from "../../core/policy.js";
import { groupIntoSteps, siblingIndex } from "../../core/steps.js";
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

/**
 * The tool the root agent calls to reach a sub-agent. Prefixed so it cannot
 * collide with a scenario tool id, which would let the scenario's policy
 * accidentally govern the act of delegating.
 */
const delegationToolId = (owner: string) => `deputy_delegate_to_${owner.replace(/\W/g, "_")}`;

/** Sub-agents this scenario needs, in declaration order. */
function subAgentOwners(scenario: Scenario): string[] {
	return [...new Set(scenario.tools.flatMap((spec) => (spec.owner ? [spec.owner] : [])))];
}

export function createVercelAiAdapter(): Adapter {
	return {
		name: "vercel-ai",
		frameworkVersion: "7.0.93",
		capabilities: {
			// needsApproval and toolApproval both receive parsed arguments.
			argumentPredicates: true,
			// No framework-supplied notion of which agent issued a call: the
			// approval callback receives no caller identity, and the SDK models no
			// delegation edge. A caller-scoped rule is still writable by giving each
			// agent its own tools and its own approval callback, which is what this
			// adapter does, so the rule is expressible — the framework simply does
			// none of the work. Declared true because "could the rule be written"
			// is what this flag answers; how much the developer has to build is
			// recorded in the adapter's comments and the report.
			actorConstraints: true,
			// The approval request carries the full parsed tool call.
			structuredEscalationPayload: true,
		},

		async run(scenario: Scenario): Promise<Observation[]> {
			const ledger = createLedger();
			const steps = groupIntoSteps(scenario.attempts);
			const siblings = siblingIndex(steps);
			const owners = subAgentOwners(scenario);

			// A tool is registered on the agent that owns it. The SDK gives a tool
			// body no caller identity, so the actor written to the ledger comes from
			// exclusive registration: an owned tool instance exists only on that
			// sub-agent, so an execution of it can have come from nowhere else.
			const toolsFor = (owner: string | undefined) =>
				Object.fromEntries(
					scenario.tools
						.filter((spec) => spec.owner === owner)
						.map((spec) => [
							spec.id,
							tool({
								description: spec.description,
								inputSchema: schemaFor(spec),
								execute: async (args: Record<string, unknown>) => {
									ledger.record({ toolId: spec.id, args, actor: owner });
									return { ok: true };
								},
							}),
						]),
				);

			const escalations = new Map<number, unknown>();

			// Translate policy into a per-call approval decision. The framework
			// consults this; we record what it asked about.
			//
			// The actor is the agent this callback was installed on, not anything
			// the SDK reported. Verified: the callback receives
			// `{ toolCall, tools, toolsContext, messages, runtimeContext }` and no
			// field identifies the caller. Caller-scoped policy is therefore
			// expressible here only because each agent is constructed with its own
			// callback and its own tools — the same per-agent boundary the Mastra
			// adapter uses — and not because the framework carries an identity into
			// the decision. An `ai@7` developer writing one run-level callback and
			// expecting it to distinguish callers gets no such thing.
			const approveAs =
				(actor: string | undefined) =>
				async ({ toolCall }: { toolCall: { toolName: string; input: unknown } }) => {
					const decision = evaluatePolicy(scenario.policy, {
						toolId: toolCall.toolName,
						args: toolCall.input as Record<string, unknown>,
						actor,
					});
					if (decision === "denied") return "denied" as const;
					if (decision === "escalated") return "user-approval" as const;
					return "not-applicable" as const;
				};

			const collectEscalations = (
				content: readonly unknown[],
				candidates: ReadonlyArray<{ index: number; attempt: Attempt }>,
			) => {
				for (const raw of content) {
					const part = raw as {
						type: string;
						isAutomatic?: boolean;
						toolCall?: { toolName: string; input: unknown };
					};
					// isAutomatic marks the approval-request part the SDK emits even
					// for a callback that answered "denied". Treating those as
					// escalations reports zero denials and swaps the two columns.
					if (part.type !== "tool-approval-request" || part.isAutomatic === true) continue;
					if (!part.toolCall) continue;

					const entry = candidates.find(
						({ index, attempt }) =>
							attempt.toolId === part.toolCall?.toolName &&
							JSON.stringify(attempt.args) === JSON.stringify(part.toolCall?.input) &&
							!escalations.has(index),
					);
					if (entry) escalations.set(entry.index, part);
				}
			};

			// One run per step, sharing the ledger.
			//
			// A call held for human approval ends the run, so driving every step in
			// a single run leaves each later attempt unemitted — and an unemitted
			// attempt has no evidence either way, which falls through to "denied"
			// and reads as a pass. Running each step separately means a held call
			// cannot silence its successors. Attempts sharing a step still travel in
			// one model response, so the parallel-siblings class is unaffected.
			for (const group of steps) {
				const direct = group.filter(({ attempt }) => attempt.actor === undefined);
				const delegated = group.filter(({ attempt }) => attempt.actor !== undefined);

				// The SDK models no delegation edge: there is no sub-agent primitive
				// and no delegation tool, so the hop is a nested Experimental_Agent
				// (the SDK's own agent construct) invoked from a tool body on the
				// root agent. The nested agent restates the same approval callback,
				// which is the only way an `ai@7` developer can carry a caller's
				// policy across a hop the framework does not know about. Read the
				// delegation column for this row with that in mind: what it measures
				// is what a careful developer gets, not an inherited guarantee.
				// Only owners with a call in this step; a delegation hop with nothing
				// to do would add a turn the script does not account for.
				const stepOwners = owners.filter((owner) =>
					delegated.some(({ attempt }) => attempt.actor === owner),
				);

				const delegationTools = Object.fromEntries(
					stepOwners.map((owner) => {
						const mine = delegated.filter(({ attempt }) => attempt.actor === owner);
						return [
							delegationToolId(owner),
							tool({
								description: `Hand the task to the ${owner} sub-agent`,
								inputSchema: z.object({ prompt: z.string() }),
								execute: async () => {
									const child = new Experimental_Agent({
										model: new MockLanguageModelV4({
											doGenerate: [
												toolCallStep(
													mine.map(({ index, attempt }) => ({ id: `call-${index}`, attempt })),
												),
												textStep("done"),
											],
										}),
										tools: toolsFor(owner),
										toolApproval: approveAs(owner),
										stopWhen: stepCountIs(3),
										_internal: { generateId: mockId({ prefix: `approval-${owner}` }) },
									});
									const childResult = await child.generate({ prompt: scenario.description });
									collectEscalations(childResult.content, mine);
									return { ok: true };
								},
							}),
						];
					}),
				);

				const rootCalls = [
					...stepOwners.map((owner, i) => ({
						id: `call-delegate-${i}`,
						attempt: {
							toolId: delegationToolId(owner),
							args: { prompt: "carry out the delegated task" },
							expect: "executed" as const,
						},
					})),
					...direct.map(({ index, attempt }) => ({ id: `call-${index}`, attempt })),
				];

				const result = await generateText({
					model: new MockLanguageModelV4({
						doGenerate: [toolCallStep(rootCalls), textStep("done")],
					}),
					tools: { ...toolsFor(undefined), ...delegationTools },
					toolApproval: approveAs(undefined),
					stopWhen: stepCountIs(3),
					prompt: scenario.description,
					_internal: { generateId: mockId({ prefix: "approval" }) },
				});

				collectEscalations(result.content, direct);
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
					adapter: "vercel-ai",
					attemptIndex: index,
					toolId: attempt.toolId,
					expected: attempt.expect,
					observed,
					escalationPayload: escalations.get(index),
					// Nothing in the current policy vocabulary is unwritable here.
					// Argument predicates reach the approval callback, and a
					// caller-scoped rule is carried by per-agent construction. Marking
					// delegated attempts inexpressible would excuse an enforcement
					// result as a vocabulary gap, which is the one thing this column
					// must never do.
					inexpressible: false,
					parallelWith: siblings.get(index),
				};
			});
		},
	};
}
