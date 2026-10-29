# Pluk Roadmap

Pluk turns AI-agent terminal output into structured events that downstream
tools can consume. This roadmap describes the direction for the TypeScript
package and its relationship with the wider Hive Commons agent-tooling stack.
For example, a `state_change` event can report that an agent went idle.
Logs use JSONL: one JSON record per line.

## Recently shipped

- TypeScript CLI and library support for attaching tmux sessions, classifying
  output, subscribing to JSONL logs, and sending text back into sessions.
- Built-in pattern sets for Claude, Copilot, Gemini, Goose, Codex, Aider, and Oh My Pi (`omp`).
- Rationguard integration through `pluk attach --rationguard` and stable event
  fields consumed by companion tools.
- A versioned JSONL event envelope (`v: 1`) with documented compatibility
  rules in the README's [Event Schema](README.md#event-schema) section.

## Near term

1. **Event schema evolution:** keep the JSONL envelope (fields around each event)
   additive within schema
   version 1 and define the process for a version bump, so tools such as
   rationguard can depend on it safely: add fields without removing or changing
   the meaning of existing ones within version 1.
2. **Broader CLI coverage:** add and test pattern packs for additional active
   agent CLIs as they become adoption-relevant.
3. **Operational hardening:** continue replacing tmux/terminal edge cases with
   explicit diagnostics, non-zero exits for operator errors, and isolated tests
   that do not depend on a real agent or external service.

## Implementation

Pluk is a single TypeScript package published to npm as `@hivecommons/pluk`;
there is no separate Go binary. Hive and other consumers shell out to the npm
CLI and read its JSONL logs, so event shapes and user-facing semantics are the
compatibility surface — the behavior other tools depend on.

## Non-goals for now

- A hosted event service or centralized session registry.
- Shells or terminal multiplexers beyond tmux until there is clear demand.
- Agent-control policy decisions; pluk should publish and deliver events, while
  consumers decide how to react.
