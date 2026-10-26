/**
 * The overrides a pinned decision request keeps after an edit in Compose.
 *
 * Compose edits effective values (pinned defaults merged with overrides). A
 * variable stays overridden once it is, even when its value matches the
 * default again, so a later default change cannot silently replace it. A
 * value that differs from the effective one becomes an override; values for
 * variables the pinned revision does not declare are dropped.
 */
export function decisionTemplateUseOverrides(input: {
  variables: readonly string[];
  effectiveValues: Readonly<Record<string, string>>;
  existingOverrides: Readonly<Record<string, string>>;
  values: Readonly<Record<string, string>>;
}): Record<string, string> {
  return Object.fromEntries(
    input.variables.flatMap((name) => {
      if (!Object.hasOwn(input.values, name)) return [];
      const value = input.values[name]!;
      const overridden =
        Object.hasOwn(input.existingOverrides, name) || value !== input.effectiveValues[name];
      return overridden ? [[name, value]] : [];
    }),
  );
}
