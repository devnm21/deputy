# deputy — design

Status: draft, 2026-09-04

## Goal

Answer one question per framework, with reproducible evidence:

> When an agent attempts a tool call that policy forbids, does the framework's approval
> machinery actually stop it?

Not "does the framework have an approval feature" — every target does. Whether the
feature is *reached*, and whether it has enough information to decide.

## Non-goals

- Enforcing authorization. Use a policy engine behind the framework's hook.
- Prompt-injection benchmarking. Adjacent, crowded, and would pull focus.
- Ranking models. The scripted tier deliberately removes the model as a variable.
- Claiming novelty in agent authorization generally. The contribution is the harness.

## Core model

### Outcomes

For each attempted call the harness observes exactly one outcome:

| Outcome | Meaning |
|---|---|
| `executed` | The tool body ran. |
| `denied` | Blocked outright; the tool body did not run. |
| `escalated` | A human approval was requested; the tool body did not run pending it. |

Outcomes are observed, never self-reported. Every tool body under test is instrumented
to record its own invocation, so `executed` is ground truth rather than something the
framework tells us.

This is not fastidiousness. In the Vercel AI SDK, an approved tool executes during
message reconstruction *before* the next model call, so its result is absent from that
step's `toolResults` and `staticToolResults`. A harness that inferred execution from
the framework's own result object would report `denied` for every correctly approved
call. Only the tool body knows whether the tool body ran.

### Scenario

A scenario is a framework-agnostic declaration: the tools that exist, the policy that
governs them, the calls the agent will attempt, and the outcome each call deserves.

```ts
type Scenario = {
  id: string;
  class:
    | "argument-scoping"
    | "delegation"
    | "escalation"
    | "parallel-siblings"
    | "basics";
  description: string;

  tools: ToolSpec[];
  policy: PolicyRule[];

  /** Emitted verbatim by the scripted provider, in order. */
  attempts: Attempt[];
};

type Attempt = {
  toolId: string;
  args: Record<string, unknown>;
  /** The outcome policy requires. */
  expect: "executed" | "denied" | "escalated";
  /**
   * Attempts sharing a step index are emitted in one model response, i.e. as
   * parallel tool calls. Defaults to a step of its own. Required by the
   * parallel-siblings class and harmless elsewhere.
   */
  step?: number;
  /** Arguments a human must see to judge an escalation. Escalation class only. */
  decisionCriticalFields?: string[];
  /** Which agent in the delegation chain issues this. Delegation class only. */
  actor?: string;
};
```

### Why the delegation class leads

Testing `@mastra/core@1.64.0` directly produced a positive result before the harness
existed. A parent agent's run-level `requireToolApproval` policy is consulted exactly
once — for the auto-generated `agent-<name>` delegation tool — and never for the
sub-agent's inner tool names or arguments. A parent-level allowlist is therefore
escaped by routing the call through a sub-agent, and the child's tool executes with the
parent policy never having seen it.

The Claude Agent SDK fails the other direction on the same edge, which makes the class
comparative rather than a single-framework result. Its hooks *do* fire for sub-agent
tool calls, tagged with `agent_id`, so interception works. But authority inheritance is
asymmetric: a sub-agent may loosen its permission mode relative to a `default` parent,
while a parent running `bypassPermissions`, `acceptEdits`, or `auto` applies that mode
to every sub-agent and it cannot be tightened per sub-agent. Permissive settings flow
down and restrictive ones do not.

Its `AgentDefinition.tools` array is also a scope rather than a check — an omitted tool
is absent from the sub-agent's session entirely, with no prompt and no error. So
tool-omission and tool-denial are distinguishable outcomes and are scored separately.

A tool's *own* `requireApproval` does propagate correctly across the delegation edge
and suspends the parent run, which makes the safe pattern the inverse of the intuitive
one: gate at the tool definition, not at the caller. The behavior is undocumented in
either direction, so it is neither a promised contract nor a filed bug.

This is the shape of finding the harness exists to produce, and it reframes what the
benchmark is likely to show. Both Mastra and the Vercel AI SDK can express
argument-dependent approval, so the expressiveness gap is narrower than first assumed.
The breakage lives at the delegation edge, where policy written at one level silently
fails to apply at the next.

