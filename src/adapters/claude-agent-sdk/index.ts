import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSdkMcpServer,
	type PreToolUseHookInput,
	query,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { attributeExecutions } from "../../core/attribute.js";
import { createLedger } from "../../core/ledger.js";
import { evaluatePolicy } from "../../core/policy.js";
import { groupIntoSteps, siblingIndex } from "../../core/steps.js";
import type { Adapter, Observation, Scenario, ToolSpec } from "../../core/types.js";
import { type ScriptTurn, startFakeAnthropic } from "./fake-server.js";

/** The MCP server name the scenario tools are registered under. */
const SERVER = "deputy";

/**
 * The scripted tool_use id for the Task call that opens a delegation hop. It
 * matches no attempt, so the hook lets it through: the scenario's policy governs
 * the sub-agent's tools, not the act of delegating.
 */
const DELEGATION_TOOL_USE_ID = "toolu_delegate";

/** Sub-agents this scenario needs, in declaration order. */
function subAgentOwners(scenario: Scenario): string[] {
	const unique = [...new Set(scenario.tools.flatMap((spec) => (spec.owner ? [spec.owner] : [])))];
	if (unique.length > 1) {
		throw new Error(
			`Scenario "${scenario.id}" declares ${unique.length} tool owners. This adapter scripts one delegation hop per run, so a multi-owner scenario would emit turns in an order it cannot attribute.`,
		);
	}
	return unique;
}

/**
 * Scenario tools are registered as in-process SDK MCP tools so their bodies run
 * inside this process and can write to the ledger, as the other two adapters do.
 * Registering the SDK's own Write tool instead would put the tool body in the
 * spawned subprocess, where the ledger cannot see it.
 */
function shapeFor(spec: ToolSpec): Record<string, z.ZodTypeAny> {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const field of spec.fields) {
		shape[field.name] = field.type === "number" ? z.number() : z.string();
	}
	return shape;
}

type Denial = { tool_name: string; tool_use_id: string; tool_input: unknown };

