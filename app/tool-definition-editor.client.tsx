"use client";

import { useId, useState } from "react";

import type {
  JsonObject,
  JsonValue,
} from "../packages/core/src/run-kernel";
import {
  TOOL_NAME_REQUIREMENT,
  isValidToolName,
} from "../packages/core/src/tool-name";

export interface EditableToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

interface ToolDefinitionEditorProps {
  value: EditableToolDefinition;
  onChange(value: EditableToolDefinition): void;
  onSchemaValidityChange?(valid: boolean): void;
}

const schemaTypes = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
] as const;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function schemaObject(value: JsonValue | undefined): JsonObject {
  return isObject(value) ? value : {};
}

function schemaType(schema: JsonObject): string {
  return typeof schema.type === "string" ? schema.type : "string";
}

function supportsStructuredType(schema: JsonObject): boolean {
  return (
    schema.type === undefined ||
    (typeof schema.type === "string" &&
      schemaTypes.includes(schema.type as (typeof schemaTypes)[number]))
  );
}

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseValue(value: string): JsonValue {
  if (!value.trim()) return "";
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function withOptionalValue(
  schema: JsonObject,
  key: string,
  text: string,
): JsonObject {
  const next = { ...schema };
  if (text === "") {
    delete next[key];
  } else {
    next[key] = parseValue(text);
  }
  return next;
}

function EnumEditor({
  schema,
  onChange,
}: {
  schema: JsonObject;
  onChange(schema: JsonObject): void;
}) {
  const values = Array.isArray(schema.enum) ? schema.enum : [];

  function updateEnum(next: JsonValue[]): void {
    const updated = { ...schema };
    if (next.length === 0) delete updated.enum;
    else updated.enum = next;
    onChange(updated);
  }

  return (
    <div className="schema-enum-editor">
      <div className="schema-subheading">
        <span>Allowed values</span>
        <button
          className="text-button"
          type="button"
          onClick={() => updateEnum([...values, ""])}
        >
          + Add value
        </button>
      </div>
      {values.map((value, index) => (
        <div className="schema-enum-row" key={index}>
          <input
            aria-label={`Allowed value ${index + 1}`}
            value={displayValue(value)}
            onChange={(event) =>
              updateEnum(
                values.map((item, position) =>
                  position === index ? parseValue(event.target.value) : item,
                ),
              )
            }
            spellCheck={false}
          />
          <button
            className="remove-button"
            type="button"
            onClick={() =>
              updateEnum(values.filter((_, position) => position !== index))
            }
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

function SchemaNode({
  schema,
  onChange,
  depth = 0,
  showControls = true,
}: {
  schema: JsonObject;
  onChange(schema: JsonObject): void;
  depth?: number;
  showControls?: boolean;
}) {
  const type = schemaType(schema);
  const properties = schemaObject(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];

  if (!supportsStructuredType(schema)) {
    return (
      <div className="schema-unsupported">
        This schema uses a union or custom type. Edit it in Advanced JSON.
      </div>
    );
  }

  function updateType(nextType: string): void {
    const next: JsonObject = { ...schema, type: nextType };
    if (nextType === "object" && !isObject(next.properties)) {
      next.properties = {};
      if (next.additionalProperties === undefined) {
        next.additionalProperties = false;
      }
    }
    if (nextType === "array" && !isObject(next.items)) next.items = {};
    onChange(next);
  }

  function updateProperty(
    name: string,
    nextName: string,
    nextSchema: JsonValue,
  ): void {
    if (nextName !== name && Object.hasOwn(properties, nextName)) return;
    const nextProperties: JsonObject = {};
    Object.entries(properties).forEach(([propertyName, propertySchema]) => {
      nextProperties[propertyName === name ? nextName : propertyName] =
        propertyName === name ? nextSchema : propertySchema;
    });
    const nextRequired = required.map((item) =>
      item === name ? nextName : item,
    );
    onChange({
      ...schema,
      properties: nextProperties,
      ...(nextRequired.length > 0 ? { required: nextRequired } : {}),
    });
  }

  function removeProperty(name: string): void {
    const nextProperties = Object.fromEntries(
      Object.entries(properties).filter(([propertyName]) => propertyName !== name),
    );
    const nextRequired = required.filter((item) => item !== name);
    const next: JsonObject = { ...schema, properties: nextProperties };
    if (nextRequired.length > 0) next.required = nextRequired;
    else delete next.required;
    onChange(next);
  }

  function setRequired(name: string, checked: boolean): void {
    const nextRequired = checked
      ? [...new Set([...required, name])]
      : required.filter((item) => item !== name);
    const next = { ...schema };
    if (nextRequired.length > 0) next.required = nextRequired;
    else delete next.required;
    onChange(next);
  }

  function addProperty(): void {
    let suffix = Object.keys(properties).length + 1;
    let name = `parameter_${suffix}`;
    while (Object.hasOwn(properties, name)) {
      suffix += 1;
      name = `parameter_${suffix}`;
    }
    onChange({
      ...schema,
      type: "object",
      properties: {
        ...properties,
        [name]: { type: "string", description: "" },
      },
    });
  }

  return (
    <div className={`schema-node schema-depth-${Math.min(depth, 3)}`}>
      {depth > 0 && showControls && (
        <div className="schema-node-controls">
          <label>
            Type
            <select value={type} onChange={(event) => updateType(event.target.value)}>
              {schemaTypes.map((option) => (
                <option value={option} key={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label>
            Description
            <input
              value={typeof schema.description === "string" ? schema.description : ""}
              onChange={(event) =>
                onChange({ ...schema, description: event.target.value })
              }
            />
          </label>
          <label>
            Default
            <input
              value={displayValue(schema.default)}
              onChange={(event) =>
                onChange(withOptionalValue(schema, "default", event.target.value))
              }
              placeholder="Optional JSON value"
              spellCheck={false}
            />
          </label>
        </div>
      )}

      {type === "object" && (
        <div className="schema-object-editor">
          <div className="schema-subheading">
            <span>{depth === 0 ? "Parameters" : "Object properties"}</span>
            <button className="text-button" type="button" onClick={addProperty}>
              + Add parameter
            </button>
          </div>
          {Object.entries(properties).length === 0 ? (
            <p className="schema-empty">No parameters yet.</p>
          ) : (
            Object.entries(properties).map(([name, value], propertyIndex) => {
              if (!isObject(value) || !supportsStructuredType(value)) {
                return (
                  <div
                    className="schema-property"
                    key={`property-${propertyIndex}`}
                  >
                    <div className="schema-property-row schema-property-unsupported">
                      <label>
                        Name
                        <input
                          value={name}
                          onChange={(event) =>
                            updateProperty(name, event.target.value, value)
                          }
                          spellCheck={false}
                        />
                      </label>
                      <p>
                        Boolean, union, or custom schema. Use Advanced JSON to
                        edit its definition.
                      </p>
                      <label className="schema-required">
                        <span>Required</span>
                        <input
                          type="checkbox"
                          checked={required.includes(name)}
                          onChange={(event) =>
                            setRequired(name, event.target.checked)
                          }
                        />
                      </label>
                      <button
                        className="remove-button schema-property-remove"
                        type="button"
                        onClick={() => removeProperty(name)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              }
              const propertySchema = schemaObject(value);
              const childType = schemaType(propertySchema);
              return (
                <div
                  className="schema-property"
                  key={`property-${propertyIndex}`}
                >
                  <div className="schema-property-row">
                    <label>
                      Name
                      <input
                        value={name}
                        onChange={(event) =>
                          updateProperty(name, event.target.value, propertySchema)
                        }
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      Type
                      <select
                        value={childType}
                        onChange={(event) =>
                          updateProperty(name, name, {
                            ...propertySchema,
                            type: event.target.value,
                            ...(event.target.value === "object" &&
                            !isObject(propertySchema.properties)
                              ? { properties: {}, additionalProperties: false }
                              : {}),
                            ...(event.target.value === "array" &&
                            !isObject(propertySchema.items)
                              ? { items: {} }
                              : {}),
                          })
                        }
                      >
                        {schemaTypes.map((option) => (
                          <option value={option} key={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="schema-required">
                      <span>Required</span>
                      <input
                        type="checkbox"
                        checked={required.includes(name)}
                        onChange={(event) =>
                          setRequired(name, event.target.checked)
                        }
                      />
                    </label>
                    <label>
                      Description
                      <input
                        value={
                          typeof propertySchema.description === "string"
                            ? propertySchema.description
                            : ""
                        }
                        onChange={(event) =>
                          updateProperty(name, name, {
                            ...propertySchema,
                            description: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      Default
                      <input
                        value={displayValue(propertySchema.default)}
                        onChange={(event) =>
                          updateProperty(
                            name,
                            name,
                            withOptionalValue(
                              propertySchema,
                              "default",
                              event.target.value,
                            ),
                          )
                        }
                        spellCheck={false}
                      />
                    </label>
                    <button
                      className="remove-button schema-property-remove"
                      type="button"
                      onClick={() => removeProperty(name)}
                    >
                      Remove
                    </button>
                  </div>
                  {(childType === "object" || childType === "array") && (
                    <SchemaNode
                      depth={depth + 1}
                      schema={propertySchema}
                      showControls={false}
                      onChange={(next) => updateProperty(name, name, next)}
                    />
                  )}
                  <EnumEditor
                    schema={propertySchema}
                    onChange={(next) => updateProperty(name, name, next)}
                  />
                </div>
              );
            })
          )}
        </div>
      )}

      {type === "array" && (
        <div className="schema-array-editor">
          <div className="schema-subheading">
            <span>Array items</span>
          </div>
          {isObject(schema.items) ? (
            <SchemaNode
              depth={depth + 1}
              schema={schema.items}
              onChange={(items) => onChange({ ...schema, items })}
            />
          ) : schema.items === undefined ? (
            <SchemaNode
              depth={depth + 1}
              schema={{}}
              onChange={(items) => onChange({ ...schema, items })}
            />
          ) : (
            <div className="schema-unsupported">
              Boolean array item schema. Edit it in Advanced JSON.
            </div>
          )}
        </div>
      )}

      {depth > 0 && type !== "object" && type !== "array" && (
        <EnumEditor schema={schema} onChange={onChange} />
      )}
    </div>
  );
}

export function ToolDefinitionEditor({
  value,
  onChange,
  onSchemaValidityChange,
}: ToolDefinitionEditorProps) {
  const [tab, setTab] = useState<"builder" | "json">("builder");
  const nameRequirementId = `${useId()}-tool-name-requirement`;
  const nameInvalid = !isValidToolName(value.name);
  const [jsonDraft, setJsonDraft] = useState(() =>
    JSON.stringify(value.inputSchema, null, 2),
  );
  const [jsonError, setJsonError] = useState<string>();

  function openBuilder(): void {
    setTab("builder");
    setJsonError(undefined);
    onSchemaValidityChange?.(true);
  }

  function openJson(): void {
    setJsonDraft(JSON.stringify(value.inputSchema, null, 2));
    setJsonError(undefined);
    setTab("json");
    onSchemaValidityChange?.(true);
  }

  function updateJson(text: string): void {
    setJsonDraft(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The input schema must be a JSON object.");
      }
      setJsonError(undefined);
      onSchemaValidityChange?.(true);
      onChange({ ...value, inputSchema: parsed as JsonObject });
    } catch (error) {
      setJsonError(
        error instanceof Error ? error.message : "The schema is invalid JSON.",
      );
      onSchemaValidityChange?.(false);
    }
  }

  return (
    <div className="definition-editor">
      <div className="tool-fields tool-identity-fields">
        <label>
          Function name
          <input
            aria-invalid={nameInvalid || undefined}
            aria-describedby={nameInvalid ? nameRequirementId : undefined}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            spellCheck={false}
          />
          {nameInvalid && (
            <span className="tool-name-warning" id={nameRequirementId} role="alert">
              {TOOL_NAME_REQUIREMENT}
            </span>
          )}
        </label>
        <label>
          Description
          <textarea
            className="tool-description"
            rows={4}
            value={value.description ?? ""}
            onChange={(event) =>
              onChange({ ...value, description: event.target.value })
            }
          />
        </label>
      </div>
      <div className="schema-tabs" role="tablist" aria-label="Schema editor mode">
        <button
          aria-selected={tab === "builder"}
          className={tab === "builder" ? "active" : ""}
          role="tab"
          type="button"
          onClick={openBuilder}
        >
          Schema builder
        </button>
        <button
          aria-selected={tab === "json"}
          className={tab === "json" ? "active" : ""}
          role="tab"
          type="button"
          onClick={openJson}
        >
          Advanced JSON
        </button>
      </div>
      <div className="schema-editor-body">
        {tab === "builder" ? (
          <SchemaNode
            schema={value.inputSchema}
            onChange={(inputSchema) => onChange({ ...value, inputSchema })}
          />
        ) : (
          <label className="advanced-schema">
            Input JSON Schema
            <textarea
              className="tool-schema"
              value={jsonDraft}
              onChange={(event) => updateJson(event.target.value)}
              spellCheck={false}
            />
            {jsonError && <span className="schema-error">{jsonError}</span>}
          </label>
        )}
      </div>
    </div>
  );
}
