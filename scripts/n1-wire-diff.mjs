import { isDeepStrictEqual } from "node:util";

// Evidence-only JSON diff. Never normalize names, schemas, argument strings or
// result text: any of those could change what the model sees. Object key order
// is insignificant; array order and absent versus null remain significant.
export function wireDifferences(reference, actual, pointer = "") {
  if (isDeepStrictEqual(reference, actual)) return [];
  const object = (value) => value !== null && typeof value === "object";
  if (object(reference) && object(actual) && Array.isArray(reference) === Array.isArray(actual)) {
    const differences = [];
    for (const key of new Set([...Object.keys(reference), ...Object.keys(actual)])) {
      const next = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (!Object.hasOwn(reference, key) || !Object.hasOwn(actual, key)) {
        differences.push({ path: next,
          reference: Object.hasOwn(reference, key) ? { present: true, value: reference[key] } : { present: false },
          actual: Object.hasOwn(actual, key) ? { present: true, value: actual[key] } : { present: false } });
      } else differences.push(...wireDifferences(reference[key], actual[key], next));
    }
    return differences;
  }
  return [{ path: pointer, reference: { present: true, value: reference }, actual: { present: true, value: actual } }];
}
