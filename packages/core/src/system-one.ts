import type {
  DecisionAnswer,
  DecisionProtocolAdapter,
  DecisionProviderInput,
  DecisionQuestion,
  DecisionResult,
} from "./decision.ts";
import { ProviderProtocolError, providerRequestUrl } from "./provider-protocols.ts";
import type { JsonObject, JsonValue, RunTokenUsage } from "./run-kernel/types.ts";

/**
 * The System One wire format at `<base>/systemone`, as served by TypeSafe and
 * the implementations that adopted it (OpenRouter, DigitalOcean, Databricks,
 * llama.cpp, Ollama). They share the `state` / `questions` / `answers` /
 * `usage` core; vendor extras such as `id`, `provider`, and `usage.cost` are
 * left to the raw evidence.
 */

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function fail(questionId: string, problem: string): never {
  throw new ProviderProtocolError(`Answer to "${questionId}" ${problem}.`);
}

function optionalConfidence(questionId: string, answer: JsonObject): { confidence?: number } {
  if (answer.confidence === undefined) return {};
  if (!isProbability(answer.confidence)) {
    fail(questionId, "has a confidence that is not a probability");
  }
  return { confidence: answer.confidence };
}

/**
 * At least one probability, keyed only by `allowed`, each in [0, 1]. Reported
 * values are kept as sent: captured servers round them, so they need not sum
 * to exactly 1.
 */
function probabilities(
  questionId: string,
  value: unknown,
  allowed: ReadonlySet<string>,
  describe: (key: string) => string,
): Record<string, number> {
  if (!isObject(value) || Object.keys(value).length === 0) {
    fail(questionId, "has no probabilities");
  }
  for (const [key, probability] of Object.entries(value)) {
    if (!allowed.has(key)) fail(questionId, `has a probability for ${describe(key)}`);
    if (!isProbability(probability)) {
      fail(questionId, `has probabilities outside [0, 1] (${key})`);
    }
  }
  return value as Record<string, number>;
}

function normalizeAnswer(
  questionId: string,
  question: DecisionQuestion,
  answer: JsonValue,
): DecisionAnswer {
  if (!isObject(answer)) fail(questionId, "is not an object");
  if (answer.type !== question.type) {
    fail(
      questionId,
      `is of type ${JSON.stringify(answer.type)} but the question is ${question.type}`,
    );
  }

  switch (question.type) {
    case "choice": {
      const options = new Set(Object.keys(question.criteria));
      if (typeof answer.choice !== "string" || !options.has(answer.choice)) {
        fail(questionId, `chose ${JSON.stringify(answer.choice)}, which is not an option`);
      }
      return {
        type: "choice",
        choice: answer.choice,
        probabilities: probabilities(
          questionId,
          answer.probabilities,
          options,
          (key) => `${JSON.stringify(key)}, which is not an option`,
        ),
        ...optionalConfidence(questionId, answer),
      };
    }
    case "score": {
      const top = question.criteria.length - 1;
      const levels = new Set(question.criteria.map((_, level) => String(level)));
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > top
      ) {
        fail(questionId, `has a score outside the level scale 0–${top}`);
      }
      if (answer.legend !== undefined && !isObject(answer.legend)) {
        fail(questionId, "has a legend that is not an object");
      }
      return {
        type: "score",
        score: answer.score,
        probabilities: probabilities(
          questionId,
          answer.probabilities,
          levels,
          (key) => `${JSON.stringify(key)}, which is not a level number`,
        ),
        ...(answer.legend === undefined ? {} : { legend: answer.legend }),
        ...optionalConfidence(questionId, answer),
      };
    }
    case "noul": {
      if (!isProbability(answer.noul)) fail(questionId, "has a noul that is not a probability");
      return { type: "noul", noul: answer.noul };
    }
  }
  // A box question (D8) or any other type outside the contract reaches here
  // only from unvalidated input; OpenRouter answers box without the image header.
  return fail(questionId, `is of type ${JSON.stringify(answer.type)}, which is not supported`);
}