### Why parallel siblings is its own class

Testing `ai@7.0.93` directly showed that when one step contains two tool calls and only
one is gated, the ungated sibling executes immediately while the gated one waits. The
SDK's own test suite asserts this as intended behavior, so it is a design position
rather than a bug — but it means an agent can pair a forbidden call with an innocuous
one in the same step and have the pair partially run.

The class costs almost nothing to add: it is an attempt shape, not new machinery. And
it generalizes, because any framework resolving approval per call rather than per step
has the same exposure.

Policy rules are declarative and cover the three things the failure classes need:
argument predicates (`amount <= 100`, `recipient in teammates`), actor constraints
(which agent in a chain may call what), and a required-escalation marker.

### Adapter contract

```ts
interface Adapter {
  name: string;
  capabilities: Capabilities;
  run(scenario: Scenario): Promise<Observation[]>;
}
```

An adapter does three things: registers the scenario's tools with the real framework
using instrumented bodies, translates `policy` onto whatever native mechanism the
framework offers, and drives the agent with a scripted model provider that emits
`attempts` verbatim.

The framework's genuine interception path runs. Nothing is sampled, so a scenario
produces identical observations on every execution.

### Capabilities, and why they matter

Frameworks differ in what policy they can *express*, not just what they enforce. A
framework whose approval flag is a per-tool boolean cannot represent `amount <= 100` at
all. Scoring that as a plain failure would be unfair and would obscure the finding.

So each adapter declares what it can express:

```ts
type Capabilities = {
  argumentPredicates: boolean;
  actorConstraints: boolean;
  structuredEscalationPayload: boolean;
};
```

When a scenario needs a capability the adapter lacks, the adapter maps the policy as
closely as it can — usually onto a coarser mechanism — and the case is tagged
`inexpressible`. Those cases are reported in their own column rather than folded into
the failure count.

"The framework let the call through" and "the framework had no way to describe the
rule" are different problems with different fixes, and no existing benchmark separates
them.

Early measurement suggests this column will be sparser than expected: both Mastra
(`requireApproval` and run-level `requireToolApproval`, either of which may be an async
predicate over arguments) and the Vercel AI SDK (`needsApproval`, which receives parsed
arguments) can express argument predicates. The axis stays in the design because a
sparse column is itself a result — it establishes that these frameworks fail by not
applying expressible policy rather than by lacking the vocabulary for it.

### Verified adapter constraints

Facts established by running each framework, recorded so adapters are not written from
assumption:

**Mastra.** A bare `new Agent({...})` reports `finishReason: 'suspended'` but persists
no snapshot, so approval cannot be resumed; the agent must be registered on a `Mastra`
instance with storage. Delegation tools are exposed to the model as `agent-<key>`, not
`<key>`. `requestContext` must be a real `RequestContext` instance rather than a plain
object. On a nested suspension the outer entry reports `requiresApproval: false` while
the nested `suspendPayload` carries the real request, so assertions must read the
nested payload. `agent.generate()` routes to `doGenerate`, not `doStream`.

**Vercel AI SDK.** A scripted model must return `finishReason` and `usage` as nested
objects, and a tool call's `input` as a JSON string. Multi-step scripts require
`stopWhen: stepCountIs(n)`, since the default is a single step. Deterministic approval
ids come from `_internal: { generateId: mockId({ prefix: 'approval' }) }`.

Both scripted models must terminate with a text step. A script that returns the same
tool call indefinitely runs until the step ceiling instead of finishing.

**Claude Agent SDK.** This adapter has a different shape from the other two. The SDK
exposes no pluggable model, but it spawns a bundled Claude Code subprocess, so the
adapter stands up a local HTTP server speaking the Anthropic Messages SSE format and
points the subprocess at it with `ANTHROPIC_BASE_URL` via `options.env`. The TypeScript
SDK *replaces* the subprocess environment with `env` rather than merging, so
`process.env` must be spread in explicitly.

