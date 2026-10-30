import assert from "node:assert/strict";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { startHeadlessEvaluation } from "../packages/cli/src/evaluation-run.ts";
import { runCli } from "../packages/cli/src/main.ts";
import { createInProcessTransport } from "../packages/cli/src/transport.ts";
import { parseExperimentPlanJson } from "../packages/core/src/experiment.ts";
import { appendPromptTemplateRevision, parseProjectFile } from "../packages/core/src/project.ts";
import { parseRunTraceJson } from "../packages/core/src/run-trace.ts";
import { headlessProject, writeHeadlessProjectFolder } from "./fixtures/headless/project.ts";
import { LINKED_PATH, LINKED_ROOT, LINKED_TEXT, linkedPromptProject, writeSourceRoot } from "./fixtures/headless/linked-prompt.ts";
import { recordingProvider } from "./fixtures/headless/recording-provider.ts";

const KEY_VARIABLE = "INFERENCE_LENS_CONNECTION_LINKED_DEFAULT_API_KEY";
const CHANGED = "Describe {{ $json.topic }} in detail.";

async function cli(args: string[], environment: Record<string, string> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    environment: { [KEY_VARIABLE]: "sk-linked", ...environment },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function artifacts(directory: string, name: "experiments" | "traces") {
  try {
    return await Promise.all((await readdir(path.join(directory, name))).map(async (fileName) => ({
      fileName,
      contents: await readFile(path.join(directory, name, fileName), "utf8"),
    })));
  } catch {
    return [];
  }
}

function userTexts(provider: Awaited<ReturnType<typeof recordingProvider>>): string[] {
  return provider.requests.flatMap(({ body }) =>
    (body.messages ?? []).filter(({ role }) => role === "user").map(({ content }) => String(content)));
}

async function linkedFolder(endpoint: string, files: Record<string, string> = { [LINKED_PATH]: CHANGED }) {
  const { project, templateId } = await linkedPromptProject({ endpoint });
  const directory = await writeHeadlessProjectFolder(project);
  const root = await writeSourceRoot(files);
  return { project, templateId, directory, root };
}

test("run --prompts-from-files sends the file's text, records it in the plan and traces, and writes no revision", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const { directory, root, templateId } = await linkedFolder(provider.endpoint);
  const projectBefore = await readFile(path.join(directory, "project.json"), "utf8");

  const { code, stdout, stderr } = await cli(["run", directory, "--prompts-from-files", "--source-root", `${LINKED_ROOT}=${root}`, "--json"]);
  assert.equal(stderr, "[1/1] Default · Topic 1 #1: completed\n");
  assert.equal(code, 0);
  assert.deepEqual(userTexts(provider), ["Describe addition in detail."], "the provider received the file's text, not the saved revision's");
  assert.equal(await readFile(path.join(directory, "project.json"), "utf8"), projectBefore, "project.json is never written");

  const summary = JSON.parse(stdout);
  assert.equal(summary.schemaVersion, 1);
  assert.deepEqual(summary.promptSources, [{
    templateId,
    name: "agent",
    sourceRoot: LINKED_ROOT,
    path: LINKED_PATH,
    sourceDigest: summary.promptSources[0].sourceDigest,
    textChanged: true,
    replacedLocalRevisions: false,
  }]);
  assert.match(summary.promptSources[0].sourceDigest, /^[a-f0-9]{64}$/);

  const [planFile] = (await artifacts(directory, "experiments")).filter(({ fileName }) => fileName.endsWith(".plan.json"));
  const plan = parseExperimentPlanJson(planFile!.contents);
  if (plan.kind !== "evaluation") throw new Error("Expected an evaluation plan");
  assert.equal(plan.suite.promptSources?.[0]?.authored.text, CHANGED);
  assert.ok(!planFile!.contents.includes(root), "no host path in the plan");

  // The file changes afterwards; the trace still says what ran and where it came from.
  await writeFile(path.join(root, ...LINKED_PATH.split("/")), "Something else entirely.");
  const [traceFile] = await artifacts(directory, "traces");
  assert.ok(!traceFile!.contents.includes(root), "no host path in the trace");
  const trace = parseRunTraceJson(traceFile!.contents);
  assert.equal(trace.schemaVersion, 10);
  assert.deepEqual(trace.input.templateResolutions[0]!.fileSource, {
    sourceRootName: LINKED_ROOT,
    path: LINKED_PATH,
    sourceDigest: summary.promptSources[0].sourceDigest,
    baseTemplateRevisionId: trace.input.templateResolutions[0]!.templateRevisionId,
  });
  assert.deepEqual(trace.input.templateResolutions[0]!.messages, [{ role: "user", content: "Describe {{topic}} in detail." }]);

  await writeFile(path.join(root, ...LINKED_PATH.split("/")), CHANGED);
  const text = await cli(["run", directory, "--prompts-from-files", "--source-root", `${LINKED_ROOT}=${root}`]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Read 1 prompt from files:\n {2}agent ← prompts\/flows\/agent\.md \(text differs from the pinned revision\)/);
});

