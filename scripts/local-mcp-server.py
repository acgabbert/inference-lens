"""Small, read-only MCP server for trying Inference Lens on this machine.

Requires Python 3.10+ and mcp==2.1.1. Run directly with the commands in
docs/MCP_LOCAL_TRYOUT.md; the endpoint is http://127.0.0.1:44020/mcp.
INFERENCE_LENS_LOCAL_MCP_PORT moves it, which the Python browser lane uses to
run beside the suite's own fixtures.
"""

import asyncio
import os

from mcp.server.mcpserver import MCPServer


server = MCPServer("inference-lens-local-example")


@server.tool()
async def lookup_record(record_id: str) -> str:
    """Look up a synthetic record by ID. Returns a deterministic local result."""
    print(f"lookup_record called with {record_id!r}", flush=True)
    if record_id == "slow":
        print("Waiting 60 seconds: stop the app run or kill this server now.", flush=True)
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            print("lookup_record 'slow': server task cancelled", flush=True)
            raise
    print(f"lookup_record completed for {record_id!r}", flush=True)
    return f"Record {record_id}: local MCP result"


if __name__ == "__main__":
    print(f"Local MCP server PID: {os.getpid()} (kill -KILL this PID for connection-loss testing)", flush=True)
    server.run(
        transport="streamable-http",
        host="127.0.0.1",
        port=int(os.environ.get("INFERENCE_LENS_LOCAL_MCP_PORT", "44020")),
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
    )
