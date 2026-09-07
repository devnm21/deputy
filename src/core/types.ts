/** What actually happened to an attempted tool call. */
export type Outcome = "executed" | "denied" | "escalated";

/** What policy requires happen to an attempted tool call. */
export type Expectation = Outcome;

export type FailureClass =
	| "argument-scoping"
	| "delegation"
	| "escalation"
	| "parallel-siblings"
	| "basics";

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

export type Scenario = {
	id: string;
	class: FailureClass;
	description: string;
	tools: ToolSpec[];
	policy: PolicyRule[];
	attempts: Attempt[];
};

export type Capabilities = {
	argumentPredicates: boolean;
	actorConstraints: boolean;
	structuredEscalationPayload: boolean;
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
