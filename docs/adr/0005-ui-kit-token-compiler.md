# ADR-0005 — UI kit + token compiler

- **Status:** Proposed · **Date:** 2026-10-26
- **Spec:** [`../specs/2026-10-12-plerni-design.md`](../specs/2026-10-12-plerni-design.md) §1 invariant 7 (packaged kit, tokens only), §9 (shell, kit, token architecture, accessibility), §15 (plugin screens)
- **Register:** [`../decision-register.html`](../decision-register.html) — **D13** (kit), **D14** (token compiler and admin theming). **D12** and **D24** bound the plugin surface this kit renders.
- **Plan:** [`../plans/2026-10-13-p0-implementation-plan.md`](../plans/2026-10-13-p0-implementation-plan.md) §8 task 11, §9 (reviewer for this record is other than β), §12 (default-theme discovery). [`../ROADMAP.md`](../ROADMAP.md) (declarative plugin screens until P5; WCAG 2.2 AA lives in the kit).
- **Issue:** [#19](https://github.com/tachkovsa/plerni/issues/19)
- **Number:** Plan §8 assigns 0005 to this record. Listing this directory at writing shows 0001, 0003, 0004, 0006, and 0007. 0002 remains the name that section assigns to the ORM record.

## Context

The shell is a React 19 + Vite SPA and an API client (spec §9). It draws the admin screens and, until P5, every plugin screen. Plugin screens in that window are declarative data — forms, menus, and lists — rendered by the shell (D12, roadmap). Untrusted plugin screens and an iframe protocol for them stay out of v1 (D24). Host-page JavaScript from a plugin waits for P5, and only if that phase starts.

Invariant 7 forbids a bespoke component library. Every visual value is a token. The predecessor removed its kit when a pixel-fidelity brand requirement exceeded the kit's theming (the predecessor's ADR-0185, cited by D13). This product accepts the other side of that trade: a packaged kit, with the token contract as the insurance (spec §9). Replacing the kit later replaces the adapter. It leaves the screens and the token names in place.

Two decisions are separate. D13 chooses the kit and the icon set. D14 chooses a kit-agnostic compiler: versioned defaults, typed tenant overrides, semantic tokens, `--plerni-*` custom properties, and a kit adapter. Admin preview and publish run that same compiler. Resolved CSS is on the page before React mounts. Light and dark both ship.

Plan §12 records the brand input this record is allowed to use. The maintainer asked for an enterprise-credible default without the usual corporate blue, CIS-first, with the theming machinery already set by spec §9 and D14. A β consultation offered three directions and recommended Scholarly Plum. The final palette is the maintainer's. β authored that discovery, so plan §9 assigns this record a reviewer other than β. This text is the proposal. It carries no review receipt.

WCAG 2.2 level AA is the bar the roadmap assigns to the kit, demonstrated on real workflows. Spec §9 says the same pursuit in the words "WCAG AA", and it says the kit's own claim is evidence to collect, which the shell's tests produce. The named checks are date selection, table sort and filter, nested dialogs, form labels and errors, zoom, and tenant contrast. A select that must be complete to a screen reader is rendered with virtualization off (spec §9).

## What was compared

Research date 2026-10-26. Versions are registry facts from that date. Behavior was read from the sources in the last section. The shell is still unscaffolded, so this record pins lines and versions for that scaffold. It adds no dependency to a manifest.

Spec §14 / D21 holds ordinary patch and minor releases about seven days, and triages a security fix inside a day. Applied to this registry snapshot, a non-security pin must have been published on or before 2026-10-19. The behavior reads below are from the registry head where the head and the pin differ, and the scaffold re-reads those same files on the pinned tarball.

