import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createProjectFile, createPromptTemplate, appendPromptTemplateRevision, serializeProjectFile, parseProjectFile } from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, PROFILE_STORAGE_KEY, PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, seedProfile, seedProfiles, waitForHydration, importProject, openMode, stubProjectDirectory } from "./support";

// One-off characterization for the review; assertions describe observed behavior,
// not the desired regression contract. Removed after collecting review evidence.
const OUT = "/tmp/inference-lens-ux-evidence";
test.beforeEach(async () => { await mkdir(OUT, { recursive: true }); });
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: "disabled" });
  await writeFile(`${OUT}/${name}.txt`, await page.locator("body").innerText());
}
function projectFixture() {
  let project = createProjectFile({ name: "UX review project", request: { provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{role: "user", content: "Explain the result."}] }, idSuffix: "ux-review", createdAt: "2026-09-20T12:00:00Z" });
  project = createPromptTemplate(project, { name: "Incident triage", messages: [{role: "user", content: "OLD REVISION: Triage {{incident}}."}], variableDefaults: {incident: "timeout"}, idSuffix: "triage", createdAt: "2026-09-20T12:01:00Z" });
  project = appendPromptTemplateRevision(project, { templateId: project.promptTemplates[0]!.id, messages: [{role: "user", content: "LATEST REVISION: Triage {{incident}} carefully."}], variableDefaults: {incident: "latency"}, idSuffix: "triage-2", createdAt: "2026-09-20T12:02:00Z" });
  return project;
}
async function openProject(page: Page, project = projectFixture(), tools = false) {
  await seedProfile(page, { instanceId: "profile-instance-ux", capabilityOverrides: {tools} });
  await page.addInitScript(({key, projectId, requirementId}) => {
    localStorage.setItem(key, JSON.stringify({[projectId]: {[requirementId]: {profileId: "buffered", profileInstanceId: "profile-instance-ux"}}}));
  }, { key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, requirementId: project.defaults.target.connectionRequirementId });
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto("/"); await waitForHydration(page);
  await importProject(page, project, project.name);
}
async function connections(page: Page) {
  await page.getByLabel(/^Run target:/).click();
  await page.getByRole("button", {name: "Manage connections"}).click();
  return page.getByRole("dialog", {name: "Connections", exact: true});
}

test("audit: fresh setup exposes a prompt-creation validation error", async ({page}) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/");
  await expect.poll(() => page.evaluate(key => Boolean(localStorage.getItem(key)), PROFILE_STORAGE_KEY)).toBe(true);
  await capture(page, "01-first-run");
  await page.getByRole("tab", {name: /Prompts/}).click();
  await page.getByRole("button", {name: "New prompt", exact: true}).click();
  await expect.poll(() => errors.join("\n")).toContain("Invalid Inference Lens project");
  await writeFile(`${OUT}/01-fresh-error.json`, JSON.stringify(errors, null, 2));
  await capture(page, "01-fresh-prompt-error");
});

test("audit: prompt draft is lost when changing the request tab", async ({page}) => {
  await openProject(page);
  await page.getByRole("tab", {name: /Prompts/}).click();
  await page.getByLabel("Prompt content", {exact: true}).fill("UNSAVED DRAFT: do not lose this edit");
  await capture(page, "02-unsaved-prompt-before");
  await page.getByRole("tab", {name: /Tools/}).click();
  await page.getByRole("tab", {name: /Prompts/}).click();
  await expect(page.getByLabel("Prompt content", {exact: true})).toHaveValue("LATEST REVISION: Triage {{incident}} carefully.");
  await capture(page, "02-unsaved-prompt-after");
});

