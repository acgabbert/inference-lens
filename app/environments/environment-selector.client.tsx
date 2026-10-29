"use client";

import type { ProjectEnvironment } from "../../packages/core/src/environment";
import type { EnvironmentId } from "../../packages/core/src/run-kernel";
import styles from "./environments.module.css";

interface EnvironmentSelectorProps {
  environments: readonly ProjectEnvironment[];
  selectedId?: EnvironmentId;
  defaultId?: EnvironmentId;
  onSelect(environmentId: EnvironmentId | undefined): void;
  onSetDefault(environmentId: EnvironmentId | undefined): void;
  onManage(): void;
}

/**
 * The session's environment for the next run. Switching it re-renders every
 * template use; only "Use as project default" writes the project.
 */
export function EnvironmentSelector({
  environments,
  selectedId,
  defaultId,
  onSelect,
  onSetDefault,
  onManage,
}: EnvironmentSelectorProps) {
  const isDefault = selectedId === defaultId;
  return (
    <div className={styles.selector}>
      <label>
        Environment
        <select
          value={selectedId ?? ""}
          onChange={(event) => onSelect((event.target.value || undefined) as EnvironmentId | undefined)}
        >
          <option value="">No environment</option>
          {environments.map(({ id, name }) => (
            <option key={id} value={id}>
              {id === defaultId ? `${name} (project default)` : name}
            </option>
          ))}
        </select>
      </label>
      {!isDefault && (
        <button className="text-button" type="button" onClick={() => onSetDefault(selectedId)}>
          {selectedId ? "Use as project default" : "Clear project default"}
        </button>
      )}
      {isDefault && selectedId && <span className={styles.defaultNote}>Project default</span>}
      <button className="text-button" type="button" onClick={onManage}>
        Edit environments…
      </button>
    </div>
  );
}
