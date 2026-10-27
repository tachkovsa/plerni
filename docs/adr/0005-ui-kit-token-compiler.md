# ADR-0005 — UI kit + token compiler

- **Status:** Accepted · **Date:** 2026-10-26
- **Issue:** [#19](https://github.com/tachkovsa/plerni/issues/19)
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §1 invariants 5–8 and 10, §9 (shell, kit, tokens, declarative screens, accessibility), §12 (token lint, fixture gallery), §14 (dependency freshness)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D13** (kit), **D14** (token compiler and admin theming). **D12** and **D24** bound the plugin surface this kit renders.
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §8 task 11, §9 (reviewer for this record is other than β), §12 (default-theme discovery). [`../plans/2026-10-13-p0-detailed-implementation-plan.md`](../plans/2026-10-13-p0-detailed-implementation-plan.md) T11. [`../ROADMAP.md`](../ROADMAP.md) — declarative plugin screens until P5; WCAG 2.2 AA is a property of the kit, shown on real workflows.
- **Number:** Plan §8 assigns 0005 to this record. Listing this directory at writing shows 0001, 0003, 0004, 0006, and 0007. 0002 remains the name that section assigns to the ORM record.

Versions below were read from the npm registry `time` field and from the vendors' docs on 2026-10-26. The shell is still unscaffolded, so these are pins for that scaffold, not a lockfile edit.

## Context

The shell is a React 19 + Vite SPA and an API client (spec §9). It draws the admin screens and, until P5, every plugin screen. Plugin screens in that window are declarative data — settings, forms, menus, widgets, and lists — rendered by the shell (D12, spec §9, roadmap). No plugin JavaScript runs in the host page. Untrusted plugin screens and an iframe protocol for them stay out of v1 (D24). Interface principles 8–12 are properties of that renderer.

Invariant 7 forbids a bespoke component library. Every visual value is a token. Invariant 5 wants the kit to be mainstream. Invariant 8 and the license-audit gate want OSI-approved licenses only (MIT, ISC, and Apache-2.0 are on the allowlist). Invariant 10 wants Russian as a first-class locale, with Kazakh and Uzbek next, and a default theme that is credible for a CIS enterprise without the kit's corporate blue.

D13 chooses Ant Design plus lucide-react. D14 chooses a kit-agnostic compiler: versioned defaults, typed tenant overrides (`schemaVersion` + `revision`), foundation → semantic (including states) → component roles, constrained admin edits, contrast validation, resolved CSS delivered before React mounts, and the same compiler for live preview and publish. Plugins read `--plerni-*` only. The kit sits behind an adapter. D14's flip condition is that this layer is the insurance and does not get replaced by the kit. D13 records the predecessor's removal of its kit when a pixel-fidelity requirement exceeded theming (evidence ID ADR-0185). This product keeps the packaged kit. A later swap replaces the adapter and leaves the screens and the token names in place.

Accessibility is WCAG 2.2 Level AA, the W3C Recommendation of 12 December 2024. The spec's "WCAG AA" and the roadmap's "WCAG 2.2 AA" are this bar. Conformance is evidence on our workflows. The criteria the gallery has to show include the ones 2.2 adds on top of 2.1, in particular 2.4.11 Focus Not Obscured (Minimum) and 2.5.8 Target Size (Minimum), plus the spec §9 list: date selection, table sort and filter, nested dialogs, form labels and errors, zoom, and tenant contrast. Contrast itself is unchanged from 2.1: 1.4.3 is 4.5:1 for text (3:1 for large text), with the inactive, decorative, and logotype exceptions; 1.4.11 is 3:1 for the parts of a control that identify it and for its states.

Plan §12 records the theme discovery as input. Family β offered three directions and recommended Scholarly Plum, light primary `#6E3F73`. The alternatives are Deep Teal `#0F766E` and Burnished Copper `#A44727`. The maintainer has not locked a brand.

Spec §14 holds ordinary patches and minors about seven days and triages a security fix inside a day. Applied to this registry snapshot, a routine pin has aged when its npm publish time is on or before 2026-10-19. The repo's Node major is 24 (`.nvmrc`).

## What was compared

| Package | Registry head (npm `time`) | Aged pin for the scaffold |
|---|---|---|
| `antd` | 6.6.8 (2026-10-26T02:48:57Z) | **6.6.6** (2026-10-12T06:47:33Z). 6.6.7 (2026-10-20T03:14:16Z) has not aged. |
| `lucide-react` | 1.61.0 (2026-10-21T06:12:38Z) | **1.59.0** (2026-10-17T06:15:48Z). 1.60.0 (2026-10-20T06:15:28Z) has not aged. |
| `colorjs.io` | 0.7.1 (2026-07-24T16:34:21Z) | **0.7.1** |
| `@ant-design/static-style-extract` | 2.1.0 (2026-03-10T09:38:38Z) | **2.1.0**, adapter only |
| `style-dictionary` | 5.7.1 (2026-10-24T13:47:54Z) | not taken |
| `@terrazzo/cli`, `@terrazzo/plugin-css` | 2.10.0 (2026-10-21) | not taken |
| `@mantine/core` | 9.7.4 (2026-10-25T20:15:13Z) | comparison only |
| `@mui/material` | 9.5.0 (2026-10-09T09:12:59Z) | comparison only |
| `@mui/x-data-grid` / `-pro` | 9.16.0 (2026-10-20) | comparison only |

`react@19.3.1` (2026-10-14T16:47:15Z) and `vite@8.3.5` (2026-10-21T06:38:54Z) are context for the scaffold's compatibility group (spec §14). This record does not pin them. Vite 8.3.5 has not aged. `antd@6` peers `react` and `react-dom` `>=18`. The v6 migration says React 19 no longer needs `@ant-design/v5-patch-for-react-19`. `lucide-react@1.59.0` peers `react` `^16.5.1 || ^17.0.0 || ^18.0.0 || ^19.0.0` and is ISC.

## Options

### UI kits

| | Ant Design 6 | Mantine 9 | Material UI 9 + X |
|---|---|---|---|
| License | MIT. `@ant-design/cssinjs@2.1.2` and `@ant-design/icons` are MIT. Product icons are ISC. | MIT. | `@mui/material@9.5.0` and `@mui/x-data-grid@9.16.0` are MIT. `@mui/x-data-grid-pro@9.16.0` is `SEE LICENSE IN LICENSE`. |
| React | Peer `>=18`. | Peer `react` and `react-dom` `^19.2.0`, plus `@mantine/hooks` at the same version. | Peer `^17 \|\| ^18 \|\| ^19`. `@emotion/react`, `@emotion/styled`, and `@mui/material-pigment-css` are optional peers. |
| Theme | CSS variables. Seed `colorPrimary` defaults to `#1677ff`. `theme.defaultAlgorithm`, `theme.darkAlgorithm`, `theme.compactAlgorithm`. `zeroRuntime` since 6.0.0 stops runtime style generation and needs a CSS file. css-in-js remains a dependency. | CSS variables, light/dark/`auto`, `cssVariablesResolver`. | CSS theme variables are documented. Emotion is one optional engine, not a required peer. |
| Locales checked here | `ru_RU`, `kk_KZ`, and `uz_UZ` (Uzbek, Latin) are listed on the v6 internationalization page and resolve in the `antd@6.6.6` package. | `@mantine/core@9.7.4` ships no locale directory. Dates follow a dayjs locale. dayjs `1.11.23` ships `ru`, `kk`, and `uz`. | Not scored. The license row already fails the dense-table case. |
| Admin table inside the OSS license | `ColumnType` on the 6.6.6 tag declares `sorter`, `filters`, and `onFilter`, and it extends the rc-table column type that declares `fixed` (`true`, `'start'`, `'end'`). The public column docs list the same fields. | Core `Table` renders caller-supplied header and cell nodes. Sort, filter, and pinned columns are application code. The virtualization example pulls a separate virtualizer. | The licensing page puts multi-filtering, multi-sorting, column resizing, and column pinning on the commercial Pro plan. Row grouping and Excel export are Premium. |

Ant Design is the kit. It is the register's choice, it is MIT, its v6 line is the CSS-variable line the spec names, and the three CIS locales plus sort, filter, and pinned columns are inside the MIT package.

Mantine stays the documented fallback (D13). It is a real MIT CSS-variable kit. It loses the admin grid: building sort, filter, and pinned columns would be the bespoke library invariant 7 rules out. Its React peer also couples the shell to `^19.2.0` rather than to "React 19".

Material UI's core is MIT, and its styling peers are optional, so a CSS path exists. The admin surface this shell needs — pinned columns on a large table — sits in MUI X Pro, whose npm license is the commercial EULA. Invariant 8 closes that path. Staying on the MIT community grid gives up the table behavior. MUI is out.

### Token compilers

The compiler's input is the versioned default document plus a tenant override row. Preview and publish both run it. The CSS it returns is in the document before React mounts. `schemaVersion`, `revision`, ranges, and contrast are part of that function. Tenant JSON is untrusted.

1. **Style Dictionary `5.7.1`** (Apache-2.0, Node `>=22`, which the repo's Node 24 satisfies). v5 emits `css/variables`. `formatPlatform` returns each file's `output` (usually a string) and does not require a disk write, so a preview can stay in process. The library does not know a tenant revision, a contrast pair, or an admin range. Those stay in a pre-pass.

   `convertTokenData` has a published prototype-pollution history. [GHSA-vj5c-m527-mpff](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-vj5c-m527-mpff) (2026-06-08) rates impact high when Style Dictionary runs inside a Node server and the caller passes attacker-influenced tokens. The first patch was 5.4.4. Later bypasses are [GHSA-xmr7-549p-98w3](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-xmr7-549p-98w3), [GHSA-5pgh-4v89-hfqj](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-5pgh-4v89-hfqj), and [GHSA-cr3w-v879-f973](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-cr3w-v879-f973). [GHSA-m4pr-rgwp-x36r](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-m4pr-rgwp-x36r) (2026-10-24, moderate, affected `>=4.3.0 <5.7.1`) is a fourth bypass of the object-output path. Its advisory says the direct utility API was proven on 5.7.0 and the `new StyleDictionary(...)` build path was not proven for that specific payload. 5.7.1 is the patched release. It was published inside the ageing window. Preview and publish are the server-side use the original advisory calls high impact. A pre-pass in front of that walker is a second parser we would have to keep perfect.

2. **Terrazzo `@terrazzo/cli@2.10.0` and `@terrazzo/plugin-css@2.10.0`** (both MIT, both published 2026-10-21). The CSS plugin writes variables, including one block per mode selector. The documented pipeline is a build over files. Contrast, ranges, and the revision check would still be ours, and the tenant row would be serialized to a token file so the CLI can read it back. The same trust boundary as option 1, with a file path in the middle.

3. **`compileTheme(defaults, override)` in this repo**, with no React import and no Ant Design import. It walks the schema, copies allowlisted values onto a fresh null-prototype object, checks contrast, and returns the `--plerni-*` CSS for both modes plus the kit seed. Color math for the contrast ratio is `colorjs.io@0.7.1` (MIT, published 2026-07-24, outside the ageing window). The documented call is `color.contrast(other, "WCAG21")` on the package root. WCAG 2.2 did not change the 1.4.3 formula. Color.js names that formula WCAG21. APCA is not the bar. The tree-shakeable `colorjs.io/fn` entry does not parse a hex string until a color-space module is registered, so the scaffold does not import `contrastWCAG21` from that entry alone.

Option 3 is the compiler. Options 1 and 2 compile token files. D14's compiler runs on a stored tenant document at preview and at publish. `formatPlatform` removes the "must write a file" objection to Style Dictionary, and it does not remove the trust objection: tenant JSON would still enter a general token walker with a repeated prototype-pollution record, on the server path that record treats as high impact. The checks D14 requires are the compiler. Printing `--plerni-*` from values that already passed a closed grammar is a small function. The mainstream pieces around it are the kit, the icon set, and Color.js.

## Decision

1. **Kit.** `antd@6.6.6` and `lucide-react@1.59.0` are the scaffold pins. They are the newest releases of those lines whose npm publish time is on or before 2026-10-19. Registry heads on the research date were `antd@6.6.8` and `lucide-react@1.61.0`. `antd@6.6.7` carries the `aria-describedby` association for warning-only form messages and the duplicate-button fix on the editable typography icon. `antd@6.6.8` carries the Progress `aria-valuenow` fix. The scaffold moves to a later 6.6 patch, and to a later lucide 1.x, after that release has aged and the gallery still passes. Those changelog entries are bugfix and accessibility notes. This record did not find a published GHSA for 6.6.7 or 6.6.8, so the 24-hour exception does not pull them forward. Product icons come from `lucide-react`, re-exported by the one allowlist package. Icons a kit component draws inside itself stay inside that component. `@ant-design/icons` is not a second product icon set.

2. **Adapter.** `ConfigProvider` is the only theming entry. `zeroRuntime: true`, so component styles are not generated after React mounts. The document loads `antd/dist/antd.css` and then one theme sheet before the React module runs. The sheet sets `--plerni-*` from `compileTheme` and the derived `--ant-*` map for the resolved seed. `theme.getDesignToken` is the documented static read of that map outside the React lifecycle. In `antd@6.6.6`'s `antd.css`, `#1677ff` is assigned to `--ant-color-primary` and to derived component variables (45 occurrences), so the sheet replaces the map. `@ant-design/static-style-extract@2.1.0` (`extractStyle` returns CSS text; peer `antd >= 6`) is the adapter's tool when the stock file's selectors do not match the config. The vendor documents that case for a changed prefix. The gallery is the check that the sheet and the painted components agree. The kit variable prefix stays `ant`. Product and plugin variables use `plerni`. Light uses `theme.defaultAlgorithm`. Dark uses `theme.darkAlgorithm`. `compactAlgorithm` is a gallery density axis and is not the default. `colorPrimary` is the resolved seed. `locale` is `en_US` or `ru_RU` from day one, and `kk_KZ` or `uz_UZ` when those product locales exist. Where a screen reader must see the whole list, `virtual` is `false` (the ConfigProvider prop, present on the 6.6.6 docs, or the component prop). Select's own `virtual` defaults to `true`. Static `message`, `notification`, and `Modal` calls go through `App.useApp`, and `App` sits inside `ConfigProvider`, so theme context reaches overlays.

3. **Compiler.** `compileTheme` as in option 3. Bootstrap, preview, and publish call it. Output custom properties for plugins are `--plerni-*` only. The kit's `--ant-*` variables are adapter output in the same pre-mount sheet. They are not part of the token schema and they are not available to plugins. The kernel persists the override document and the compiled CSS as tenant settings. It does not import the kit, Color.js, the compiler, or the adapter.

4. **Untrusted tenant JSON.** An override is data from a tenant admin, an import, or a client. `compileTheme` walks the schema and copies allowlisted values onto a fresh object created with `Object.create(null)`. It does not recursively merge the parsed JSON. A key the schema does not list fails the compile, including `__proto__`, `constructor`, and `prototype`. Colors are 6-digit sRGB hex. Numbers are finite and inside the schema's min/max; the schema names the unit, and the tenant does not send a unit string. The emitter writes custom properties whose names come from the schema and whose values matched that grammar. It does not copy a tenant string into CSS. It does not emit `url(`, `@import`, comments, backslash escapes, or a character that can close a style element. Publish recomputes on the server and stores that output. Client-supplied CSS is not stored. A failing check publishes nothing.

5. **Layers and edits.** Foundation → semantic, including states → component roles. The schema marks which foundation seeds and semantic colors are editable. Component roles are derived and are not admin fields. Component-level kit tokens are not admin fields. `schemaVersion` starts at `1`. An unknown `schemaVersion` fails. Numeric bounds live in the schema and ship with the shell. This record does not invent a radius scale.

6. **Contrast.** Declared pairs are checked with Color.js `"WCAG21"` before a revision can be published. Text pairs meet 4.5:1, or 3:1 when the schema marks the pair as large text. Identifying control boundaries and states meet 3:1. Inactive text is not a required pair (the 1.4.3 incidental exception). A failing pair is a typed error. Preview shows it. Publish does not save.

7. **Revisions.** Publish stores the override and both modes' CSS when the stored `revision` equals the document's `revision`, then advances the revision. A stale `revision` changes zero rows. Preview calls the same `compileTheme` and the same adapter extraction on the unsaved document and does not bump the revision. Bootstrap links the saved CSS in the document head, before the React bundle executes.

8. **Imports and plugin screens.** `antd`, `@ant-design/static-style-extract`, and `lucide-react` may be imported only from the shell adapter and the shell's one re-export module. `colorjs.io` may be imported only from the compiler module. Plugin packages do not depend on them. Through P4 the shell renders plugin screens from declarative data. The grammar names re-exported components and lucide icon names. It carries no color literals and no style objects. The enum of legal names belongs to the contract registry. The React components stay in the shell. P5 (Module Federation, and only after the demand trigger in D12) is out of scope. An iframe protocol for untrusted plugin UI is out of scope (D24).

9. **Accessibility evidence.** The bar is WCAG 2.2 AA on workflows, including 2.4.11 and 2.5.8 and the spec §9 list, plus `virtual={false}` where a screen reader must see the whole list. The gallery also covers the assistant-absent state, an open overlay, long Russian strings, both modes, and densities. Confirm/cancel order and "color is never the only signal" are gallery assertions on the re-exported components. The compiler cannot prove them. A kit failure on a procurement-critical scenario is the D13 flip.

10. **Default theme.** Token architecture is decided. The default theme is not. The direction under test is Scholarly Plum, light primary `#6E3F73`. Deep Teal `#0F766E` and Burnished Copper `#A44727` stay in the candidate set until the maintainer picks. Light and dark are both compiled for every revision. The dark primary is a separate resolved color. This record does not choose it. The validation path from plan §12 is part of the decision and does not block this record or P0: run this compiler and the Ant Design adapter on the fixture gallery; light and dark; long Russian labels; then a ranking with two procurement admins, two learning admins, and two developers. The maintainer's pick after that pass is the default theme.

### Measurements

Method: WCAG 2 relative luminance from sRGB, contrast `(L1 + 0.05) / (L2 + 0.05)`, rounded to two decimals. The dark surface is `#141414`. On the `antd@6.6.6` tag, dark `colorBgContainer` is `getSolidColor(colorBgBase || '#000', 8)`, and `getSolidColor` is `FastColor.lighten`. `@ant-design/fast-color@3.0.1` adds `amount / 100` to HSL lightness. Lighten-by-8 from black is `#141414` (measured on that package). `colorjs.io@0.7.1` `contrast(..., "WCAG21")` returned 8.01 for `#6E3F73` against white, the same ratio as this table. These are this record's measurements. Plan §12 describes the discovery's own sheet and does not tabulate it.

| Pair | Ratio | Text 4.5:1 (1.4.3) | UI 3:1 (1.4.11) |
|---|---|---|---|
| `#6E3F73` / `#FFFFFF` | 8.01 | pass | pass |
| `#6E3F73` / `#141414` | 2.30 | fail | fail |
| `#6E3F73` / `#000000` | 2.62 | fail | fail |
| `#0F766E` / `#FFFFFF` | 5.47 | pass | pass |
| `#0F766E` / `#141414` | 3.37 | fail | pass |
| `#A44727` / `#FFFFFF` | 5.98 | pass | pass |
| `#A44727` / `#141414` | 3.08 | fail | pass |
| `#FFFFFF` / `#1677ff` | 4.10 | fail | pass |

White on `#6E3F73`, `#0F766E`, or `#A44727` has the same ratio as that color on white, so a white label on those fills passes 4.5:1. `#6E3F73` passes as a light-theme primary and as text on white. The same hex fails as text, icon, or boundary on `#141414` and on black. The dark theme's primary is a different color. The kit's default seed fails 4.5:1 for a white label, so the adapter does not ship `#1677ff`.

## Consequences

- The scaffold adds `antd@6.6.6`, `lucide-react@1.59.0`, `colorjs.io@0.7.1`, and `@ant-design/static-style-extract@2.1.0`, then re-reads the locale files, the css-in-js dependency, `zeroRuntime`, `getDesignToken`, and the Table column fields on those tarballs. Lockfile ranges match those pins. The license-audit gate covers the lockfile. No MUI X Pro or Premium package. No Style Dictionary and no Terrazzo, unless a later record reverses decision 3.
- One re-export package is the component and icon allowlist. Token lint (spec §9) rejects literal visual values and unknown tokens in CSS and in style objects, and it rejects `--ant-*` outside the adapter. Plugin declarative documents are rejected at admission when they contain a color literal or a component name outside the contract enum. The import boundary is a dependency-cruiser rule on the same change.
- Admin theme publish runs `compileTheme` on the server. A failed contrast, range, schema, or revision check publishes nothing.
- `kk_KZ` and `uz_UZ` file presence is a head start for D15. The locale-parity gate still compares product strings. FSD layout and the i18n catalog are not decided here.
- The resources page retrieved the same day marks the Figma libraries as third-party and marks the Sketch symbol files as official. D13's openness note expected an official Figma kit that imports into Pixso. This record did not re-run a Pixso import. Design handoff can use a third-party Figma library. That library is not a dependency. The license and the published component API are the openness facts checked here.
- A v6 patch or minor that has aged and has not broken the gallery does not amend this record. A v6 change that removes `theme.token`, `getDesignToken`, CSS variables, or `zeroRuntime` from the allowlisted components is the behavior watch spec §9 asks for: fix it in the adapter, or open the D13 flip. An antd major, or a different kit, is a new record.
- React and Vite versions are the shell scaffold's pin, as one compatibility group with the kit.

## Flip conditions

- **D13.** A procurement-critical accessibility scenario fails on the pinned kit, or a deployment needs pixel-level brand control that token edits inside the schema cannot express. Response: replace the adapter, Mantine first, and keep the token names. Screens stay tokens, declarative data, and the re-export surface. A failed scenario is gallery evidence recorded against the pinned version.
- **D14.** No flip. The compiler, the `--plerni-*` contract, and the rule that the kit sits behind the adapter stay. A better emitter inside `compileTheme` is an implementation change, as long as preview and publish still call one function, tenant JSON still hits the closed grammar in decision 4, and plugins still see only `--plerni-*`.
- **Palette.** The maintainer selects a candidate, or the ranking pass rejects plum. That selection updates the default document's seed. It does not reopen the kit or the compiler. A dark primary that fails decision 6 cannot ship to keep one hex across both themes.

## Review

The drafting model families for this record are unknown. Maintainer decision 2026-10-26 ([`../ai/model-routing.md`](../ai/model-routing.md)) accepts an ADR in that case on a review by the project's maintainer-designated assistant reviewer plus a clean Codex review of the exact head. A human review is not required on that path.

Pull request [#70](https://github.com/tachkovsa/plerni/pull/70) merged this record after that pair of reviews. The decision text they reviewed is head `b5548eb74970760ca5330968ff2cf675b76521e1`. The squash merge is `3cdb8efebec6e02c6190c4c2cca7873e977b6796`. The evidence reference is the public assistant receipt comment [6421279167](https://github.com/tachkovsa/plerni/pull/70#issuecomment-6421279167), bound to that head, plus the Codex clean review comment [6418421097](https://github.com/tachkovsa/plerni/pull/70#issuecomment-6418421097) on the same head. The assistant receipt names that head, records the clean Codex review, and states that the reviewer was the project assistant under the maintainer's 2026-10-26 decision because the drafting family is unknown. Required checks on the pull request were green, and the review threads were resolved.

This section is the acceptance record for that review. It is not a new review of a later commit.

- **Reviewed head:** `b5548eb74970760ca5330968ff2cf675b76521e1`
- **Reviewer role:** `agent` (maintainer-designated assistant reviewer), with a clean Codex review of that same head
- **Accountable sponsor:** the maintainer
- **Verification summary:** The assistant receipt checked the decision against D13 and D14, and against invariants 5, 7, 8, and 10 and spec §9, §12, and §14. The kit is Ant Design plus lucide-react, with Mantine as the fallback and Material UI out on the Pro-license grid. The compiler is kit-agnostic, plugins read `--plerni-*` only, the kit sits behind the adapter, and preview and publish call one function. Pins follow the seven-day ageing rule. The contrast table is consistent, and the adapter does not ship `#1677ff`. The default palette and the dark primary stay open for the maintainer. Codex completed its review of the reviewed head with no findings.
- **Outcome:** Accepted
- **Rule:** reviewed under the maintainer rule of 2026-10-26. This receipt names that exact head. It carries no human-review claim and no family-separation claim.
- **Evidence reference:** public assistant receipt comment [6421279167](https://github.com/tachkovsa/plerni/pull/70#issuecomment-6421279167) on pull request #70, bound to head `b5548eb74970760ca5330968ff2cf675b76521e1`, and Codex clean review comment [6418421097](https://github.com/tachkovsa/plerni/pull/70#issuecomment-6418421097) on that same head. This receipt carries no human-review claim and no family-separation claim.

## Sources

Read on 2026-10-26. Publish times are the npm registry `time` field.

- Ant Design customize theme (`colorPrimary` default `#1677ff`, algorithms, `cssVar`, `zeroRuntime` since 6.0.0, `antd/dist/antd.css`, `getDesignToken`, `extractStyle`), <https://ant.design/docs/react/customize-theme/>
- Ant Design v6 migration (React `>=18`, `@ant-design/v5-patch-for-react-19` removed), tag `6.6.6`, <https://github.com/ant-design/ant-design/blob/6.6.6/docs/react/migration-v6.en-US.md>
- Ant Design internationalization (`ru_RU`, `kk_KZ`, `uz_UZ` Latin), <https://ant.design/docs/react/i18n/>. Locale files `ru_RU`, `kk_KZ`, and `uz_UZ` resolve in `antd@6.6.6`.
- Ant Design resources (Sketch files marked official; Figma libraries marked third-party), <https://ant.design/docs/resources/>
- Ant Design changelog, repository copy: 6.6.6 `2026-10-12`, 6.6.7 `2026-10-20` (`aria-describedby`, duplicate button semantics), 6.6.8 `2026-10-25` (Progress `aria-valuenow`), <https://github.com/ant-design/ant-design/blob/master/CHANGELOG.en-US.md>. Ageing uses the npm `time`, which for 6.6.7 is 2026-10-20T03:14:16Z.
- Ant Design Select on tag `6.6.6` (`virtual` default `true`; `virtual={false}` binds the list for a screen reader) and ConfigProvider `virtual`, <https://github.com/ant-design/ant-design/blob/6.6.6/components/select/index.en-US.md>, <https://github.com/ant-design/ant-design/blob/6.6.6/components/config-provider/index.en-US.md>
- Ant Design Table column `sorter`, `filters`, `onFilter`, `fixed`, <https://github.com/ant-design/ant-design/blob/6.6.6/components/table/interface.ts> and <https://ant.design/components/table/>
- Dark neutrals on tag `6.6.6`: `colorBgContainer: getSolidColor(colorBgBase || '#000', 8)`, `getSolidColor` = `FastColor.lighten`, <https://github.com/ant-design/ant-design/blob/6.6.6/components/theme/themes/dark/colors.ts>, <https://github.com/ant-design/ant-design/blob/6.6.6/components/theme/themes/dark/colorAlgorithm.ts>. `@ant-design/fast-color@3.0.1` `lighten` adds `amount / 100` to HSL lightness. `antd@6.6.6` depends on `^3.0.1`.
- `antd@6.6.6` `dist/antd.css`: component rules read `var(--ant-color-primary)`; `#1677ff` occurs 45 times, including the `--ant-color-primary` assignment.
- Ant Design `App` (`useApp` for static `message` / `notification` / `Modal`; `App` under `ConfigProvider` for tokens), tag `6.6.6`, <https://github.com/ant-design/ant-design/blob/6.6.6/components/app/index.en-US.md>
- Mantine CSS variables, color schemes, dates, core Table, <https://mantine.dev/styles/css-variables/>, <https://mantine.dev/theming/color-schemes/>, <https://mantine.dev/dates/getting-started/>, <https://mantine.dev/core/table/>. `@mantine/core@9.7.4` file listing has a `Table` and no locale directory. dayjs `1.11.23` locales `ru`, `kk`, `uz` resolve.
- MUI X licensing (Community MIT; Pro column pinning, multi-filter, multi-sort, column resize; Premium row grouping and Excel export), <https://mui.com/x/introduction/licensing/>. `@mui/material@9.5.0` `peerDependenciesMeta` marks Emotion and Pigment CSS optional.
- Style Dictionary `formatPlatform` (`output` without a required destination), <https://styledictionary.com/reference/api/>
- Style Dictionary advisories: [GHSA-vj5c-m527-mpff](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-vj5c-m527-mpff), [GHSA-xmr7-549p-98w3](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-xmr7-549p-98w3), [GHSA-5pgh-4v89-hfqj](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-5pgh-4v89-hfqj), [GHSA-cr3w-v879-f973](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-cr3w-v879-f973), [GHSA-m4pr-rgwp-x36r](https://github.com/style-dictionary/style-dictionary/security/advisories/GHSA-m4pr-rgwp-x36r). Release [v5.7.1](https://github.com/style-dictionary/style-dictionary/releases/tag/v5.7.1) (2026-10-24).
- Terrazzo CSS plugin (mode selectors), <https://terrazzo.app/docs/integrations/css/>
- Color.js contrast (`contrast(..., "WCAG21")`), <https://colorjs.io/docs/contrast>. `colorjs.io@0.7.1` package root accepted `#6E3F73` and returned 8.01 against white.
- WCAG 2.2, W3C Recommendation 12 December 2024, success criteria 1.4.3, 1.4.11, 2.4.11, and 2.5.8, <https://www.w3.org/TR/WCAG22/>