function normalizedUsage(value: unknown): RunTokenUsage | undefined {
  if (!isObject(value)) return undefined;
  const count = (field: JsonValue | undefined) =>
    typeof field === "number" && Number.isInteger(field) && field >= 0 ? field : undefined;
  const input = count(value.input_tokens);
  const output = count(value.output_tokens);
  const usage: RunTokenUsage = {};
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (input !== undefined && output !== undefined) usage.totalTokens = input + output;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function normalizeSystemOneResponse(
  input: DecisionProviderInput,
  raw: string,
): DecisionResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ProviderProtocolError("Provider returned invalid JSON for a decision response.");
  }
  if (!isObject(body)) {
    throw new ProviderProtocolError("Provider decision response is not a JSON object.");
  }
  if (!isObject(body.answers)) {
    throw new ProviderProtocolError("Provider decision response did not include answers.");
  }
  if (body.model !== undefined && typeof body.model !== "string") {
    throw new ProviderProtocolError("Provider decision response has a model that is not a string.");
  }

  const { questions } = input.decision;
  for (const questionId of Object.keys(body.answers)) {
    if (!Object.hasOwn(questions, questionId)) fail(questionId, "is for a question that was not asked");
  }
  const answers: Record<string, DecisionAnswer> = {};
  // Authored question order, whatever order the server answered in. Ids are
  // caller-chosen, so each is defined as an own key: assigning `__proto__`
  // would set the prototype instead.
  for (const [questionId, question] of Object.entries(questions)) {
    if (!Object.hasOwn(body.answers, questionId)) {
      throw new ProviderProtocolError(`Question "${questionId}" has no answer.`);
    }
    Object.defineProperty(answers, questionId, {
      value: normalizeAnswer(questionId, question, body.answers[questionId]!),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const usage = normalizedUsage(body.usage);
  return {
    ...(body.model === undefined ? {} : { model: body.model }),
    answers,
    ...(usage ? { usage } : {}),
  };
}

/** `path: message` lines from a list of issues, or undefined if none has a message. */
function issueLines(
  issues: unknown[],
  messageKey: string,
  pathKey: string,
): string | undefined {
  const lines = issues.flatMap((item) => {
    if (!isObject(item) || typeof item[messageKey] !== "string") return [];
    const path = item[pathKey];
    const location = Array.isArray(path) ? path.map(String).join(".") : "";
    return [location ? `${location}: ${item[messageKey]}` : item[messageKey]];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * OpenRouter's `error.message` can itself be encoded: its own validation
 * sends a JSON zod issue list (`{path, message}`), and an upstream TypeSafe
 * error is relayed as `HTTP 422: ` plus the FastAPI body.
 */
function openRouterMessage(message: string): string {
  const relayed = /^HTTP \d{3}: (\{[\s\S]*\})$/.exec(message);
  if (relayed) return systemOneErrorMessage(relayed[1]!) ?? message;
  if (!message.startsWith("[")) return message;
  try {
    const issues: unknown = JSON.parse(message);
    if (Array.isArray(issues)) return issueLines(issues, "message", "path") ?? message;
  } catch {
    // Not encoded after all.
  }
  return message;
}

/**
 * TypeSafe and Databricks answer validation failures FastAPI-style (`detail`
 * as a list of `{loc, msg}`, or a string); OpenRouter wraps every error in
 * `{error: {message}}`; Ollama sends `{error: "…"}`.
 */
function systemOneErrorMessage(raw: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(body)) return undefined;

  if (typeof body.detail === "string" && body.detail) return body.detail;
  if (Array.isArray(body.detail)) return issueLines(body.detail, "msg", "loc");
  if (typeof body.error === "string" && body.error) return body.error;
  if (isObject(body.error) && typeof body.error.message === "string" && body.error.message) {
    return openRouterMessage(body.error.message);
  }
  return undefined;
}

export const systemOneAdapter: DecisionProtocolAdapter = {
  protocol: "systemone",
  buildRequest({ target, decision }) {
    return {
      url: providerRequestUrl(target.endpoint, target.protocol),
      body: {
        model: target.model,
        state: decision.state,
        questions: decision.questions as JsonObject,
      },
    };
  },
  normalizeResponse: normalizeSystemOneResponse,
  errorMessage: systemOneErrorMessage,
};
