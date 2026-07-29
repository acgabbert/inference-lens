export interface StableJsonOptions {
  /**
   * Keys present in this map sort by their numeric rank before unranked keys.
   * Unranked keys, and keys with equal ranks, sort lexically.
   */
  preferredKeyOrder?: ReadonlyMap<string, number>;
}

/**
 * Recursively produces a JSON-compatible value with deterministic object key
 * order. Arrays retain their authored order. Undefined object fields are
 * omitted, matching JSON.stringify's object semantics.
 */
export function stableJsonValue(
  value: unknown,
  options: StableJsonOptions = {},
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item, options));
  }
  if (!value || typeof value !== "object") return value;

  const order = options.preferredKeyOrder;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, candidate]) => candidate !== undefined)
      .sort(([left], [right]) => {
        const leftOrder = order?.get(left);
        const rightOrder = order?.get(right);
        if (leftOrder !== undefined || rightOrder !== undefined) {
          const ranked =
            (leftOrder ?? Number.MAX_SAFE_INTEGER) -
            (rightOrder ?? Number.MAX_SAFE_INTEGER);
          if (ranked !== 0) return ranked;
        }
        return left.localeCompare(right);
      })
      .map(([key, item]) => [key, stableJsonValue(item, options)]),
  );
}
