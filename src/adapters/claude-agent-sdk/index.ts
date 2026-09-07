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
import type { Adapter, Observation, Scenario, ToolSpec } from "../../core/types.js";
import { type ScriptTurn, startFakeAnthropic } from "./fake-server.js";

/** The MCP server name the scenario tools are registered under. */
const SERVER = "deputy";

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
			// PreToolUseHookInput carries agent_id, present only for sub-agent
			// calls. Not exercised by the current corpus; delegation lands in a
			// later task, which is where enforcement gets measured.
			actorConstraints: true,
			// Verified: canUseTool receives the tool name and full input, and the
			// result message's permission_denials repeats it.
			structuredEscalationPayload: true,
		},

		async run(scenario: Scenario): Promise<Observation[]> {
			const ledger = createLedger();
			const workDir = await mkdtemp(join(tmpdir(), "deputy-claude-"));

			// The scripted tool_use id is the only attempt key this adapter
			// controls end to end, and it was verified to reach the hook verbatim.
			// Tool names are aliased in transit by this SDK, so they are not used
			// for matching.
			const toolUseId = (index: number) => `toolu_${index}`;
			const indexForToolUseId = (id: string) =>
				scenario.attempts.findIndex((_, i) => toolUseId(i) === id);

			const script: ScriptTurn[] = scenario.attempts.map((attempt, index) => ({
				type: "tool_use",
				id: toolUseId(index),
				name: `mcp__${SERVER}__${attempt.toolId}`,
				input: attempt.args,
			}));

			const server = await startFakeAnthropic(script);

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
							ledger.record({ toolId: spec.id, args: args as Record<string, unknown> });
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
						canUseTool: async (toolName, input) => {
							// canUseTool carries no tool_use_id, so the request is matched
							// back by arguments. Already-claimed indices are skipped so
							// two identical escalating calls cannot claim the same one.
							const index = [...asked].find(
								([i, call]) =>
									!escalations.has(i) && JSON.stringify(call.args) === JSON.stringify(input),
							)?.[0];
							if (index === undefined) {
								return { behavior: "deny", message: "deputy: not an approval request" };
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
											if (!attempt) return {};

											const decision = evaluatePolicy(scenario.policy, {
												toolId: attempt.toolId,
												args: input.tool_input as Record<string, unknown>,
												actor: input.agent_id,
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
				};
			});
		},
	};
}