export function createClaudeAgentSdkAdapter(): Adapter {
	return {
		name: "claude-agent-sdk",
		frameworkVersion: "0.3.263",
		capabilities: {
			// Verified: PreToolUse receives the full, unredacted tool_input, so a
			// rule over arguments discriminates two calls to the same tool.
			argumentPredicates: true,
			// Verified empirically, not read off the type contract: a sub-agent's
			// MCP tool call reaches PreToolUse carrying agent_id and the declared
			// agent_type, so a rule naming the caller can be both written and
			// enforced one hop down. See the delegation tests.
			actorConstraints: true,
			// Verified: canUseTool receives the tool name and full input, and the
			// result message's permission_denials repeats it.
			structuredEscalationPayload: true,
			// The SDK offers session-wide PreToolUse hooks and canUseTool as the
			// only approval surface. There is no per-tool-definition approval
			// mechanism. The hooks fire for all tool calls including sub-agent
			// calls (with agent_id), so the single surface is effectively a
			// caller-level surface that inherently spans delegation. There is no
			// second, distinct surface to compare it against.
			distinctCallerPolicySurface: false,
		},

		async run(scenario: Scenario): Promise<Observation[]> {
			// The Claude Agent SDK's only approval surface is session-wide hooks
			// (PreToolUse / canUseTool), which inherently span delegation. There
			// is no per-tool-definition approval mechanism, so a "tool" surface
			// request is handled identically to the default — the hooks are still
			// the mechanism. For "caller" surface scenarios: the session-wide hooks
			// ARE the caller surface, and they work for delegation. But since
			// there is no second, distinct surface to compare against, the
			// caller-surface scenarios are not scored here — the adapter offers
			// only one surface and the class must not manufacture a finding from
			// the absence of a second one.
			if (scenario.attachmentSurface === "caller") return [];

			const ledger = createLedger();
			const workDir = await mkdtemp(join(tmpdir(), "deputy-claude-"));

			// The scripted tool_use id is the only attempt key this adapter
			// controls end to end, and it was verified to reach the hook verbatim.
			// Tool names are aliased in transit by this SDK, so they are not used
			// for matching.
			const toolUseId = (index: number) => `toolu_${index}`;
			const indexForToolUseId = (id: string) =>
				scenario.attempts.findIndex((_, i) => toolUseId(i) === id);

			// One turn per step. A step holding several attempts becomes several
			// tool_use blocks in one assistant turn, which is what makes them
			// siblings; scripting them as consecutive turns would let a framework
			// that resolves a batch unsafely still score clean.
			const steps = groupIntoSteps(scenario.attempts);
			const siblings = siblingIndex(steps);
			const owners = subAgentOwners(scenario);

			const script: ScriptTurn[] = steps.map((group) => ({
				type: "tool_use",
				blocks: group.map(({ index, attempt }) => ({
					id: toolUseId(index),
					name: `mcp__${SERVER}__${attempt.toolId}`,
					input: attempt.args,
				})),
			}));

			// A delegated call has to reach the sub-agent before it can be scripted,
			// so the root agent's first turn invokes the Task tool. The sub-agent
			// then runs its own conversation against the same fake server, which
			// serves the tool_use turns above.
			for (const owner of owners) {
				script.unshift({
					type: "tool_use",
					id: DELEGATION_TOOL_USE_ID,
					name: "Task",
					input: {
						subagent_type: owner,
						description: `delegate to ${owner}`,
						prompt: scenario.description,
					},
				});
			}

			const server = await startFakeAnthropic(script);

			// Actors the framework reported for calls it was about to make, keyed by
			// tool and arguments and drained in call order. The tool body cannot see
			// who invoked it — an MCP handler receives only its arguments — so the
			// actor written to the ledger is the one PreToolUse reported for that
			// call. It is still framework-observed rather than assumed: nothing here
			// reads the scenario's declared actor.
			const reportedActors = new Map<string, string[]>();
			const actorKey = (toolId: string, args: Record<string, unknown>) =>
				`${toolId}\u0000${JSON.stringify(args)}`;

			// Attempts the hook routed to the framework's approval channel. An
			// escalation is only recorded once the framework actually raises the
			// request, so the outcome is observed rather than assumed.
			const asked = new Map<number, { toolId: string; args: Record<string, unknown> }>();
			const escalations = new Map<number, unknown>();
			const denials: Denial[] = [];

			try {
				const mcpServer = createSdkMcpServer({
					name: SERVER,
					version: "0.0.0",
					tools: scenario.tools.map((spec) =>
						tool(spec.id, spec.description, shapeFor(spec), async (args) => {
							const input = args as Record<string, unknown>;
							ledger.record({
								toolId: spec.id,
								args: input,
								actor: reportedActors.get(actorKey(spec.id, input))?.shift(),
							});
							return { content: [{ type: "text", text: "ok" }] };
						}),
					),
				});

				const run = query({
					prompt: scenario.description,
					options: {
						cwd: workDir,
						// Isolation: a developer's ~/.claude must not perturb scores.
						settingSources: [],
						// 'auto' is excluded deliberately: it calls a classifier model.
						permissionMode: "default",
						mcpServers: { [SERVER]: mcpServer },
						// A sub-agent per tool owner, scoped to that owner's tools.
						// AgentDefinition.tools is a scope rather than a check — an
						// omitted tool is absent from the sub-agent's session with no
						// prompt and no error — so the owner's tools are listed
						// explicitly and denial is left to the hook. That keeps tool
						// omission and tool denial distinguishable outcomes.
						agents: Object.fromEntries(
							owners.map((owner) => [
								owner,
								{
									description: `Handles ${owner} work on behalf of the root agent`,
									prompt: `You are the ${owner}. Carry out the task you are given.`,
									tools: scenario.tools
										.filter((spec) => spec.owner === owner)
										.map((spec) => `mcp__${SERVER}__${spec.id}`),
								},
							]),
						),
						// No bare allowedTools entries — one auto-approves its tool
						// before canUseTool is consulted, silently shadowing it.
						env: {
							// The TypeScript SDK replaces the subprocess environment with
							// this object rather than merging, so process.env must be
							// spread in explicitly.
							...process.env,
							// Session transcripts otherwise accumulate under the
							// developer's ~/.claude/projects, keyed by cwd. Keeping them
							// inside workDir means the temp dir removal cleans up
							// everything the run wrote.
							CLAUDE_CONFIG_DIR: join(workDir, ".claude"),
							ANTHROPIC_BASE_URL: server.baseUrl,
							ANTHROPIC_API_KEY: "deputy-fake-key",
							CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
							DISABLE_TELEMETRY: "1",
							DISABLE_AUTOUPDATER: "1",
						},
						// The framework's own human-approval channel. Reached only for
						// calls the hook answered with "ask".
						canUseTool: async (toolName, input, options) => {
							const index = indexForToolUseId(options.toolUseID);
							if (index < 0 || !asked.has(index)) {
								throw new Error(
									`Scenario "${scenario.id}": canUseTool received toolUseID "${options.toolUseID}" which does not resolve to a known attempt`,
								);
							}
							escalations.set(index, { toolName, input });
							// Nothing here can answer for a human, so the call is held.
							return { behavior: "deny", message: "deputy: awaiting human approval" };
						},
						hooks: {
							PreToolUse: [
								{
									hooks: [
										async (raw) => {
											const input = raw as PreToolUseHookInput;
											const index = indexForToolUseId(input.tool_use_id);
											const attempt = scenario.attempts[index];
											// An unscripted call is none of this adapter's business.
											// That includes the Task call opening a delegation hop.
											if (!attempt) return {};

											const args = input.tool_input as Record<string, unknown>;
											// agent_id is an opaque per-run identifier; agent_type is
											// the key the sub-agent was declared under, which is what a
											// policy author names. agent_type also appears on a main
											// thread started with --agent, so agent_id's presence is
											// what marks this a sub-agent call.
											const actor = input.agent_id === undefined ? undefined : input.agent_type;

											if (actor !== undefined) {
												const key = actorKey(attempt.toolId, args);
												const queue = reportedActors.get(key);
												if (queue) queue.push(actor);
												else reportedActors.set(key, [actor]);
											}

											const decision = evaluatePolicy(scenario.policy, {
												toolId: attempt.toolId,
												args,
												actor,
											});

											if (decision === "escalated") {
												asked.set(index, {
													toolId: attempt.toolId,
													args: input.tool_input as Record<string, unknown>,
												});
											}

											return {
												hookSpecificOutput: {
													hookEventName: "PreToolUse",
													permissionDecision:
														decision === "executed"
															? "allow"
															: decision === "escalated"
																? "ask"
																: "deny",
													permissionDecisionReason: `deputy: policy says ${decision}`,
												},
											};
										},
									],
								},
							],
						},
					},
				});

				for await (const message of run) {
					if (message.type === "result") {
						const reported = (message as { permission_denials?: Denial[] }).permission_denials;
						if (reported) denials.push(...reported);
					}
				}
			} finally {
				await server.close();
				await rm(workDir, { recursive: true, force: true });
			}

			// Execution comes from the ledger alone. permission_denials is attached
			// to escalation payloads as a corroborating signal, never as the oracle.
			const executed = attributeExecutions(scenario.attempts, ledger.entries());

			return scenario.attempts.map((attempt, index): Observation => {
				let observed: Observation["observed"];
				if (executed[index]) observed = "executed";
				else if (escalations.has(index)) observed = "escalated";
				else observed = "denied";

				const escalation = escalations.get(index);
				const corroborating = denials.find((d) => d.tool_use_id === toolUseId(index));

				return {
					scenarioId: scenario.id,
					class: scenario.class,
					adapter: "claude-agent-sdk",
					attemptIndex: index,
					toolId: attempt.toolId,
					expected: attempt.expect,
					observed,
					escalationPayload:
						escalation === undefined
							? undefined
							: { approvalRequest: escalation, reportedDenial: corroborating },
					// The hook sees full arguments and agent_id, so every rule in the
					// current vocabulary is expressible. Any gap is an enforcement
					// failure and must be scored as one.
					inexpressible: false,
					parallelWith: siblings.get(index),
				};
			});
		},
	};
}
