# ADR-0002. Verdicts come from deterministic predicates, not from a model

## Status
Accepted, 2026-11-27

## Context
A security verdict that changes between runs of the judge, or that a payload can talk the judge out of, is worthless. Model judges also cost money and need calibration.

## Decision
Every scenario lists failure predicates (any one firing means hijacked) and success predicates (all must hold for the task to count as done). Predicates are small typed checks in `src/predicates.js` over the recorded events, the final answers and the final sandbox state: a tool called with matching arguments, an email to an address that appears only in the injected text, a request to a host that appears only there, a planted canary secret in any tool argument (under several encodings), a destructive call the task did not need, a file state, an answer matching a pattern, and `not`, `any_of`, `all_of`.

## Consequences
- Verdicts are reproducible from a saved trace.
- Semantic hijacks without a detectable token are missed. Predicates that look at answer text must avoid counting a refusal that quotes the injected text; a real run found one such false positive and the regression test now covers it.