test("the evaluation API sends a linked prompt's file text only when asked to read files", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const { directory, root } = await linkedFolder(provider.endpoint);
  const start = (extra: Partial<Parameters<typeof startHeadlessEvaluation>[0]>) => startHeadlessEvaluation({
    projectDirectory: directory,
    environment: { [KEY_VARIABLE]: "sk-linked" },
    transport: createInProcessTransport({ containerized: false }),
    ...extra,
  }).done;
  assert.equal((await start({ promptsFromFiles: true, sourceRoots: new Map([[LINKED_ROOT, root]]) })).exitCode, 0);
  // Ordinary runs never read the file, even with a folder mapped.
  assert.equal((await start({ sourceRoots: new Map([[LINKED_ROOT, root]]) })).exitCode, 0);
  assert.deepEqual(userTexts(provider), ["Describe addition in detail.", "Tell me about addition."]);
});

test("INFERENCE_LENS_SOURCE_ROOTS supplies a root no flag names, and a flag wins for its name", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const { directory, root } = await linkedFolder(provider.endpoint);
  const other = await writeSourceRoot({ [LINKED_PATH]: "From the catalog: {{ $json.topic }}." });
  const catalog = path.join(other, "..", `catalog-${path.basename(other)}.json`);
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, roots: [{ name: LINKED_ROOT, path: other }] }));
  const environment = { INFERENCE_LENS_SOURCE_ROOTS: catalog };

  assert.equal((await cli(["run", directory, "--prompts-from-files"], environment)).code, 0);
  assert.equal((await cli(["run", directory, "--prompts-from-files", "--source-root", `${LINKED_ROOT}=${root}`], environment)).code, 0);
  assert.deepEqual(userTexts(provider), ["From the catalog: addition.", "Describe addition in detail."]);
});

test("flag usage errors exit 2 before anything is read or sent", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const { directory, root } = await linkedFolder(provider.endpoint);
  const cases: Array<[string[], RegExp]> = [
    [["run", directory, "--source-root", `${LINKED_ROOT}=${root}`], /--source-root reads files only with --prompts-from-files/],
    [["run", directory, "--prompts-from-files", "--source-root", `${LINKED_ROOT}=${root}`, "--source-root", `${LINKED_ROOT}=${root}`], /names prompts more than once/],
    [["run", directory, "--prompts-from-files", "--source-root", `other=${root}`], /does not declare a source root named “other”/],
    [["run", directory, "--prompts-from-files", "--source-root", root], /--source-root takes <name>=<path>/],
    [["repeat", directory, "--prompts-from-files"], /Unknown option '--prompts-from-files'/],
    [["drift", directory, "--prompts-from-files"], /Unknown option '--prompts-from-files'/],
  ];
  for (const [args, message] of cases) {
    const { code, stderr } = await cli(args);
    assert.equal(code, 2, args.join(" "));
    assert.match(stderr, message, args.join(" "));
  }
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(await artifacts(directory, "experiments"), []);
});

