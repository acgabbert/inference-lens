# Try MCP locally

This example uses the official Python MCP SDK. Its one read-only tool,
`lookup_record(record_id)`, returns a predictable string. The server listens
only on `127.0.0.1:44020`; Inference Lens connects to its Streamable HTTP
endpoint at `/mcp`. Run the commands from the repository root in separate
terminals.

## 1. Start the MCP server

Use Python 3.10 or newer. On macOS with Homebrew, `brew install python@3.12`
provides `python3.12` if it is not installed already.

```sh
python3.12 -m venv .venv-mcp
.venv-mcp/bin/python -m pip install 'mcp==2.1.1'
.venv-mcp/bin/python scripts/local-mcp-server.py
```

Leave this terminal running. The SDK serves `http://127.0.0.1:44020/mcp`.
A plain browser GET is not a useful health check for MCP; use the app's
**Connect and browse tools** action to check the protocol connection.

## 2. Start the deterministic provider

If this is your first source run, install the Node dependencies with `npm ci`
before starting either Node server.

```sh
npm run dev:buffered-provider
```

This provider listens at `http://127.0.0.1:4014/v1`. Its `mcp-tool-model`
requests `lookup_record` with `record_id: "sample-42"`, then answers using
the tool result. It needs no API key.

## 3. Start Inference Lens

```sh
INFERENCE_LENS_MCP_SERVERS="$PWD/scripts/local-mcp-catalog.json" npm run dev
```

Open the localhost URL printed by `npm run dev` (normally
`http://localhost:3000`). If you already have a `.env` file with a default
provider, the settings below can be entered as a separate UI connection.
The catalog path is read by the app server, so restart `npm run dev` if you
change that environment variable.

## 4. Exercise the UI

1. Configure a connection with endpoint `http://127.0.0.1:4014/v1`, model
   `mcp-tool-model`, and no API key. Select buffered delivery if the UI offers
   a delivery choice. Enable tool capability for this connection if needed.
2. In **Tools → MCP servers**, select **Local Python example** and click
   **Connect and browse tools**. You should see `lookup_record` and its
   `record_id` input schema.
3. Click **Attach to next request** for `lookup_record`. In its **MCP execution**
   controls under the attached tool, select **Local Python example** and click
   **Allow execution; ask each time**.
4. In **Messages**, enter `Look up sample-42.` and click **Run current
   conversation**. The pending tool call should show `lookup_record` with
   `{"record_id":"sample-42"}`. Click **Approve this call** to approve the
   call.
5. The transcript should include `Record sample-42: local MCP result` and
   the provider's follow-up answer containing that same text. The Python
   terminal should print `lookup_record called with 'sample-42'`.

If the pending call shows **Manual** and a blank result box, the tool was
attached without an active MCP execution permission. Stop that run, return to
**Tools → Tools attached to this request**, choose **Allow execution; ask each
time** under `lookup_record`, and start a new run. Connecting and attaching do
not themselves allow execution.

The grant is session scoped. **Run automatically for this tool** is a separate
opt-in in the same controls. Repeated experiments and evaluations do not use
MCP execution permissions yet. This workflow uses the service-hosted web app;
the Tauri app does not have this MCP host integration.
