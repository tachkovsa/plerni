# ADR-0005 — UI kit + token compiler

- **Status:** Proposed · **Date:** 2026-10-26
- **Issue:** [#19](https://github.com/tachkovsa/plerni/issues/19)
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §1 invariants 5–7 and 10, §9 (frontend), §12 (token lint, fixture gallery), §14 (dependency freshness)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D13** (kit), **D14** (token compiler). **D12** and **D24** bound what the kit is allowed to render for plugins.
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §12 (default-theme discovery); [`../plans/2026-10-13-p0-detailed-implementation-plan.md`](../plans/2026-10-13-p0-detailed-implementation-plan.md) T11
- **Roadmap:** [`../ROADMAP.md`](../ROADMAP.md) — plugin screens stay declarative data until P5; WCAG 2.2 AA is a property of the UI kit, shown on real workflows
- **Number:** Plan §1 and §8 assign 0005 to this record. Listing this directory at writing shows 0001, 0003, 0004, 0006, and 0007. 0002 remains the name the same section assigns to the ORM record.

This record is Proposed. Issue #19 and plan T11 route acceptance to a reviewer other than family β, because family β authored the theme discovery in plan §12. A receipt on the accepting commit moves the status to Accepted. The versions below were read from the npm registry and the vendors' docs on 2026-10-26. They are the candidate line, not a lockfile: the shell does not exist yet, and spec §14 ages routine releases about seven days.

## Context

The shell is a React 19 + Vite SPA. Invariant 7 forbids a bespoke component library: a packaged kit and a packaged icon set, and every visual value a token. Invariant 5 wants that kit to be mainstream. Invariant 8 and the license-audit gate want OSI-approved licenses only. Invariant 10 wants Russian as a first-class locale, with Kazakh and Uzbek next, and a default theme that is credible for a CIS enterprise without being the kit's corporate blue.

D13 chooses Ant Design plus lucide-react. D14 chooses a kit-agnostic compiler: versioned defaults, typed tenant overrides (`schemaVersion` + `revision`), foundation → semantic (including states) → component roles, constrained admin edits, contrast validation, resolved CSS delivered before React mounts, and the same compiler for live preview and publish. Plugins read `--plerni-*` variables only. The kit sits behind an adapter.

Two bounds sit in front of any kit API. Until P5, plugin screens are declarative data — settings, forms, menus, widgets, lists — and the shell renders them (D12, roadmap P2/P5). No plugin JavaScript runs in the host page. D24 leaves the untrusted-UI iframe protocol out of the first version. Interface principles 8–12 (tokens only, stable confirm/cancel order, color never the only signal, real data, one vocabulary) are properties of that renderer, not of plugin code.

Accessibility is WCAG 2.2 Level AA, the W3C Recommendation of 12 December 2024. The spec's "WCAG AA" and the roadmap's "WCAG 2.2 AA" are this bar. Conformance is evidence on our workflows. It is not inferred from the kit. The criteria the kit and the gallery have to show include the ones 2.2 adds on top of 2.1, in particular 2.4.11 Focus Not Obscured (Minimum) and 2.5.8 Target Size (Minimum). Contrast itself is unchanged: 1.4.3 Contrast (Minimum) is 4.5:1 for text (3:1 for large text), with the inactive, decorative, and logotype exceptions; 1.4.11 Non-text Contrast is 3:1 for the parts of a control that identify it and for its states.

Plan §12 records the theme discovery as input, not as a closed brand decision. Family β offered three directions. The recommended direction is Scholarly Plum, light primary `#6E3F73`. The alternatives are Deep Teal `#0F766E` and Burnished Copper `#A44727`. The maintainer has not locked a brand. This record keeps the architecture decided and the palette pending, and it checks the three hex values far enough to say what a dark theme is not allowed to do with them.

## Options

### UI kits

Three current kits, scored against the invariants above. Versions are npm `latest` on 2026-10-26.

| | Ant Design `6.6.8` | Mantine `@mantine/core` `9.7.4` | MUI `@mui/material` `9.5.0` |
|---|---|---|---|
| Published | 2026-10-26 | 2026-10-25 | 2026-10-09 |
| License | MIT | MIT | MIT for Material. `@mui/x-data-grid` `9.16.0` (2026-10-20) is MIT. `@mui/x-data-grid-pro` `9.16.0` is the commercial EULA. |
| React peer | `>=18`. The v6 migration removes `@ant-design/v5-patch-for-react-19`. | `react` and `react-dom` `^19.2.0`, and `@mantine/hooks` at the same version. | `^17 \|\| ^18 \|\| ^19`, plus `@emotion/react` and `@emotion/styled`. |
| Theming | CSS variables are the default. Seed `colorPrimary` (kit default `#1677ff`) is expanded by `theme.defaultAlgorithm`, `theme.darkAlgorithm`, and `theme.compactAlgorithm`. `theme.zeroRuntime` (6.0.0) stops runtime style generation and needs a CSS file. | CSS variables, light/dark/`auto` via `defaultColorScheme`, overrides through `cssVariablesResolver`. | Runtime CSS-in-JS through Emotion. A pre-mount sheet is a second styling system beside that runtime. |
| Locales opened for this record | [Internationalization](https://ant.design/docs/react/i18n/) on the v6.6.8 docs: `ru_RU`, `kk_KZ`, `uz_UZ` (Uzbek in Latin). | Dates take a dayjs locale. The dates guide demonstrates `ru`. No shipped `kk` or `uz` component catalog turned up in that guide. | Not scored. The license row already fails the dense-table case. |
| Dense admin table | `Table` column `fixed` (`true`, `'start'`, `'end'`) is part of the MIT component, with sort and filter on the same column API. | Not scored. The React-peer and locale rows already decide this column. | The licensing page puts multi-filtering, multi-sorting, column resizing, and column pinning on the commercial Pro plan. |

Ant Design is the kit. It is MIT, so it passes the license gate. Its v6 line is the CSS-variable line the spec already names. `ru_RU`, `kk_KZ`, and Latin `uz_UZ` ship in the kit, which is the locale set invariant 10 asks the shell to grow into. Fixed columns, sort, and filter are in the MIT table, so an admin grid does not depend on a commercial add-on. The v6 migration states that React 19 no longer needs a patch package. `lucide-react` `1.61.0` (ISC, published 2026-10-21) declares a React peer that includes `^19.0.0` (the full range is `^16.5.1 || ^17.0.0 || ^18.0.0 || ^19.0.0`).

Mantine is the fallback the register already names, and it is a real CSS-variable kit under MIT. It loses on two checks this record actually opened. The React peer is `^19.2.0`, so the shell's React pin is coupled to Mantine's minor line rather than to "React 19". The locale story that the dates guide documents is dayjs, with `ru` as the example, and it does not show Kazakh or Uzbek component strings of the kind antd ships as `kk_KZ` and `uz_UZ`.

MUI's core is MIT and mainstream. The admin surface we would actually ship — pinned columns on a large table — sits in MUI X Pro, whose npm license is the commercial EULA, not an OSI license on the gate's allowlist. Staying on the MIT community grid to avoid that fee means giving up the table behavior the shell's lists need. Emotion as a required peer also fights the pre-mount CSS rule: component styles would be created in the browser after React starts. MUI is out.

`antd` `6.6.8` and `lucide-react` `1.61.0` were both published inside spec §14's ageing window. The scaffold installs the newest `antd@6` and `lucide-react` release that has aged, and that has passed the gallery in Consequences. A same-day registry `latest` is not automatically the pin.

### Token compilers

The compiler's input is not a repository of token files. It is the versioned default document plus a tenant override row. Preview and publish both have to run it, and the CSS it returns has to be in the document before React mounts. Contrast, ranges, `schemaVersion`, and `revision` are part of that function. Three shapes:

1. **Style Dictionary `5.7.1`** (Apache-2.0, published 2026-10-24, `engines.node` `>=22`). v5 emits `css/variables`, keeps references when asked, and aligns the `{path}` reference syntax with the Design Tokens Community Group format. Custom formats can emit a second artifact. It is a Node build over source files. The minimum Node version matches the plan's Node 22 floor. It does not know about a tenant revision, a contrast pair, or an admin range. Wrapping it for those means keeping a second schema beside the typed override document, and shelling a file compiler on every preview.

2. **Terrazzo `@terrazzo/cli` `2.10.0`** and `@terrazzo/plugin-css` `2.10.0` (both MIT, both published 2026-10-21). The CLI reads DTCG JSON and the CSS plugin writes variables, including one block per mode selector (`[data-theme="light"]`, `[data-theme="dark"]`). That mode map is the closest file-compiler fit for two themes. It is still a build over files. The same gap remains: contrast, ranges, and the revision check would live in a pre-pass, and the tenant document would be serialized to DTCG on each preview so the CLI can read it back.

3. **An in-repo function**, `compileTheme(defaults, override)`, with no React import. It merges the override, rejects unknown keys and out-of-range edits, checks declared contrast pairs, and returns the `--plerni-*` CSS for both modes plus a kit seed. Color math is `colorjs.io` `0.7.1` (MIT, published 2026-07-24, outside the ageing window), calling `contrastWCAG21`. WCAG 2.2 did not change the 1.4.3 formula; Color.js names that formula WCAG21. APCA is not the bar. The tree-shakeable entry `colorjs.io/fn` is the import, so the shell does not pull the whole color library for one function.

The function in (3) is the compiler. Style Dictionary is the better-known file compiler, and Terrazzo's mode selectors match light/dark more directly, and both are the wrong lifecycle. D14's compiler runs on stored tenant data at preview and at publish. A file CLI would be an adapter in front of the actual compiler, which is the merge and the checks. Those stay in our schema because D14's flip condition is that this layer is the insurance and does not get replaced by the kit.

The kit adapter is a separate module. It is the only module that imports antd's theme algorithm and `@ant-design/static-style-extract`. Component imports go through the one re-export module (decision 7). The adapter takes the seed, runs `theme.defaultAlgorithm` for light and `theme.darkAlgorithm` for dark, and produces the kit's derived variables. Structural CSS uses `theme.zeroRuntime`. The stock `antd/dist/antd.css` does not carry a custom seed. A custom seed uses `@ant-design/static-style-extract` `2.1.0` (MIT, published 2026-03-10, peer `antd >= 6`). The vendor documents `extractStyle` as a Node step that returns CSS text. Preview and publish both call that module. The page does not run a second derivation of its own. `compileTheme` itself stays free of React so the contrast check and the `--plerni-*` sheet can be unit-tested without the kit.

## Decision

1. **Kit.** `antd` on the v6 line, candidate `6.6.8`, MIT. Icons for product chrome and for declarative screens are `lucide-react`, candidate `1.61.0`, ISC. `@ant-design/icons` is not a second product icon set. Icons that a kit component draws inside itself stay inside that component.
2. **Adapter.** `ConfigProvider` is the only theming entry. The seed's `colorPrimary` replaces the kit default `#1677ff`, so the kit's blue never reaches the screen. Light uses `defaultAlgorithm`. Dark uses `darkAlgorithm`. `compactAlgorithm` is available to the gallery's density axis and is not the default. `zeroRuntime: true`. `locale` is `en_US` or `ru_RU` from day one, and `kk_KZ` / `uz_UZ` when those product locales exist. Where a screen-reader scenario needs a complete list, `virtual` is `false` (the `ConfigProvider` prop and the per-component prop). Virtualization stays available for large tables; principle 11 still requires those tables to be tested with real volumes.
3. **Compiler.** `compileTheme` as specified in option 3. Output CSS uses `--plerni-*` only. The kit's `--ant-*` variables are adapter output, written into the same pre-mount sheet, and are not part of the token schema and not available to plugins.
4. **Layers and edits.** Foundation → semantic, including states → component roles. Admins edit foundation tokens and the semantic colors the schema marks editable. Component roles are derived. An override is a JSON document with `schemaVersion` (starting at `1`) and `revision`. Unknown keys, non-hex colors, and scalars outside the schema's min/max fail the compile. The numeric bounds live in the schema, next to the tokens, and ship with the shell; this record does not invent a radius scale. Component-level kit tokens are not an admin field.
5. **Contrast.** Declared pairs are checked with `contrastWCAG21` before a revision can be published. Text pairs meet 4.5:1 (3:1 for a pair the schema marks as large text). Identifying control boundaries and states meet 3:1. Inactive text is not a required pair, matching the 1.4.3 incidental exception. A failing pair is a typed error. Preview shows it. Publish does not save.
6. **Revisions.** Publish stores the override and the compiled CSS for both modes under the new revision, and it rejects a stale `revision`. Preview calls the same `compileTheme` and the same adapter extraction on the unsaved document, and it does not bump the revision. Bootstrap links the saved CSS in the document head, before the React bundle executes. The kernel stores that CSS and the override as tenant settings data. The kernel does not import the kit, the compiler, or the adapter.
7. **Imports.** `antd`, `@ant-design/static-style-extract`, and `lucide-react` may be imported only from the shell adapter and the shell's one re-export module. Plugin packages do not depend on them. The declarative grammar, when it lands in P2, names re-exported components and lucide icon names as data. It carries no color literals and no style objects. The enum of legal names belongs to the contract registry; the React components stay in the shell.
8. **What plugin UI is.** Through P4 the shell renders plugin screens from that data. P5 (Module Federation, and only after the demand trigger in D12) is out of scope here. An iframe protocol for untrusted plugin UI is out of scope (D24).

### Default theme

Token architecture is decided. The default theme is not.

The direction under test is Scholarly Plum, light primary `#6E3F73`, with a light mode and a dark mode both compiled for every revision. Deep Teal `#0F766E` and Burnished Copper `#A44727` stay in the candidate set until the maintainer picks. This record's own contrast check, sRGB relative luminance as defined for WCAG 2.2 success criterion 1.4.3, on 2026-10-26:

| Pair | Ratio | 1.4.3 text (4.5:1) |
|---|---|---|
| `#6E3F73` / `#FFFFFF` | 8.01:1 | passes |
| `#6E3F73` / `#000000` | 2.62:1 | fails |
| `#0F766E` / `#FFFFFF` | 5.47:1 | passes |
| `#A44727` / `#FFFFFF` | 5.98:1 | passes |

`#6E3F73` can be a light-mode primary. White text on that fill, and that color as text on white, both clear 4.5:1 and 7:1 (the AAA figure for normal text). The same hex on black does not clear 3:1, so it cannot be a dark-mode foreground and it cannot sit on a near-black surface as text. The dark primary is a separate resolved color. This record does not invent it. The ratios above are this check, recomputable from the hex values. They are not a substitute for the discovery's own measurements, which plan §12 describes and does not tabulate.

Validation path, from plan §12, and it is part of the decision: run this compiler and the antd adapter on the fixture gallery; light and dark; long Russian labels; then a ranking among the three directions with the plan §12 panel: 2 procurement, 2 learning admins, and 2 developers. The maintainer's pick after that pass is the default theme. Recording the path closes the theme input. It does not block this record, and it does not block P0.

## Consequences

- The shell scaffold adds `antd` (v6), `lucide-react`, `colorjs.io`, and `@ant-design/static-style-extract` under the §14 ageing rule, with the license-audit gate covering the lockfile. No MUI X Pro or Premium package. No Style Dictionary and no Terrazzo, unless a later record reverses item 3.
- The gallery's first fixture set is the a11y list in spec §9: date selection, table sort and filter, nested dialogs, form labels and errors, zoom, tenant contrast, plus the assistant-absent state, an open overlay (theme context has to reach popups; the kit's own note is that static `Modal` / `message` calls miss `ConfigProvider` and the `App` component is the supported fix), long Russian strings, and both modes. WCAG 2.2 AA is scored there, including 2.4.11 and 2.5.8. A kit failure on a procurement-critical scenario is the D13 flip, not a waiver.
- Token lint, landing with the shell, parses CSS and TS style objects and rejects literal visual values and unknown tokens. The import boundary in decision 7 is a dependency-cruiser rule on the same change. Plugin declarative documents are rejected at admission if they contain a color literal or a component name outside the contract enum.
- Confirm/cancel order and "color is never the only signal" are gallery assertions on the re-exported components. The compiler cannot prove them.
- A v6 patch or minor that has aged and has not broken the gallery does not amend this record. A v6 change that breaks the declarative names, the contrast pairs, or `zeroRuntime` is the behavior watch: fix it in the adapter, or open the D13 flip. An antd major, or a different kit, is a new record.
- React and Vite versions are the shell scaffold's pin, as one compatibility group with the kit (spec §14). This record only constrains the peers: the chosen `antd` accepts React `>=18` and needs no React 19 patch; `lucide-react` `1.61.0` accepts React 19. Registry `latest` on the research date was React `19.3.1` (2026-10-14) and Vite `8.3.5` (2026-10-21), which is context for that later pin, not the pin itself.
- FSD layout and the i18n catalog (D15) are not decided here. The kit locale prop is necessary for those locales and is not the translation system.

## Flip conditions

- **D13.** A procurement-critical accessibility scenario fails on the pinned kit version, or a deployment needs pixel-level brand control that token edits inside the schema cannot express. Response: replace the adapter (and, if required, the kit behind it) without rewriting screens. Screens are tokens, declarative data, and the re-export surface.
- **D14.** No flip. The compiler, the `--plerni-*` contract, and the rule that the kit sits behind the adapter stay. A better emitter inside `compileTheme` is an implementation change, not a reversal, as long as preview and publish still call one function and plugins still see only `--plerni-*`.
- **Theme direction.** The maintainer selects a different candidate, or the ranking pass rejects plum. That selection updates the default document's seed. It does not reopen the kit or the compiler. A dark primary that fails decision 5 cannot ship to make the brand consistent.

## Sources

Read on 2026-10-26. Versions and publish times are the npm registry (`npm view <name> version time license engines`). Docs:

- Ant Design: [From v5 to v6](https://ant.design/docs/react/migration-v6/), [Customize Theme](https://ant.design/docs/react/customize-theme/) (`colorPrimary`, algorithms, `zeroRuntime`), [Internationalization](https://ant.design/docs/react/i18n/) (`ru_RU`, `kk_KZ`, `uz_UZ`), [ConfigProvider](https://ant.design/components/config-provider/) (`virtual`, `locale`), [Table](https://ant.design/components/table/) (column `fixed`). `@ant-design/static-style-extract` `2.1.0` readme and the customize-theme zero-runtime section.
- Mantine: [CSS variables](https://mantine.dev/styles/css-variables/), [Color schemes](https://mantine.dev/theming/color-schemes/), [Dates getting started](https://mantine.dev/dates/getting-started/) (dayjs locale, `ru` example). npm peers for `@mantine/core@9.7.4`.
- MUI X: [Licensing](https://mui.com/x/introduction/licensing/) (MIT community packages versus commercial Pro/Premium) and the [Data Grid](https://mui.com/x/react-data-grid/) package split. npm license `SEE LICENSE IN LICENSE` on `@mui/x-data-grid-pro@9.16.0`.
- Style Dictionary `5.7.1`: [v5 migration](https://styledictionary.com/versions/v5/migration/) (Node `>=22`, DTCG reference syntax) and [built-in formats](https://styledictionary.com/reference/hooks/formats/predefined/) (`css/variables`).
- Terrazzo: [Getting started](https://terrazzo.app/docs/) and [CSS plugin](https://terrazzo.app/docs/integrations/css/) (mode selectors). `@terrazzo/cli@2.10.0`, `@terrazzo/plugin-css@2.10.0`.
- Color.js `0.7.1`: [Contrast](https://colorjs.io/docs/contrast) (`contrastWCAG21`).
- WCAG 2.2, W3C Recommendation 12 December 2024: [https://www.w3.org/TR/WCAG22/](https://www.w3.org/TR/WCAG22/) success criteria 1.4.3, 1.4.11, 2.4.11, and 2.5.8.