test("each case the override cannot run is a setup error naming the prompt, with nothing sent or written", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const outside = await writeSourceRoot({ "secret.md": "Outside {{ $json.topic }}." });
  const cases: Array<[string, (root: string) => Promise<void> | void, RegExp, string[]?]> = [
    ["missing", () => {}, /Prompt “agent” \(prompts\/flows\/agent\.md\): prompts\/flows\/agent\.md does not exist\./],
    ["symlink out", async (root) => {
      await symlink(path.join(outside, "secret.md"), path.join(root, "flows", "agent.md"));
    }, /leads outside its source folder/],
    ["too large", async (root) => {
      await writeFile(path.join(root, "flows", "agent.md"), "x".repeat(1_048_577));
    }, /larger than 1 MiB/],
    ["not UTF-8", async (root) => {
      await writeFile(path.join(root, "flows", "agent.md"), Buffer.from([0x54, 0xff, 0xfe]));
    }, /not UTF-8 text/],
    ["an unbound new variable", async (root) => {
      await writeFile(path.join(root, "flows", "agent.md"), "In a {{ $json.tone }} voice, explain {{ $json.topic }}.");
    }, /Prompt “agent” \(prompts\/flows\/agent\.md\): .*"tone"/],
    ["an unmapped root", async (root) => {
      await writeFile(path.join(root, "flows", "agent.md"), CHANGED);
    }, /Prompt “agent” \(prompts\/flows\/agent\.md\): no folder is mapped to source root “prompts”\. Pass --source-root prompts=<path>/, []],
  ];
  for (const [label, prepare, message, flags] of cases) {
    const { directory, root } = await linkedFolder(provider.endpoint, { "flows/.keep.txt": "" });
    await prepare(root);
    const { code, stderr } = await cli(["run", directory, "--prompts-from-files", ...(flags ?? ["--source-root", `${LINKED_ROOT}=${root}`])]);
    assert.equal(code, 2, label);
    assert.match(stderr, message, label);
    assert.ok(!stderr.includes(root), `${label}: no host path in the message`);
    assert.deepEqual(await artifacts(directory, "experiments"), [], label);
  }

  const unlinked = await writeHeadlessProjectFolder(headlessProject({ endpoint: provider.endpoint }));
  const { code, stderr } = await cli(["run", unlinked, "--prompts-from-files"]);
  assert.equal(code, 2);
  assert.match(stderr, /Suite “Arithmetic” uses no linked prompt, so --prompts-from-files has nothing to read\./);
  assert.equal(provider.requests.length, 0);
});

test("a pinned revision that is not the last pull is replaced and reported, not refused", async (t) => {
  const provider = await recordingProvider();
  t.after(provider.close);
  const { project: linked, templateId } = await linkedPromptProject({ endpoint: provider.endpoint });
  const edited = appendPromptTemplateRevision(linked, {
    templateId,
    messages: [{ role: "user", content: "Locally, {{topic}}." }],
    variableDefaults: {},
  });
  const localRevisionId = edited.promptTemplates.find(({ id }) => id === templateId)!.currentRevisionId;
  const repinned = parseProjectFile({
    ...edited,
    conversationRevisions: edited.conversationRevisions.map((revision) => ({
      ...revision,
      items: revision.items.map((item) => item.kind === "template-use" && item.use.templateId === templateId
        ? { ...item, use: { ...item.use, templateRevisionId: localRevisionId } }
        : item),
    })),
  });
  const directory = await writeHeadlessProjectFolder(repinned);
  const root = await writeSourceRoot({ [LINKED_PATH]: LINKED_TEXT });
  const { code, stdout } = await cli(["run", directory, "--prompts-from-files", "--source-root", `${LINKED_ROOT}=${root}`, "--json"]);
  assert.equal(code, 0);
  assert.deepEqual(userTexts(provider), ["Tell me about addition."]);
  const [source] = JSON.parse(stdout).promptSources;
  assert.equal(source.textChanged, true);
  assert.equal(source.replacedLocalRevisions, true);
});

