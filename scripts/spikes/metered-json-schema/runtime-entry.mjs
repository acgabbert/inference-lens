import { evaluate } from './evaluator.mjs';

export function run(tasks) {
  return tasks.map(({ schema, data, options }) => evaluate(schema, data, options));
}
