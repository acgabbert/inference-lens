# Theming

All color lives in `app/globals.css` as CSS custom properties declared once
in `:root`, each holding both a light and a dark value via `light-dark()`:

```css
:root {
  color-scheme: light dark;
  --surface-panel: light-dark(#ffffff, #171f1a);
  --text-primary: light-dark(#17211c, #e4ece7);
  /* ... */
}
```

No component file sets a color. `light-dark()` was chosen over duplicated
`[data-theme="dark"]` or `@media (prefers-color-scheme: dark)` blocks so that
light and dark values sit adjacent and can't drift apart, and so dark mode
ships by following the OS setting with zero JavaScript. `tests/theme-tokens.test.ts`
guards this: it fails the build if any hex/rgb color literal appears outside
the `:root` block, if any `var()` reference has no matching declaration, or
if a `@media (prefers-color-scheme)` block is reintroduced.

Tokens are also registered with Tailwind v4 via `@theme inline` (not plain
`@theme`) so utilities like `bg-surface-panel` would stay theme-aware if ever
used — `inline` is required because plain `@theme` resolves `var()` once at
`:root` and would snapshot the color instead of tracking it live. In
practice the codebase doesn't use Tailwind color utilities; this is just kept
correct for whenever it does.

## The toggle is not free — read this before adding one

The `light-dark()` architecture was chosen specifically so a future manual
Light/Dark/System toggle would cost about one line
(`document.documentElement.style.colorScheme = "dark"`) with no CSS changes.
**That property does not actually hold in this project**, and the reason is
outside our control: it's baked into Tailwind's build pipeline.

`@tailwindcss/postcss` runs Lightning CSS with a hardcoded
`exclude: Features.LightDark` in its transform options
(`@tailwindcss/node`'s `dist/index.js`, confirmed present in both the
project's pinned `4.2.1` and the latest `4.3.3` as of 2026-07 — there is no
config surface to disable it, and a `browserslist` field in `package.json`
has no effect on this specific behavior). The practical result: every
`light-dark(a, b)` in the source gets silently rewritten at build time into

```css
:root {
  --lightningcss-light: initial;
  --lightningcss-dark: ;
  --surface-panel: var(--lightningcss-light, #fff) var(--lightningcss-dark, #171f1a);
}
@media (prefers-color-scheme: dark) {
  :root {
    --lightningcss-light: ;
    --lightningcss-dark: initial;
  }
}
```

This correctly follows the OS theme (verified against the actual production
build output), but it is driven entirely by the `prefers-color-scheme` media
query. It does **not** respond to `document.documentElement.style.colorScheme`
— only native UA chrome (scrollbars, checkboxes, `<select>` popups) does,
because Tailwind still emits a real `color-scheme: light dark` declaration
alongside the polyfilled tokens. So a manual override would flip form-control
chrome but leave every app color token exactly where the OS put it: a
half-switched, inconsistent UI.

### What this means when the toggle work starts

The zero-CSS-change toggle this architecture promised isn't available as
built. Options at that point, roughly in order of how much they preserve the
current structure:

1. **Reintroduce `[data-theme="dark"]` blocks.** Keep the semantic token
   names, but duplicate each token's dark value under a `:root[data-theme="dark"]`
   override instead of inside `light-dark()`, and set `data-theme` on
   `<html>` from JS (persisted via `localStorage`, following the pattern in
   `app/workbench-shell.client.tsx`). This reintroduces the
   drift risk `light-dark()` was chosen to avoid, so keep both values on one
   line per token (`--surface-panel-dark: #171f1a;` next to the light
   declaration, or a script that generates the override block from a single
   source of truth) rather than letting the blocks separate in the file.
2. **Get the token block out of Tailwind's CSS pipeline.** Move `:root`'s
   color tokens into a plain stylesheet that isn't processed by
   `@tailwindcss/postcss` (e.g. a separate `<link>`ed file, or an import
   Tailwind is told to pass through unprocessed), so raw `light-dark()`
   reaches the browser. Keeps the current architecture and its guarantees
   intact, but means maintaining two stylesheet entry points and revisiting
   how `@theme inline` tokens get exposed. Worth re-checking whether a future
   Tailwind release adds a config knob for this before doing it by hand.
3. **Re-check Tailwind upstream.** The hardcoded exclude may not be permanent;
   re-run the check below against whatever version is current before picking
   option 1 or 2.

To re-verify this is still the current behavior before committing to an
approach:

```sh
npm run build
grep -c 'light-dark(' dist/client/assets/*.css   # 0 = still downleveled
grep -c 'lightningcss-light' dist/client/assets/*.css  # >0 = polyfill present
```

If Tailwind ever stops excluding `LightDark`, the first grep will report a
nonzero count and the original one-line toggle plan becomes viable again with
no other changes needed.