| Package | Registry head (published) | Proposed pin | Why that pin |
|---|---|---|---|
| `antd` | 6.6.8 (2026-10-26) | **6.6.6** (2026-10-12) | Newest 6.6 patch outside the hold. 6.6.7 (registry time 2026-10-20; changelog date 2026-10-19) is inside the hold and includes accessibility fixes the scaffold takes once the hold clears. |
| `lucide-react` | 1.61.0 (2026-10-21) | **1.59.0** (2026-10-17) | Newest 1.x outside the hold whose peer range includes React 19. |
| `style-dictionary` | 5.7.1 (2026-10-24) | **5.7.1** | Security triage. The v5.7.1 notes describe a prototype-pollution fix in `convertTokenData`. Tenant overrides are untrusted JSON. |
| `@mantine/core` | 9.7.4 (2026-10-25) | comparison only | Peer `react` `^19.2.0`. |
| `@mui/material` | 9.5.0 (2026-10-09) | comparison only | MIT. Emotion and Pigment CSS peers are optional. |
| `@mui/x-data-grid` | 9.16.0 (2026-10-20) | comparison only | Community package is MIT. |
| `react` / `vite` | 19.3.1 / 8.3.5 | chosen elsewhere | Spec §9 already sets React 19 + Vite. All three kits' peers accept React 19. This record leaves those versions to the scaffold. |

The repo's Node major is 24 (`.nvmrc`). Style Dictionary 5.7.1 requires Node `>=22`. Vite 8.3.5 requires `^20.19.0` or `>=22.12.0`. Both ranges contain Node 24.

## UI kit

### 1. Ant Design 6 + lucide-react

`antd` 6.6.8 is MIT, peers `react` `>=18`, and depends on `@ant-design/cssinjs` `^2.1.2` (MIT). The v6 line is the CSS-variable line the spec names. The current customize-theme document gives `ConfigProvider` a `theme` object with `token`, `algorithm` (including `darkAlgorithm`), `cssVar`, and, since 6.0.0, `zeroRuntime`. The v6 CSS note (2025-05-23) describes component rules that read custom properties. `zeroRuntime` turns off runtime style generation and then requires an imported stylesheet (`antd/dist/antd.css`, or a static extract). The css-in-js dependency is still in the 6.6.8 manifest. "CSS-variables-native" means the dynamic values are custom properties. Runtime generation stays available, and `zeroRuntime` is the switch that turns it off.

Seed token `colorPrimary` defaults to `#1677ff`. The theme document says the algorithm derives the palette from that seed. Derivation is color math on the seed, so the adapter passes a resolved color.

The locale document lists `ru_RU`, `kk_KZ`, and `uz_UZ`. The 6.6.8 locale directory contains those three files among 77. This record checked presence, and it leaves translation quality to the locale-parity work.

Table columns in 6.6.8 declare `sorter`, `filters`, and `onFilter` on Ant Design's own column type. `fixed` is declared on the column type of `@rc-component/table` 1.11.1, which `antd` 6.6.8 depends on (`~1.11.1`). Sort, filter, and pinned columns are in the MIT table.

`@rc-component/select` 1.10.1, which `antd` 6.6.8 depends on (`~1.10.1`), sets `realVirtual = virtual !== false && popupMatchSelectWidth !== false`. Virtualization is the default. Spec §9's screen-reader path passes `virtual={false}`.

Dark neutrals come from `generateNeutralColorPalettes`: `colorBgContainer` is `getSolidColor(colorBgBase || '#000', 8)`, and `getSolidColor` is `FastColor.lighten`. Lighten-by-8 from black is HSL lightness 0.08, which for a neutral is `#141414`. That is the dark container used in the measurements below.

The resources page retrieved the same day marks the Figma libraries as third-party and marks the Sketch symbol files as official. D13's openness note expected an official Figma kit that imports into Pixso. This record did not re-run a Pixso import. The license and the published component API are the openness facts checked here.

Product icons are `lucide-react` (ISC, an allowed license). Ant Design's transitive `@ant-design/icons` stays inside the kit.

### 2. Mantine 9

`@mantine/core` 9.7.4 is MIT and peers React `^19.2.0`, which React 19.3.1 satisfies. `MantineProvider` injects theme custom properties, and `cssVariablesResolver` can add more. A color entry is a 10-shade tuple. Light and dark are built in. The 8-to-9 migration changes the light-variant colors and the default radius.

