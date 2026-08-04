"use client";

import { useState } from "react";

import type { CommandToolDeclaration } from "../../packages/core/src/command-tool-catalog.ts";
import type { ToolId } from "../../packages/core/src/run-kernel/index.ts";
import type { CommandToolsHandle } from "./use-command-tools.client.ts";

/**
 * The one local-capability consent surface.
 *
 * Two properties matter more than the layout. First, nothing here can name an
 * executable: the list is the operator's catalog, and a tool is bound to an id
 * from it. Second, the grant is a separate act from the selection — the exact
 * command line, its timeout, and how its output will be read are all on screen
 * before the button that allows it. MCP's server consent and per-call approval
 * are meant to be instances of this, not new inventions.
 */

interface CommandToolBindingEditorProps {
  toolId: ToolId;
  toolLabel: string;
  commandTools: CommandToolsHandle;
}

function commandLine(declaration: CommandToolDeclaration): string {
  return [declaration.executable, ...declaration.args].join(" ");
}

function outputSentence(declaration: CommandToolDeclaration): string {
  return declaration.resultFormat === "json"
    ? "Reads a JSON tool result from stdout."
    : "Reads stdout as plain text, so it can never report a tool error.";
}

function unavailableMessage(
  commandTools: CommandToolsHandle,
): string | undefined {
  const { availability } = commandTools;
  switch (availability.kind) {
    case "loading":
      return "Checking what this device can run…";
    case "unsupported-shell":
      return "The desktop app cannot run command tools yet. They are spawned by the local Inference Lens service, which the desktop build does not have.";
    case "unconfigured":
      return `This service runs no command tools. Set ${availability.variable} to a command catalog to declare some.`;
    case "invalid":
      return availability.problem;
    case "unreachable":
      return `The local service could not be asked what it can run: ${availability.message}`;
    case "ready":
      return undefined;
  }
}

export function CommandToolBindingEditor({
  toolId,
  toolLabel,
  commandTools,
}: CommandToolBindingEditorProps) {
  const grant = commandTools.grantFor(toolId);
  const granted = grant
    ? commandTools.commands.find(({ id }) => id === grant.commandId)
    : undefined;
  const [selectedId, setSelectedId] = useState("");
  const selected = commandTools.commands.find(({ id }) => id === selectedId);
  const unavailable = unavailableMessage(commandTools);

  return (
    <div className="tool-fields tool-command-fields">
      <span className="eyebrow">Command tool</span>
      {unavailable ? (
        <p className="tool-command-unavailable">{unavailable}</p>
      ) : grant && granted ? (
        <>
          <p className="tool-command-granted">
            <strong>{granted.label}</strong> answers {toolLabel} on this device.
            <code>{commandLine(granted)}</code>
            <small>
              {outputSentence(granted)} Stops after {granted.timeoutMs}ms.
              Allowed on {grant.grantedAt.slice(0, 10)}.
            </small>
          </p>
          <button
            className="text-button"
            type="button"
            onClick={() => commandTools.revoke(toolId)}
          >
            Stop allowing this command
          </button>
        </>
      ) : (
        <>
          {/*
            A grant whose command the operator has since removed is shown
            rather than dropped: the tool is no longer served, and a run that
            silently fell back to a mock would be the wrong kind of surprise.
          */}
          {grant && (
            <p className="tool-command-missing">
              This tool was allowed to run “{grant.commandId}”, which this
              service no longer declares. It will not run until you allow a
              declared command.
            </p>
          )}
          {/*
            Reachable, configured, and declaring nothing is its own state: an
            empty picker with no explanation reads as a broken feature rather
            than as a catalog nobody has filled in.
          */}
          {commandTools.commands.length === 0 ? (
            <p className="tool-command-unavailable">
              The configured catalog declares no commands.
            </p>
          ) : (
            <label className="tool-command-choice">
              Run a declared command
              <select
                aria-label={`Command tool for ${toolLabel}`}
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                <option value="">Choose a command…</option>
                {commandTools.commands.map((declaration) => (
                  <option key={declaration.id} value={declaration.id}>
                    {declaration.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selected && (
            <>
              <p className="tool-command-preview">
                <code>{commandLine(selected)}</code>
                <small>
                  {selected.description ? `${selected.description} ` : ""}
                  {outputSentence(selected)} Stops after {selected.timeoutMs}ms.
                  Call arguments are written to its stdin; it runs with no
                  shell and without this service’s environment.
                </small>
              </p>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  commandTools.grant(toolId, selected.id);
                  setSelectedId("");
                }}
              >
                Allow {selected.label} to answer {toolLabel}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
