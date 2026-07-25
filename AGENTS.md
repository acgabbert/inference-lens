# Trace Lens Agent Guidelines

## Design before implementation

Before implementing a feature, first make the relevant design decisions about:

- Type definitions and ownership
- Object and data structure
- Public and internal contracts
- Serialization, persistence, and compatibility boundaries
- Provider-neutral versus provider-specific representations

Actively involve the user in consequential or ambiguous decisions. Present the
available options, tradeoffs, and a recommendation before committing to a
design that would meaningfully constrain the implementation.

Do not begin implementation while a material contract decision remains
unresolved. Small, reversible implementation details may be decided
independently when they do not alter the agreed design.