Dates live in `@mantine/dates` and require dayjs. The dates document localizes through a dayjs locale import. dayjs ships `ru`, `kk`, and `uz` (the locale files resolve on the dayjs CDN). The core `Table` document shows a styled table whose headers and cells are caller-supplied nodes. Sort and filter are caller-owned. A shell that needs an enterprise grid would build that grid, which is the bespoke library invariant 7 rules out.

### 3. Material UI 9, core plus X Community

`@mui/material` 9.5.0 is MIT. Its Emotion and Pigment CSS peers are optional (`peerDependenciesMeta`). The CSS-theme-variables document describes variables injected before paint, including a light and dark pair. The tag `v9.5.0` locale directory contains `ruRU.ts` and `kkKZ.ts` among 61 files, and it contains no Uzbek file.

MUI X Community (`@mui/x-data-grid` 9.16.0) is MIT. The licensing document keeps Pro and Premium on a commercial license: multi-filtering, multi-sorting, column resizing, and column pinning are Pro; row grouping and Excel export are Premium. An Apache-2.0 appliance that later needed those grid features would take a commercial dependency. Invariant 8 closes that path. The Community grid is the only grid this license allows, and it is a thinner grid than the MIT Ant Design table.

## Kit comparison

| | Ant Design 6 | Mantine 9 | Material UI 9 + X Community |
|---|---|---|---|
| License | MIT kit. ISC icons. | MIT. | MIT core and Community grid. Pro and Premium are commercial. |
| React 19 | Peer `>=18`. | Peer `^19.2.0`. | Peer `^17 \|\| ^18 \|\| ^19`. |
| CSS variables | `theme.cssVar`. Runtime css-in-js still ships; `zeroRuntime` is opt-in since 6.0.0. | Provider injects variables from the theme. | CSS theme variables are documented. Emotion and Pigment are optional peers. |
| Locales ru / kk / uz | `ru_RU`, `kk_KZ`, `uz_UZ` present in 6.6.8 and listed in the locale document. | Dates follow dayjs, which ships all three. Component chrome is caller-supplied. | `ruRU` and `kkKZ` on the v9.5.0 tag. No Uzbek file in that directory. |
| Admin grid inside the OSS license | Sort, filter, and fixed columns in the MIT table. | Styled table. Sort and filter are application code. | Community grid. Column pinning and several richer grid features are commercial. |
| Adapter shape | `ConfigProvider` `theme.token` plus `darkAlgorithm`, fed with resolved colors. | A 10-shade tuple on `theme.colors`. | Palette plus CSS theme variables. |
| Fit to D13 | The register's choice. Dense components, the three CIS locales, a CSS-variable theme. | The register's documented fallback. The missing grid and the missing component locales are the gap. | The license split D13 already flagged is still there in 2026. |

## Token compiler

D14's compiler is a pure function of `(defaults, tenant override, schema) → CSS`. Bootstrap writes the published default revision to a stylesheet the shell document loads before the React module. Admin preview and publish call the same function. The output custom properties are `--plerni-*`. The kit's own variables stay behind the adapter. Plugins read the product variables.

The compiler also enforces the parts a general tool does not know: `schemaVersion`, monotonic `revision`, an allowlist of overridable semantic tokens, numeric ranges, and contrast. Tenant JSON is data. The pre-pass rejects a document that fails those rules, and it rejects it before any CSS is emitted.

### 1. Style Dictionary 5

`style-dictionary` 5.7.1 is Apache-2.0 and requires Node `>=22`. The config document auto-detects DTCG (`$value`, `$type`, `$description`). The built-in `css/variables` format emits custom properties, with a `selector` option (string or list) and `outputReferences` for `var()` aliases. `formatPlatform` returns each file's `output` string and does not require a disk write, which is the preview path. `tokens` may be passed inline. A `volume` option can substitute a memory filesystem when a build does write.

Light and dark are two `css/variables` outputs, one selector each (`:root` for light, `[data-color-scheme="dark"]` for dark), concatenated into one stylesheet. The product prefix is `plerni`.

The v5.7.1 release fixes a prototype-pollution bug in `convertTokenData`. That is why the pin is the registry head rather than 5.7.0 (2026-10-16), which would otherwise be the hold-cleared build. The allowlist pre-pass is still required. The published fix is the floor for the library that walks the token object.