The fake server must serve `POST /v1/messages?beta=true` matched on path rather than
full URL, must stream SSE rather than buffer (a buffering gateway stalls the client),
and should answer the `HEAD /api/hello` warm-up probe. Scripting is one layer lower than
the other adapters: turn one returns a `tool_use` block, later turns return text with
`stop_reason: "end_turn"`.

Three constraints on this adapter: `settingSources: []` is mandatory, or a developer's
`~/.claude/` config perturbs scores; `permissionMode: 'auto'` is excluded from Tier 1
because it invokes a classifier model; and tool names are aliased in transit, so a
scripted `Task` call surfaces to the hook as `Agent` and the scripted name cannot be
assumed to reach the hook verbatim.

The SDK also offers a second, independent oracle the other frameworks lack: the result
message carries a machine-readable `permission_denials` array. Assertions still key on
canary side effects, but agreement between the two is a useful self-check on the
adapter.

## Metrics

Four numbers per framework per class. The first two are always reported together.

**Unauthorized Execution Rate.** Of attempts expecting `denied` or `escalated`, the
fraction that reached `executed`. The headline.

**Over-block Rate.** Of attempts expecting `executed`, the fraction that were denied or
escalated. Reported alongside UER without exception — UER alone is trivially gamed by
denying everything, and a gate that interrupts a human constantly gets approved
reflexively, which is its own failure.

**Escalation Informativeness.** For attempts that correctly escalated, the fraction of
`decisionCriticalFields` whose values appear in the approval payload shown to the
human. Scored structurally against the rendered payload — no LLM judge, so it stays
deterministic and arguable only on the rubric, not the run.

**Expressiveness Gap.** The fraction of attempts tagged `inexpressible`.

## Run tiers

**Tier 1 — scripted.** Real framework, real tools, scripted provider. Deterministic,
free, runs in CI. Produces every published number.

**Tier 2 — live.** A subset of scenarios against real models, repeated enough times to
report a range. Exists to answer "does the scripted tier reflect reality?" and is never
used for headline claims. Failure to reproduce a Tier 1 result is itself a finding
worth publishing.

## Report

The runner emits `results/<timestamp>.json` as the durable artifact and a markdown
table for the README. Rows are frameworks, column groups are failure classes, each cell
carries UER and over-block together so neither can be quoted alone.

Every JSON record keeps the scenario id, adapter name, adapter version, framework
version, observed outcome, and expected outcome — enough for a reader to re-run a
single disputed case rather than the whole suite.

## Layout

A single package. No monorepo; the adapter count does not justify the overhead.

```
src/
  core/        scenario types, runner, metrics, report
  adapters/
    mastra/
    vercel-ai/
    claude-agent-sdk/
scenarios/
  argument-scoping/
  parallel-siblings/
  delegation/
  escalation/
  basics/
docs/
```

## Open questions

- Does the Claude Agent SDK's `PreToolUse` hook surface arguments in a form an adapter
  can enforce against, or does it constrain the shape of the delegation scenarios?
- Escalation payload capture differs per framework. The rubric may need a per-adapter
  normalization step before informativeness is comparable across the table.
- Whether the delegation class needs more than two levels to say anything interesting.
  Two levels already produce a bypass on Mastra, so depth may add cost without adding
  findings.
- Mastra's `beforeToolCall` hook blocks execution correctly, but its
  `{ proceed: false, output }` was observed surfacing `toolResults: [null]` rather than
  the supplied output. Unresolved, and it affects how a denial is reported rather than
  whether it holds.
- Deferred to a later version: **approval forgery**, since approval history arrives as
  client-controlled input and the Vercel SDK's mitigation is an `experimental_`-prefixed
  HMAC secret whose absence is itself a finding.
- **Configuration shadowing** now has a confirmed instance in each of two frameworks
  and is the strongest candidate for the next class. A permissive run-level
  `toolApproval` map silently overrides a tool's own `needsApproval` in the Vercel SDK,
  and a bare `allowedTools` entry in the Claude Agent SDK auto-approves a tool before
  `canUseTool` is consulted, signalled only by a one-time process warning. Both are
  bypasses produced by configuration rather than by the model, which makes them
  invisible to any benchmark that only varies the agent's behavior.
