"""Small, read-only MCP server for trying Inference Lens on this machine.

Requires Python 3.10+ and mcp==2.1.1. Run directly with the commands in
docs/MCP_LOCAL_TRYOUT.md; the endpoint is http://127.0.0.1:44020/mcp.
"""

from mcp.server.mcpserver import MCPServer


server = MCPServer("inference-lens-local-example")


@server.tool()
def lookup_record(record_id: str) -> str:
    """Look up a synthetic record by ID. Returns a deterministic local result."""
    print(f"lookup_record called with {record_id!r}", flush=True)
    return f"Record {record_id}: local MCP result"


if __name__ == "__main__":
    server.run(
        transport="streamable-http",
        host="127.0.0.1",
        port=44020,
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
    )
