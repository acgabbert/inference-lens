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
.venv-mcp/bin/python -m pip install -r scripts/requirements-mcp.txt
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
3. Select `lookup_record`. Leave **Keep attached in this tab** and
   **Ask before running** selected, then click **Attach selected (1)**.
   The attachment creates permission for the discovered server.
4. In **Messages**, enter `Look up sample-42.` and click **Run current
   conversation**. The pending tool call should show `lookup_record` with
   `{"record_id":"sample-42"}`. Click **Approve this call** to approve the
   call.
5. The transcript should include `Record sample-42: local MCP result` and
   the provider's follow-up answer containing that same text. The Python
   terminal should print `lookup_record called with 'sample-42'`.

If the pending call shows **Manual** and a blank result box, the tool was
attached without an active MCP execution permission. Stop that run, return to
**Tools → Tools attached to this request**, choose **Ask before running**
under `lookup_record`, and start a new run. Connecting alone does not allow
execution; attachment requests permission according to the selected mode.

The grant stays on this device until you revoke it (choose **Manual
results**). **Run automatically** is a separate opt-in in the same controls.
Repeated experiments and evaluations also use the grant: their confirmation
approves every call the batch makes, whichever mode is chosen. This workflow
uses the service-hosted web app; the Tauri app does not have this MCP host
integration.

## 5. Check cancellation and connection loss

Restart the Python server after updating the script. Select `mcp-slow-model`
on the same buffered provider connection, keeping `lookup_record` attached and
allowed with **Ask each time**. Start a fresh conversation with `Look up slow.`
The provider deterministically requests `{"record_id":"slow"}`; the Python
tool waits 60 seconds before returning. The example catalog allows 120 seconds
per call so you can interrupt it before the host timeout.

Approve the call and click **Supply results and continue** if shown. Wait until
the Python terminal prints `Waiting 60 seconds` before taking either action:

- **Cancellation:** stop the run in Inference Lens. Check that the run becomes
  cancelled, no successful tool result or model continuation appears, and you
  can start a new run. The Python terminal logs cancellation if it reaches the
  server task; a cancelled app run does not itself prove remote work stopped.
- **Connection loss:** in a separate run, kill only this example server from
  another terminal with `kill -KILL <PID>`, using the PID it prints at startup.
  This deliberately breaks the live connection; Ctrl-C can instead wait for
  graceful shutdown. Check that execution fails, no result is fabricated, and
  you can type a manual result and continue. Record whether the app reports
  connection failure or only reaches its timeout; a timeout alone does not
  establish prompt connection-loss handling. Restart the Python server afterward.

Return to `mcp-tool-model` for the immediate `sample-42` happy path. These
checks are also automated: `tests/e2e/mcp-interruption.spec.ts` covers them
against the Node fixture, and the [Python browser lane](../tests/e2e/README.md#python-mcp-lane)
covers the protocol version and a real `kill -KILL` against this server. This
walkthrough remains for trying the workflow by hand.
