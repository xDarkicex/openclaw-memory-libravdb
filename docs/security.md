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
thin client, and the local `libravdbd` daemon is a separate operator-managed
component.

Current implementation facts:

- the published npm package has no `postinstall`
- the published plugin manifest does not register `openclaw.setup`
- the published plugin source contains no direct `child_process` usage
- the plugin connects only to a configured local endpoint such as
  `unix:/Users/<you>/.libravdbd/run/libravdb.sock` or `tcp:127.0.0.1:37421`
- daemon installation and lifecycle are explicit user or operator actions

The daemon distribution surface should be evaluated separately from the plugin
package. If you install `libravdbd` from release assets or another package
channel, validate that channel directly.

After installation, the plugin remains local-first:

- no required network calls are made for embedding
- no required network calls are made for extractive compaction
- the only optional runtime network path is an explicitly configured external
  summarizer endpoint, such as an Ollama server

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

Cross-user leakage is prevented by collection naming and lookup boundaries. The gate, compaction, and retrieval code all operate on explicit scope-qualified collection names rather than a shared unscoped table.

## What the Plugin Cannot Protect Against

The plugin does not claim to protect against:

- a compromised host process
- a compromised local machine
- a downstream model that ignores the untrusted-memory framing instruction
- intentionally malicious content stored by an already-authorized local actor

It reduces risk; it does not create a trusted execution environment.

## Deletion and Data Protection

The daemon exposes deletion and flush primitives. That matters operationally for:

- user-requested memory removal
- namespace cleanup
- compaction source-turn deletion

The GDPR-relevant boundary is simple: local stored memory can be deleted by namespace. The plugin does not by itself guarantee remote erasure from any external system because the architecture is intentionally local-first.
