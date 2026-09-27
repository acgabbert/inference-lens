"""N1 business-operation fixtures, not an n8n schema or error emulator.

Successful tools explicitly return compact JSON-array text. The error tool
raises native ToolError. No result is read from a saved provider request.
"""
import importlib.metadata
import json
import os
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from starlette.responses import JSONResponse

server = MCPServer("inference-lens-n1-matrix")
output = Path(os.environ["INFERENCE_LENS_N1_MATRIX_OUTPUT"])
scenarios = {row["id"]: row for row in json.loads(
    Path("tests/fixtures/mcp-servers/n1-matrix.json").read_text())}


def record(scenario, arguments, result=None, error=None):
    with (output / scenario / "python-execution.json").open("x") as evidence:
        json.dump({"arguments": arguments, "result": result, "error": error}, evidence, indent=2)


def complete(scenario, arguments, value):
    text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    record(scenario, arguments, result=text)
    return text


@server.tool(description=scenarios["primitive-inputs"]["description"], structured_output=False)
async def il_echo_primitives(text: str, count: int, enabled: bool) -> str:
    args = {"text": text, "count": count, "enabled": enabled}
    return complete("primitive-inputs", args, [{
        "fixture": "IL_N0_PRIMITIVE_INPUTS", "values": args,
        "types": {"text": "string", "count": "number", "enabled": "boolean"},
    }])


@server.tool(description=scenarios["nested-inputs"]["description"], structured_output=False)
async def il_nested_inputs(payload: dict, tags: list[str]) -> str:
    return complete("nested-inputs", {"payload": payload, "tags": tags}, [{
        "fixture": "IL_N0_NESTED_INPUTS", "payload": payload, "tags": tags,
        "types": {"payload": "object", "tagsIsArray": True},
    }])


@server.tool(description=scenarios["multiple-output-items"]["description"], structured_output=False)
async def il_multiple_items(topic: str) -> str:
    return complete("multiple-output-items", {"topic": topic}, [
        {"fixture": "IL_N0_MULTIPLE_OUTPUT_ITEMS", "ordinal": i, "topic": topic,
         "value": value} for i, value in [(1, "IL_N0_MULTI_FIRST"), (2, "IL_N0_MULTI_SECOND")]
    ])


@server.tool(description=scenarios["workflow-error"]["description"], structured_output=False)
async def il_workflow_error(reason: str) -> str:
    message = f"IL_N0_EXPECTED_WORKFLOW_ERROR:{reason}"
    record("workflow-error", {"reason": reason}, error=message)
    raise ToolError(message)


@server.custom_route("/health", methods=["GET"])
async def health(request):
    return JSONResponse({"ready": True})


if __name__ == "__main__":
    versions = {name: importlib.metadata.version(name) for name in ["mcp", "pydantic"]}
    if versions != {"mcp": "2.1.1", "pydantic": "2.13.5"}:
        raise RuntimeError(f"N1 fixture requires pinned SDK versions; got {versions}")
    for scenario in scenarios:
        with (output / scenario / "python-versions.json").open("x") as evidence:
            json.dump(versions, evidence, indent=2)
    server.run(transport="streamable-http", host="127.0.0.1", port=44030,
               streamable_http_path="/mcp", stateless_http=True, json_response=True)
