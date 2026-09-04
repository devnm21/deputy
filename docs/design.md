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

### Scenario

A scenario is a framework-agnostic declaration: the tools that exist, the policy that
governs them, the calls the agent will attempt, and the outcome each call deserves.

```ts
type Scenario = {
  id: string;
  class: "argument-scoping" | "delegation" | "escalation" | "basics";
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
  /** Arguments a human must see to judge an escalation. Escalation class only. */
  decisionCriticalFields?: string[];
  /** Which agent in the delegation chain issues this. Delegation class only. */
  actor?: string;
};
```

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

This is the most interesting output the harness produces. "The framework let the call
through" and "the framework had no way to describe the rule" are different problems
with different fixes, and no existing benchmark separates them.

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
