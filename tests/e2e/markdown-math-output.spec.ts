import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

/**
 * The fixture answers `math-output-model` with LaTeX in both delimiter forms.
 * What is being checked is that the delimiters survive: before math was
 * recognized, the escape rule turned `\[ E = mc^2 \]` into `[ E = mc^2 ]` and
 * collapsed the `\\` line break, so the reader could not tell the model had
 * emitted math at all. Nothing here should be laid out as a formula.
 */
test("LaTeX in model output renders as verbatim source, not stripped delimiters", async ({
  page,
}) => {
  await seedProfile(page, {
    model: "math-output-model",
    favoriteModels: ["math-output-model"],
  });
  await page.goto("/");
  await waitForHydration(page);

  await page.getByLabel("Message 1 content").fill("Show me the identity");
  await page.getByRole("button", { name: "Run request ⌘↵" }).click();

  const output = page.locator(".markdown-body").first();
  await expect(output).toBeVisible();

  // Display math: the TeX line break and both subscripts must come back
  // untouched. These are exactly the characters the inline rules destroy.
  const displayMath = output.locator(".markdown-math");
  await expect(displayMath).toHaveCount(1);
  const displayText = await displayMath.innerText();
  expect(displayText).toContain(String.raw`a_1 &= b_1 \\`);
  expect(displayText).toContain(String.raw`\begin{align}`);
  expect(displayText).toContain(String.raw`\end{align}`);

  // Inline math keeps its subscripts too, and is marked as notation.
  const inlineMath = output.locator(".markdown-inline-math");
  await expect(inlineMath).toHaveCount(1);
  await expect(inlineMath).toHaveText("x_1 + y_2");
  await expect(inlineMath).toHaveAttribute("role", "math");

  // The delimiters are visible rather than eaten. A bare "( x_1 + y_2 )" in
  // the rendered text is the old mangling, so assert it is gone.
  const rendered = await output.innerText();
  expect(rendered).toContain("\\[");
  expect(rendered).toContain("\\]");
  expect(rendered).not.toContain("( x_1 + y_2 )");

  // Nothing was laid out, so no formula markup should have been produced.
  await expect(output.locator("math")).toHaveCount(0);

  // The raw view must still show precisely what the model sent.
  await page.getByRole("tab", { name: "Raw" }).click();
  const raw = await page.locator(".output-scroll").innerText();
  expect(raw).toContain(String.raw`\( x_1 + y_2 \)`);
  expect(raw).toContain(String.raw`a_1 &= b_1 \\`);
});
