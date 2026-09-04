# deputy

A conformance benchmark for agent tool-call authorization.

Agent frameworks ship approval mechanisms: Vercel AI SDK's `needsApproval`, Mastra's
`requireToolApproval`, the Claude Agent SDK's `PreToolUse` hooks. Every one of them
answers the question *"is this tool sensitive?"*

Almost none of them answer *"is **this call**, with **these arguments**, in **this
context**, allowed?"*

`deputy` measures the gap. It drives a framework's real approval machinery with a
scripted set of adversarial tool calls and reports, per framework, how many it
actually stopped.

## The gap, concretely

The dominant pattern is a static per-tool boolean, fixed when the tool is defined:

```ts
createTool({
  id: "send-email",
  requireApproval: true,
  // ...
});
```

Approval is now a property of the *tool*, not the *call*. `send-email` to one
teammate and `send-email` to `all@company` are indistinguishable to the gate. Set the
flag and every routine call interrupts a human until they approve reflexively; leave
it off and the blast radius is unbounded. There is no argument in that decision,
because there is nowhere to put one.

## What it measures

Four failure classes, each a scenario family with a pass/fail per case:

| Class | Question |
|---|---|
| **Argument scoping** | Tool is permitted; the arguments are not. Refund above the cap, email outside the allowed recipients, delete outside the owned scope. |
| **Delegation chains** | A parent agent spawns a sub-agent. Does the sub-agent inherit authority the parent never had, or bypass a gate the parent was subject to? |
| **Escalation quality** | When the gate *does* ask a human, does the request name the actual resource and blast radius — or just the tool name? An approval prompt that can't be evaluated is a rubber stamp. |
| **Basics** *(control)* | A plainly forbidden tool, no ambiguity. Everything should pass. Included so the other three have a baseline. |

## How it runs

**Tier 1 — scripted (deterministic, free, CI-safe).** Real tools registered with the
real framework, driven by a scripted model provider that emits exactly the tool calls
a scenario specifies. The framework's genuine interception path executes; nothing is
sampled. Same input, same result, every run. This tier produces the published numbers.

**Tier 2 — live (small, slow, indicative).** The same scenarios against real models,
to confirm the scripted tier reflects reality. Reported with error bars and never
used for headline claims.

The distinction matters: calling a policy function directly would only test code
written for the benchmark. Tier 1 tests whether the framework's gate is *reached* at
all — which is the failure that actually ships.

## Targets

Mastra, the Vercel AI SDK, and the Claude Agent SDK in v1. Adapters are small and
contributions for other frameworks are welcome.

## Prior art

This is not the first work on agent authorization, and it deliberately measures rather
than enforces — the enforcement layer is well served.

- Deterministic pre-action authorization for agent tool calls, which names delegation
  chains and human escalation as open problems. `deputy` takes those two as scenario
  families.
- Framework-native approval APIs listed above, which are the systems under test rather
  than competitors.

If you are looking for a way to *enforce* per-call authorization, use a policy engine
(OPA, Cedar, OpenFGA) behind your framework's approval hook. `deputy` tells you whether
it worked.

## Status

Early. Design in progress; no usable release yet.

## License

MIT
