/**
 * Keys whose value is authored data where key order is itself meaning, not
 * incidental shape. A tool's input schema is serialized verbatim into the
 * provider request, so the order its properties are declared in is the order
 * the model reads them in. Canonicalizing that order would silently rewrite an
 * authored request, so these subtrees keep the order they were written in.
 *
 * This is a default rather than an opt-in because every writer and every
 * equality check has to agree. If serialization preserved order but the
 * project-equality check sorted, reordering a tool's parameters would not even
 * register as an unsaved change.
 */
export const ORDER_SENSITIVE_KEYS: ReadonlySet<string> = new Set(["inputSchema"]);

export interface StableJsonOptions {
  /**
   * Keys present in this map sort by their numeric rank before unranked keys.
   * Unranked keys, and keys with equal ranks, sort lexically.
   */
  preferredKeyOrder?: ReadonlyMap<string, number>;
  /**
   * Values under these keys retain their authored key order, recursively.
   * Defaults to {@link ORDER_SENSITIVE_KEYS}; pass an empty set to canonicalize
   * every key.
   */
  orderSensitiveKeys?: ReadonlySet<string>;
}

/**
 * Recursively produces a JSON-compatible value with deterministic object key
 * order. Arrays retain their authored order. Undefined object fields are
 * omitted, matching JSON.stringify's object semantics.
 *
 * Subtrees reached through an order-sensitive key keep their authored key
 * order instead of being sorted. They are still walked, so undefined fields are
 * dropped there too and the result stays JSON-compatible.
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
  const orderSensitive = options.orderSensitiveKeys ?? ORDER_SENSITIVE_KEYS;
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
      .map(([key, item]) => [
        key,
        orderSensitive.has(key)
          ? authoredOrderJsonValue(item)
          : stableJsonValue(item, options),
      ]),
  );
}

/**
 * The order-preserving counterpart of {@link stableJsonValue}: drops undefined
 * object fields without reordering anything.
 */
function authoredOrderJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(authoredOrderJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, candidate]) => candidate !== undefined)
      .map(([key, item]) => [key, authoredOrderJsonValue(item)]),
  );
}
