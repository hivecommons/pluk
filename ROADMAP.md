# Pluk Roadmap

Pluk turns AI-agent terminal output into structured events that downstream
tools can consume. This roadmap describes the direction for the TypeScript
package and its relationship with the wider Hive Commons agent-tooling stack.

## Recently shipped

- TypeScript CLI and library support for attaching tmux sessions, classifying
  output, subscribing to JSONL logs, and sending text back into sessions.
- Built-in pattern sets for Claude, Copilot, Gemini, and Goose.
- Rationguard integration through `pluk attach --rationguard` and stable event
  fields consumed by companion tools.

## Near term

1. **Event schema stability:** document compatibility expectations for the JSONL
   event format so tools such as rationguard and hotshot can depend on it safely.
2. **Broader CLI coverage:** add and test pattern packs for additional active
   agent CLIs as they become adoption-relevant.
3. **Operational hardening:** continue replacing tmux/terminal edge cases with
   explicit diagnostics, non-zero exits for operator errors, and hermetic tests.

## Go and TypeScript relationship

The TypeScript package is the npm-facing implementation for JavaScript users and
companion tools. The Go implementation remains useful where a static binary is
preferred. Near-term work should keep event shapes and user-facing semantics
aligned rather than forcing a repository merge.

## Non-goals for now

- A hosted event service or centralized session registry.
- Shells or terminal multiplexers beyond tmux until there is clear demand.
- Agent-control policy decisions; pluk should publish and deliver events, while
  consumers decide how to react.