for (const failure of ["configuration removed", "status temporarily fails"]) test(`audit: ${failure} duplicates the visible server-default label`, async ({page}) => {
  let configured = true;
  await page.route("**/api/runtime-status", route => !configured && failure === "status temporarily fails" ? route.fulfill({status:503, body:"Temporary status outage"}) : route.fulfill({ json: configured ? {containerized: true, serverDefaultCredentialConfigured: true, endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model"} : {containerized: true, serverDefaultCredentialConfigured: false} }));
  const profiles = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "{}").profiles ?? [], PROFILE_STORAGE_KEY);
  await page.goto("/"); await waitForHydration(page, "Server default");
  await expect.poll(async () => (await profiles()).length).toBe(1);
  configured = false; await page.reload();
  await expect.poll(async () => (await profiles())[0]?.credentialRef ?? "none").toBe("none");
  configured = true; await page.reload();
  await expect.poll(async () => (await profiles()).length).toBe(2);
  const records = await profiles();
  expect(records.map((p: {name: string}) => p.name)).toEqual(["Server default", "Server default"]);
  expect(records[0].id).not.toBe(records[1].id);
  await writeFile(`${OUT}/04-duplicate-${failure}.json`, JSON.stringify(records, null, 2));
  const dismiss = page.getByRole("button", {name: /Dismiss/});
  if (await dismiss.count()) await dismiss.first().click();
  await page.getByLabel(/^Run target:/).click();
  await capture(page, `04-duplicate-${failure}`);
});

test("audit: saving the project does not commit the visible prompt draft", async ({page}) => {
  const project = projectFixture();
  await seedProfile(page);
  await stubProjectDirectory(page, {name:"ux-save.inference-lens", files:{"project.json":serializeProjectFile(project)}});
  await page.goto("/"); await waitForHydration(page);
  await page.getByLabel("Project menu").click(); await page.getByRole("button",{name:"Open project…"}).click();
  await expect(page.locator(".brand")).toContainText(project.name);
  await page.getByRole("tab",{name:/Prompts/}).click();
  await page.getByLabel("Prompt content",{exact:true}).fill("DRAFT THAT CMD-S SHOULD PRESERVE");
  await expect(page.locator(".brand")).not.toContainText("Unsaved");
  await page.getByLabel("Prompt content",{exact:true}).press("ControlOrMeta+s");
  await expect(page.getByRole("list",{name:"Notifications"})).toContainText("Saved “UX review project”");
  await capture(page,"11-project-saved-but-prompt-draft");
  await page.getByRole("tab",{name:/Messages/}).click(); await page.getByRole("tab",{name:/Prompts/}).click();
  await expect(page.getByLabel("Prompt content",{exact:true})).toHaveValue("LATEST REVISION: Triage {{incident}} carefully.");
});

test("audit: copying a library tool to the project also attaches it", async ({page}) => {
  await openProject(page);
  await page.getByRole("tab",{name:/Tools/}).click(); await page.getByRole("button",{name:"Browse local library"}).click();
  const dialog = page.getByRole("dialog",{name:"Local tool library"});
  await dialog.getByRole("button",{name:"+ New library tool"}).click();
  await dialog.getByLabel("Function name",{exact:true}).fill("lookup_account");
  await dialog.getByRole("button",{name:"Copy to project",exact:true}).click();
  await expect(dialog).toContainText("Snapshot attached to the current project draft.");
  await capture(page,"13-library-copy");
  await dialog.getByRole("button",{name:"Close",exact:true}).click();
  await expect(page.getByLabel("Attach to requests")).toBeChecked();
  await expect(page.getByRole("button",{name:/^Run request/})).toBeDisabled();
  await capture(page,"13-copy-attached-and-blocked");
});

test("audit: choosing a second connection leaves the project mapped to the first", async ({page}) => {
  const project = projectFixture();
  await seedProfiles(page, [{id: "a", instanceId: "ia", name: "Local model A", endpoint: BUFFERED_FIXTURE_ENDPOINT}, {id: "b", instanceId: "ib", name: "Local model B", endpoint: "http://127.0.0.1:44015/v1", model: "flaky-test-model"}], "a");
  await page.addInitScript(({key, projectId, requirementId}) => localStorage.setItem(key, JSON.stringify({[projectId]: {[requirementId]: {profileId:"a", profileInstanceId:"ia"}}})), {key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, requirementId: project.defaults.target.connectionRequirementId});
  await page.goto("/"); await waitForHydration(page, "Local model A"); await importProject(page, project, project.name);
  await page.getByLabel(/^Run target:/).click(); await page.getByRole("button", {name: /Local model B/}).click();
  await expect(page.getByRole("button", {name: /^Run request/})).toBeDisabled();
  await capture(page, "05-selected-but-blocked");
  await connections(page); await capture(page, "05-connections-and-mappings");
});

test("audit: review tool configuration and manual continuation with a mock", async ({page}) => {
  const base = projectFixture();
  const project = parseProjectFile({...base, tools: [{id: "tool_weather", name: "get_weather", description: "Look up current weather", inputSchema: {type: "object", properties: {city: {type: "string"}}, required: ["city"]}}], toolMocks: [{id: "tool-mock_weather", toolId: "tool_weather", name: "Sunny mock", enabled: true, match: {kind: "always"}, result: {content: [{type: "text", text: "72 degrees and clear"}]}}], defaults: {...base.defaults, target: {...base.defaults.target, model: "tool-calling-model"}, enabledToolIds: ["tool_weather"]}});
  await openProject(page, project, true);
  await page.getByRole("tab", {name: /Tools/}).click(); await capture(page, "06-tool-configuration");
  await page.getByRole("button", {name: "Browse local library"}).click(); await capture(page, "06-tool-library");
  await page.getByRole("dialog", {name: "Local tool library"}).getByRole("button", {name: "Close", exact: true}).click();
  await page.getByRole("button", {name: /^Run request/}).click();
  await expect(page.locator(".tool-call-card textarea")).toHaveValue("72 degrees and clear");
  await capture(page, "06-tool-paused-with-mock");
  await page.getByRole("button", {name: "Supply results and continue"}).click();
  await expect(page.locator(".transcript-list")).toContainText("Chicago report: 72 degrees and clear");
  await capture(page, "06-tool-completed");
  await openMode(page, "Runs"); await expect(page.getByText("No results open", {exact:true})).toBeVisible();
  await capture(page, "07-runs-after-completed-run");
});

test("audit: menus ignore Escape and the library modal does not receive focus", async ({page}) => {
  await openProject(page);
  await page.getByLabel("Project menu").click(); await page.keyboard.press("Escape");
  await expect(page.locator("details.project-menu")).toHaveAttribute("open", "");
  await page.getByLabel("Run data menu").click();
  await capture(page, "08-overlapping-menus");
  await page.getByLabel("Run data menu").click(); await page.getByLabel("Project menu").click();
  await page.getByRole("tab", {name: /Tools/}).click(); await page.getByRole("button", {name: "Browse local library"}).click();
  const focus = await page.evaluate(() => ({tag:document.activeElement?.tagName, text:document.activeElement?.textContent, insideDialog: Boolean(document.activeElement?.closest('[role="dialog"]'))}));
  expect(focus.insideDialog).toBe(false);
  await writeFile(`${OUT}/08-modal-focus.json`, JSON.stringify(focus, null, 2));
});

test("audit: layout and evaluation overview at desktop and narrow widths", async ({page}) => {
  const base = projectFixture();
  const project = parseProjectFile({...base, evaluationSuites: [{id:"evaluation-suite_audit", name:"Triage checks", input:{kind:"conversation-revision", conversationRevisionId:base.defaults.conversationRevisionId}, execution:{target:base.defaults.target, responseMode:"buffered", options:{}, repetitions:1, toolIds:[]}, variants:[{id:"evaluation-variant_baseline", name:"Baseline", overrides:{}}], inputBindings:[], cases:[{id:"evaluation-case_smoke", name:"Simple response", values:{}, checks:[{checkId:"check_four", kind:"contains", value:"4"}]}]}]});
  await seedProfile(page, {instanceId:"profile-instance-ux"});
  await page.addInitScript(({key, id, req}) => localStorage.setItem(key, JSON.stringify({[id]:{[req]:{profileId:"buffered",profileInstanceId:"profile-instance-ux"}}})), {key:PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,id:project.projectId,req:project.defaults.target.connectionRequirementId});
  await stubProjectDirectory(page, {name:"ux-review.inference-lens",files:{"project.json":serializeProjectFile(project)},directories:["traces","experiments"]});
  await page.goto("/"); await waitForHydration(page);
  await page.getByLabel("Project menu").click(); await page.getByRole("button", {name:"Open project…"}).click(); await expect(page.locator(".brand")).toContainText(project.name);
  for (const width of [1440, 1280, 880, 390, 320]) {
    await page.setViewportSize({width,height:900});
    await openMode(page,"Compose"); await page.getByRole("tab",{name:/Prompts/}).click();
    await capture(page, `09-prompts-${width}`);
    await openMode(page,"Evaluations"); await capture(page,`09-evaluations-${width}`);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole("button",{name:/^Start evaluation/}).click();
  await capture(page,"10-evaluation-preflight");
  const dialog = page.getByRole("dialog");
  await writeFile(`${OUT}/10-dialog-buttons.txt`, (await dialog.getByRole("button").allTextContents()).join("\n"));
  await dialog.getByRole("button",{name:/^Start/}).click();
  await expect(page.getByRole("region", {name:"Evaluation results",exact:true})).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await capture(page,"10-evaluation-results");
  await page.emulateMedia({colorScheme:"dark"}); await capture(page,"10-evaluation-results-dark");
});
