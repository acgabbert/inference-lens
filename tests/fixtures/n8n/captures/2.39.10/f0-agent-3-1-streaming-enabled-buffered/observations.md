# F0: streaming enabled, actual buffered request

Execution captured 2026-10-25 on operator-reported n8n 2.39.10, Agent 3.1,
OpenAI Chat Model 1.2, Structured Output Parser 1.3. The Manual Trigger execution
succeeded with the baseline formatter payload. The execution snapshot has
options.enableStreaming true, and Agent tracing records streaming enabled, but
the actual provider request has stream false. There was one received/accepted
request, no continuation, and no ordinary tool run.

This is buffered evidence only. It must not be counted as streamed execution
coverage. The operator explicitly excluded streaming and Open Chat from this
implementation scope after this observation. No streaming-trigger recipe is
required for the capture slice. Exact raw/projected hashes are in manifest.json.
