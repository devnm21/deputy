/** What actually happened to an attempted tool call. */
export type Outcome = "executed" | "denied" | "escalated";

/** What policy requires happen to an attempted tool call. */
export type Expectation = Outcome;

export type FailureClass =
	| "argument-scoping"
	| "delegation"
	| "escalation"
	| "parallel-siblings"
	| "basics"
	| "policy-attachment";

export type ToolSpec = {
	id: string;
	description: string;
	/** JSON-schema-ish field list. Adapters build a zod schema from this. */
	fields: Array<{ name: string; type: "string" | "number" }>;
	/** Which agent owns this tool. Undefined means the root agent. */
	owner?: string;
};

export type PolicyRule =
	| { kind: "deny-tool"; toolId: string }
	| { kind: "require-approval"; toolId: string }
	| { kind: "max-number"; toolId: string; field: string; value: number }
	| { kind: "allowed-values"; toolId: string; field: string; values: string[] }
	| { kind: "actor-deny"; actor: string; toolId: string };

export type Attempt = {
	toolId: string;
	args: Record<string, unknown>;
	expect: Expectation;
	/** Attempts sharing a step index are emitted as parallel tool calls. */
	step?: number;
	/** Values a human must see to judge an escalation. */
	decisionCriticalFields?: string[];
	/** Which agent issues this call. Undefined means the root agent. */
	actor?: string;
};

/**
 * Which surface the policy is attached at. Only meaningful for the
 * policy-attachment class.
 *
 * - `"tool"` — policy declared on the tool definition (e.g. Mastra's per-tool
 *   `requireApproval`). The framework's own mechanism decides per call.
 * - `"caller"` — policy declared at the run / caller level (e.g. Mastra's
 *   `requireToolApproval` on `agent.generate()`). A developer who reads
 *   "require tool approval on this run" expects it to cover everything the
 *   run touches, including sub-agent inner tools.
 */
export type PolicyAttachmentSurface = "tool" | "caller";

export type Scenario = {
	id: string;
	class: FailureClass;
	description: string;
	tools: ToolSpec[];
	policy: PolicyRule[];
	attempts: Attempt[];
	/**
	 * Which surface the policy is attached at. Only used for the
	 * policy-attachment class. When absent, adapters choose the strongest
	 * surface available (the existing behavior for all other classes).
	 */
	attachmentSurface?: PolicyAttachmentSurface;
};

export type Capabilities = {
	argumentPredicates: boolean;
	actorConstraints: boolean;
	structuredEscalationPayload: boolean;
	/**
	 * Whether the framework provides a caller/run-level approval surface that
	 * is distinct from the tool-level one **and** that a developer could
	 * plausibly attach to a delegating run expecting it to span sub-agents.
	 *
	 * When true, the policy-attachment class exercises both surfaces and the
	 * pair tests whether enforcement differs by surface. When false, only one
	 * surface exists (or the caller surface does not claim to span delegation)
	 * and the caller-surface scenarios are not scored for this adapter.
	 */
	distinctCallerPolicySurface: boolean;
};

export type Observation = {
	scenarioId: string;
	class: FailureClass;
	adapter: string;
	attemptIndex: number;
	toolId: string;
	expected: Expectation;
	observed: Outcome;
	/** Present when observed === "escalated". Raw, for informativeness scoring. */
	escalationPayload?: unknown;
	/** True when the adapter could not express the governing policy rule. */
	inexpressible: boolean;
	/**
	 * Attempt indices this adapter actually emitted in the same model turn as
	 * this one. A record of the script the adapter built, not an observation of
	 * the framework: it exists so a reader of a parallel-siblings result can
	 * confirm the calls were genuinely siblings rather than sequential turns the
	 * adapter never batched.
	 */
	parallelWith?: number[];
};

export type Adapter = {
	name: string;
	frameworkVersion: string;
	capabilities: Capabilities;
	run(scenario: Scenario): Promise<Observation[]>;
};
