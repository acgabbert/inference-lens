import { z } from "zod";

/**
 * Zod records omit __proto__. Template variable maps allow that name, so
 * validate and restore it as an own data property without invoking its setter.
 * Other keys retain the ordinary record validation and diagnostic paths.
 */
export function ownKeyRecord<Value>(
  keySchema: z.ZodType<string>,
  valueSchema: z.ZodType<Value>,
): z.ZodType<Record<string, Value>> {
  const recordSchema = z.record(keySchema, valueSchema);
  return z.unknown().transform((input, context) => {
    const parsed = recordSchema.safeParse(input);
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => context.addIssue({ ...issue }));
      return z.NEVER;
    }
    if (input && typeof input === "object" && Object.hasOwn(input, "__proto__")) {
      const key = keySchema.safeParse("__proto__");
      const value = valueSchema.safeParse((input as Record<string, unknown>).__proto__);
      if (!key.success || !value.success) {
        for (const result of [key, value]) {
          if (!result.success) result.error.issues.forEach((issue) =>
            context.addIssue({ ...issue, path: ["__proto__", ...issue.path] }),
          );
        }
        return z.NEVER;
      }
      Object.defineProperty(parsed.data, key.data, {
        value: value.data, enumerable: true, configurable: true, writable: true,
      });
    }
    return parsed.data;
  });
}