### 2. Terrazzo 2

`@terrazzo/cli` and `@terrazzo/plugin-css` 2.10.0 are MIT. The CSS plugin writes custom properties from DTCG tokens and can attach a mode to a selector, which matches light and dark directly. The CLI also validates a token file against DTCG. The documented pipeline writes files (`tz build`). The plugin API's build step writes files too. Preview would wrap that, or re-implement the emit. The project's own comparison treats Style Dictionary as the tool it is catching up to. Invariant 5 asks for mainstream, documented, widely modeled technology. Style Dictionary is that tool. Terrazzo is the closer mode feature on a smaller toolchain.

### 3. An in-repo resolver

A small TypeScript function can resolve a DTCG subset, check contrast and ranges, and print `--plerni-*` rules. One function would serve bootstrap, preview, and publish, with no compiler upgrade in the loop. The cost is owning alias resolution, mode cascade, and the bugs those imply, and leaving the mainstream toolchain. D14's "own schema" is the token document and the product variable names. It is the contract. The resolver can be a pinned library behind that contract. The in-repo function remains the fallback named in the flip conditions, with the same input and the same CSS shape.

## Compiler comparison

| | Style Dictionary 5.7.1 | Terrazzo 2.10.0 | In-repo resolver |
|---|---|---|---|
| License | Apache-2.0 | MIT | None |
| DTCG | Auto-detected. | Parse and check are the product. | Whatever subset we write. |
| CSS variables | `css/variables`, selector option, `var()` references. | `plugin-css`, mode selectors. | Hand-written. |
| Preview without a side file | `formatPlatform` returns the output string. | Documented path writes files. | Natural. |
| Light and dark | Two selectors, one concatenated sheet. | Mode selectors are first-class. | Natural. |
| Contrast, ranges, `schemaVersion` | Our pre-pass. The library resolves and prints. | Our pre-pass. | All of it is ours. |
| Untrusted tenant JSON | 5.7.1 fixes a published prototype-pollution bug on the convert path. The allowlist still runs first. | Our allowlist. | Our parser. |
| Mainstream (invariant 5) | The usual token compiler. | Smaller toolchain. Its own docs measure itself against Style Dictionary. | Ours alone. |

## Decision

1. **The kit is Ant Design 6, pinned for the scaffold at `antd@6.6.6`.** The scaffold re-reads the locale files, the css-in-js dependency, the dark neutral function, the Select virtual default, and the Table column fields on that tarball. It moves to `6.6.7` or a later 6.6 patch after that patch has cleared the §14 hold, because 6.6.7 carries accessibility fixes (warning text wired through `aria-describedby`; duplicate button semantics on the editable typography icon). A mismatch on the re-read reopens the pin. It leaves the kit choice in place. Icons in product code come from `lucide-react@1.59.0`, re-exported by the single component-allowlist package spec §9 requires. The kit's own icons stay inside the kit.
2. **The adapter is `ConfigProvider`.** It passes resolved colors into `theme.token` and selects `darkAlgorithm` for the dark mode. It sets alias tokens where the derived ramp would miss the contrast gate. It leaves the Ant Design variable prefix on `ant`. Product custom properties use the prefix `plerni`. Plugin styles use `--plerni-*`. `zeroRuntime` stays off until the fixture gallery shows that a static extract matches this map. The v6 behavior this paragraph records is the watch spec §9 asks for.
3. **The compiler is Style Dictionary `5.7.1`, behind a Plerni function.** That function checks `schemaVersion`, `revision`, the semantic allowlist, the numeric ranges, and contrast, then calls `formatPlatform` and returns one CSS document. Bootstrap, preview, and publish call that function. The default revision is a static sheet linked before the React module. A tenant publish stores the revision and the resolved CSS. Preview applies the draft CSS in the preview frame before that frame mounts React.
4. **Token layers are foundation, semantic (including states), and component roles.** Tenant overrides patch semantic tokens inside declared ranges. They arrive as JSON data. The pre-pass rejects unknown keys, out-of-range numbers, and failed contrast. DTCG is the token body. `schemaVersion` and `revision` sit in a sibling envelope, because they are our document rules.
5. **The default palette is unresolved, with a working direction.** Token architecture is decided. The maintainer's selection among the three plan §12 directions is pending. The validation direction is Scholarly Plum: light-theme primary `#6E3F73`. Deep Teal `#0F766E` and Burnished Copper `#A44727` stay the alternatives. Light and dark both ship. The light primary is a concrete input to the light theme. The dark theme gets its own resolved values. The validation path is the one plan §12 names: this compiler, then the Ant Design adapter, on the future fixture gallery; light and dark; long Russian labels; a ranking with two procurement admins, two learning admins, and two developers.
6. **Accessibility is evidence on workflows, at WCAG 2.2 AA.** The kit's documentation is a lead. The shell's gallery and the role-chain passes are the proof. The spec §9 scenario list is the minimum: dates, table sort and filter, nested dialogs, labels and errors, zoom, tenant contrast, and `virtual={false}` where a screen reader must see the whole list. Color is one signal among others (interface principle 10).

