# Security Model

This plugin treats recalled memory as untrusted historical context. That is a structural design rule, not a prompt-style suggestion.

## Ingestion Security Layers

The practical pipeline is:

1. collection scoping
2. metadata tagging
3. bounded retrieval
4. untrusted-memory framing
5. host fallback when memory is unavailable

The system is designed so a failure in one layer does not automatically collapse the others.

## Supply Chain and Installer Trust Boundary

The published plugin package intentionally avoids install-time process execution.
That is a deliberate trust and distribution choice: the OpenClaw plugin is a
thin client, and the local `libravdbd` vector service is a separate operator-managed
component.

Current implementation facts:

- the published npm package has no `postinstall`
- the published plugin manifest does not register `openclaw.setup`
- the published plugin source contains no direct `child_process` usage
- the default connection is local, but `grpcEndpoint` or `sidecarPath` can
  select a remote daemon and send session content over the network
- vector service installation and lifecycle are explicit user or operator actions

The vector service distribution surface should be evaluated separately from the plugin
package. If you install `libravdbd` from release assets or another package
channel, validate that channel directly.

Offline operation depends on the daemon and its backends being local:

- no required network calls are made for embedding
- no required network calls are made for extractive compaction
- optional remote embedding and external summarizer backends can send input
  text to their configured services
- a remote daemon receives the memory RPCs and controls where its storage and
  model backends run; TLS protects transport, not locality

That trust boundary matters because it is exactly the area security-conscious
users will inspect first.

## Untrusted-Memory Framing

Retrieved memory is injected with framing that explicitly tells the downstream model to treat it as untrusted historical context only.

This matters because memory is persistent user-controlled content. Without structural framing, a stored memory can become an unintended prompt injection surface.

The framing is implemented in the host-side memory header builder and is applied consistently at assembly time.

## Collection Isolation

The plugin structurally separates:

- session memory
- raw turn history
- durable user memory
- global memory

The gate, compaction, and retrieval code operate on explicit scope-qualified
collection names. Sessions sharing a `userId` intentionally share durable user
memory, and `global` is shared within its daemon tenant. Configure tenant routing
and durable identities for the isolation you need; collection names alone do
not authenticate channel users or authorize tool access.

## Reply Rules

The reply scanner checks case-insensitive literal substrings in the
`before_agent_reply` hook's `cleanedBody`. Matching depends on the host invoking
that hook and honoring its returned refusal. It is a keyword filter, not a
general PII detector: obfuscated or encoded text, indirect references, tool
output, logs, and unsupported delivery paths are outside that check. Prompt
rules are behavioral guidance to the model and are not an access-control
boundary.

## What the Plugin Cannot Protect Against

The plugin does not claim to protect against:

- a compromised host process
- a compromised local machine
- a downstream model that ignores the untrusted-memory framing instruction
- intentionally malicious content stored by an already-authorized local actor

It reduces risk; it does not create a trusted execution environment.

## Deletion and Data Protection

The vector service exposes deletion and flush primitives. That matters operationally for:

- user-requested memory removal
- namespace cleanup
- compaction source-turn deletion

The GDPR-relevant boundary is simple: local stored memory can be deleted by namespace. The plugin does not by itself guarantee remote erasure from any external system because the architecture is intentionally local-first.
