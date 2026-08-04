# Command tool fixtures

Deterministic executables for the command-tool executor, one per normalized
outcome. Each is its own file rather than one script with a mode switch, so a
catalog entry reads as the situation it produces and a test cannot select the
wrong branch by passing the wrong argument.

They read the executor's stdin payload — `{ tool, toolCallId, arguments }` —
and answer on stdout, which is exactly the contract documented in
[docs/COMMAND_TOOLS.md](../../../docs/COMMAND_TOOLS.md).