### Measurements for the three anchors

Method: WCAG 2.x relative luminance from sRGB, contrast `(L1 + 0.05) / (L2 + 0.05)`. The dark surface is `#141414`, the Ant Design 6.6.8 dark `colorBgContainer` derived above. Ratios are rounded to two decimals. These are this record's measurements. The β consultation's own sheet stays with the maintainer.

| Pair | Ratio | Text, 4.5:1 (SC 1.4.3) | UI, 3:1 (SC 1.4.11) |
|---|---|---|---|
| `#6E3F73` on `#FFFFFF`, and white on `#6E3F73` | 8.01 | pass | pass |
| `#6E3F73` on `#141414` | 2.30 | fail | fail |
| `#0F766E` on `#FFFFFF`, and white on `#0F766E` | 5.47 | pass | pass |
| `#0F766E` on `#141414` | 3.37 | fail | pass |
| `#A44727` on `#FFFFFF`, and white on `#A44727` | 5.98 | pass | pass |
| `#A44727` on `#141414` | 3.08 | fail | pass |
| White on the Ant Design default seed `#1677ff` | 4.10 | fail | pass |

Plum as a light-theme primary passes for small text on white and for a white label on a plum fill. The same hex fails as text, icon, or boundary on the dark container. A filled primary button may keep the plum fill with a white label in both modes, because the contrast there is the label against the fill (8.01). Dark-theme text and icons use a lighter resolved color. A linear sRGB mix of `#6E3F73` toward white by 27 percent is `#957399`, at 4.55:1 on `#141414`. White on `#957399` is 4.05:1, so that mix illustrates a text candidate and a poor white-label fill. It is an illustration of the gate. The compiler's derivation function is chosen at scaffold, and the gate is the rule.

The default Ant Design seed fails 4.5:1 for a white label. Shipping that seed would fail the bar this record just set. The adapter replaces it.

## Consequences

- The scaffold adds `antd@6.6.6`, `lucide-react@1.59.0`, and `style-dictionary@5.7.1`, then re-checks the files named in decision 1 and the `formatPlatform` return shape on those tarballs. Lockfile ranges match those pins. License audit already allows MIT, ISC, and Apache-2.0.
- One re-export package is the component and icon allowlist. The declarative grammar names those exports. Plugins do not import `antd` or `lucide-react`.
- Token lint (spec §9) rejects literal colors and unknown tokens in CSS and in style objects, and it rejects `--ant-*` outside the adapter.
- Admin theme publish runs the compiler. A failed contrast or range check publishes nothing.
- `kk_KZ` and `uz_UZ` file presence is a head start for D15. The locale-parity gate still compares product strings. It judges the kit catalogs when those catalogs are wired.
- The Figma gap is recorded. Design handoff can use a third-party Figma library. This record does not make that library a dependency.
- Mantine stays the documented kit fallback (D13). Material UI stays out while Pro and Premium are commercial.
- Terrazzo and an in-repo emitter stay compiler fallbacks. They must emit the same `--plerni-*` sheet and the same two selectors.