test("drift reports each linked prompt's file and exits 0, 1 or 2", async () => {
  const { project: linked, templateId, directory, root } = await linkedFolder("http://127.0.0.1:9/v1", { [LINKED_PATH]: LINKED_TEXT });
  const flags = ["--source-root", `${LINKED_ROOT}=${root}`];

  const matching = await cli(["drift", directory, ...flags, "--json"]);
  assert.equal(matching.code, 0);
  assert.deepEqual(JSON.parse(matching.stdout), {
    kind: "drift",
    schemaVersion: 1,
    projectDirectory: directory,
    outcome: "matches",
    prompts: [{
      templateId, name: "agent", sourceRoot: LINKED_ROOT, path: LINKED_PATH, state: "matches", localRevisions: false,
    }],
  });
  assert.match((await cli(["drift", directory, ...flags])).stdout, /^All 1 linked prompt file matches its last pull\.\n {2}matches {6}agent ← prompts\/flows\/agent\.md\n$/);

  await writeFile(path.join(root, ...LINKED_PATH.split("/")), CHANGED);
  const changed = await cli(["drift", directory, ...flags, "--json"]);
  assert.equal(changed.code, 1);
  assert.equal(JSON.parse(changed.stdout).outcome, "drift");
  assert.equal(JSON.parse(changed.stdout).prompts[0].state, "file-changed");
  assert.match((await cli(["drift", directory, ...flags])).stdout, /file-changed {1}agent ← prompts\/flows\/agent\.md/);

  await writeFile(path.join(root, ...LINKED_PATH.split("/")), Buffer.from([0xff]));
  const unreadable = JSON.parse((await cli(["drift", directory, ...flags, "--json"])).stdout).prompts[0];
  assert.deepEqual(
    { state: unreadable.state, reason: unreadable.reason, message: unreadable.message },
    { state: "unreadable", reason: "not-utf8", message: "prompts/flows/agent.md is not UTF-8 text." },
  );
  const missingRoot = await writeSourceRoot({ "other.md": "" });
  const missing = await cli(["drift", directory, "--source-root", `${LINKED_ROOT}=${missingRoot}`, "--json"]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).prompts[0].state, "missing");

  // Local revisions are reported but never change the exit code.
  const edited = appendPromptTemplateRevision(linked, {
    templateId,
    messages: [{ role: "user", content: "Locally, {{topic}}." }],
    variableDefaults: {},
  });
  const editedDirectory = await writeHeadlessProjectFolder(edited);
  const editedRoot = await writeSourceRoot({ [LINKED_PATH]: LINKED_TEXT });
  const local = await cli(["drift", editedDirectory, "--source-root", `${LINKED_ROOT}=${editedRoot}`, "--json"]);
  assert.equal(local.code, 0);
  assert.equal(JSON.parse(local.stdout).prompts[0].localRevisions, true);
  assert.match((await cli(["drift", editedDirectory, "--source-root", `${LINKED_ROOT}=${editedRoot}`])).stdout, /local revisions not from the file/);

  // Setup errors: an unmapped root, a project that cannot be read, a broken catalog.
  const unmapped = await cli(["drift", directory]);
  assert.equal(unmapped.code, 2);
  assert.match(unmapped.stderr, /no folder is mapped to source root “prompts”/);
  assert.equal((await cli(["drift", path.join(directory, "nope")])).code, 2);
  const broken = await cli(["drift", directory, ...flags], { INFERENCE_LENS_SOURCE_ROOTS: path.join(root, "missing.json") });
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /INFERENCE_LENS_SOURCE_ROOTS names a catalog that could not be read/);

  // Nothing linked: exit 0, and the output says so.
  const unlinked = await writeHeadlessProjectFolder(headlessProject({ endpoint: "http://127.0.0.1:9/v1" }));
  const none = await cli(["drift", unlinked, "--json"]);
  assert.equal(none.code, 0);
  assert.deepEqual(JSON.parse(none.stdout).prompts, []);
  assert.equal(JSON.parse(none.stdout).outcome, "nothing-linked");
  assert.equal((await cli(["drift", unlinked])).stdout, "No prompts in this project are linked to a source file.\n");
});
