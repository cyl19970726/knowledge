# Knowledge public contract v1

This package is the sole public knowledge DTO and runtime validation authority. It imports only the browser-safe canonical primitives from `@commerce/contract-primitives`, never the broad legacy contracts index. `KnowledgeRef` preserves the existing stored `{objectId,versionId}`; `toVersionRef` drops only transport provenance. A null `contentDigest` means that the exact source owner's digest has not been verified, not that a new content identity was computed.

Every success is `EnvelopeSchema(DataSchema)` with contract version `1.0.0` and effective project/space scope. Every failure is a bare `ApiErrorSchema` with explicit `commitStatus`. `unknown` requires operation lookup or manual reconciliation, never a fresh idempotency key retry. The server binds principal and client installation through authentication; request bodies do not assert them. Purpose is explicit on relevant reads and mutations and must be checked by the server.

A read receipt records exact ordered items, page fingerprints, scope, principal, policy, purpose and coverage. The request discriminant distinguishes query, catalog, exact and history reads. Source readability separates metadata visibility, actual content access and anchor resolution. `read_time_only` assurance does not establish a publication lease. Research outcomes are `candidate`, `no_change` and `needs_evidence`; a result may have no publication. None of these schemas establishes cognitive correctness or business impact.

The schemas bound text, arrays, cursors, bytes and graph depth. The application layer remains responsible for cross-field authorization, source lease validation, idempotency reservation, publication fencing and persistence.