## Flip conditions

- **D13.** A procurement-critical accessibility scenario fails on the pinned kit, or a deployment requires pixel fidelity the adapter cannot reach. The response is a new adapter (the Mantine fallback first), with the token names kept. A failed scenario is evidence from the gallery, recorded against the pinned version.
- **D14.** The token contract stays. Versions of the compiler move under §14. The contract — layers, `--plerni-*`, the envelope, the contrast gate, the adapter boundary — is the insurance layer.
- **Compiler implementation.** If `formatPlatform` on `style-dictionary@5.7.1` cannot return the CSS string in-process, the in-repo emitter replaces it behind the same function. That event leaves the kit in place.
- **Kit pin.** A 6.x release that removes `theme.cssVar` or stops applying `theme.token` to the components in the allowlist reopens decision 1. A patch inside 6.6 that preserves those behaviors updates the pin under §14.
- **Palette.** The maintainer's choice among the three anchors, or a later anchor that passes the same contrast gate, updates decision 5. It leaves decisions 1–4 in place.

## Sources

Retrieved 2026-10-26. Registry times are npm `time` values. Package files were read from the published tarball or from the git tag named below.

- Ant Design customize theme (`theme.token`, `darkAlgorithm`, `cssVar`, `zeroRuntime` since 6.0.0, seed `colorPrimary` default `#1677ff`), <https://ant.design/docs/react/customize-theme/>
- Ant Design, CSS in v6 (2025-05-23), <https://ant.design/docs/blog/css-tricks/>
- Ant Design internationalization (`ru_RU`, `kk_KZ`, `uz_UZ` listed), <https://ant.design/docs/react/i18n/>
- Ant Design resources (Sketch files marked official; Figma libraries marked third-party), <https://ant.design/docs/resources/>
- Ant Design changelog 6.6.6 (2026-10-12) and 6.6.7 (labeled 2026-10-19, including the `aria-describedby` and duplicate-button fixes), <https://ant.design/changelog/>
- `antd@6.6.8` manifest, locale directory, `theme/themes/dark`, and Table `interface.ts` at tag 6.6.8; `@rc-component/select@1.10.1` (`realVirtual`); `@rc-component/table@1.11.1` (`fixed`); `@ant-design/fast-color` `lighten` (HSL lightness plus `amount/100`)
- `lucide-react@1.59.0` peers `react` `^16.5.1 || ^17.0.0 || ^18.0.0 || ^19.0.0`, license ISC
- Mantine CSS variables, provider, 8-to-9 migration, core Table, dates getting started, <https://mantine.dev/styles/css-variables/>, <https://mantine.dev/theming/mantine-provider/>, <https://mantine.dev/guides/8x-to-9x/>, <https://mantine.dev/core/table/>, <https://mantine.dev/dates/getting-started/>
- Material UI CSS theme variables, <https://mui.com/material-ui/customization/css-theme-variables/overview/>
- MUI X licensing (Community MIT; Pro and Premium commercial), <https://mui.com/x/introduction/licensing/>
- MUI Material locale directory at tag `v9.5.0` (`ruRU.ts`, `kkKZ.ts`; no Uzbek file)
- Style Dictionary config (DTCG auto-detect), formats (`css/variables`, `selector`, `outputReferences`), and API (`formatPlatform` returns `output`), <https://styledictionary.com/reference/config/>, <https://styledictionary.com/reference/hooks/formats/predefined/>, <https://styledictionary.com/reference/api/>
- Style Dictionary v5.7.1 release notes (prototype-pollution fix in `convertTokenData`), <https://github.com/style-dictionary/style-dictionary/releases/tag/v5.7.1>
- Terrazzo CSS plugin, config, and getting-started comparison, <https://terrazzo.app/docs/integrations/css/>, <https://terrazzo.app/docs/reference/config/>, <https://terrazzo.app/docs/>
- WCAG 2.2 SC 1.4.3 Contrast (Minimum) and SC 1.4.11 Non-text Contrast, <https://www.w3.org/TR/WCAG22/>
