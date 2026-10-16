# Plerni brand

The mark is the lowercase word **plerni** in a rounded sans. The dot of the **i** is a two-leaf sprout. The square icon is the same **p** and the same sprout, with the sprout sitting above the left stem the way a tittle sits above an **i**.

Letterforms are outlines of **Nunito SemiBold** (weight 600; Copyright 2014 The Nunito Project Authors), licensed under the SIL Open Font License 1.1. The licence is [`source/OFL.txt`](source/OFL.txt). The font file is only for rebuilding the outlines. Every shipped SVG is paths, so nothing needs the font at runtime. The sprout is original geometry, and the icon SVGs reuse the wordmark's `p` path and sprout path unchanged.

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#1F1A24` | Light-theme letters, light-icon **p**, monochrome mark |
| Sprout plum | `#6E3F73` | Light-theme sprout |
| Paper | `#FFFFFF` | Light ground, light tile, dark-theme letters |
| Sprout mint | `#BFE8D2` | Dark-theme sprout |
| Deep plum | `#3F1F44` | Dark ground and dark tile |

Deep plum is `#3F1F44`. It is the dark theme ground: the same hue family as the plum sprout, darkened.

## Light and dark

- On white or near-white, use the light wordmark (ink letters, plum sprout) or the light icon (white tile).
- On deep plum, use the dark wordmark (white letters, mint sprout) or the dark icon.
- Monochrome (`svg/wordmark-mono.svg`) is a single ink fill, including the sprout. Recolour the whole mark together for one-colour reproduction. Do not recolour the sprout on its own.
- `svg/favicon.svg` is the dark icon.

## Clear space and minimum size

Clear space around the wordmark is the height of the sprout (the leaf pair above the **i**), on every side. Do not set type, rules, or other marks inside it.

Do not reproduce the wordmark below 96px wide. Do not reproduce the icon tile below 32px, except the 16px favicon, where the same drawing is simply smaller.

## Don'ts

- Do not redraw the **p**, the other letters, or the sprout. Scale the vectors.
- Do not move the sprout off the **i** (wordmark) or off the **p** stem (icon), and do not put a round dot back.
- Do not set the light colours on deep plum, or the dark colours on white.
- Do not stretch, rotate, outline, shadow, or place the mark on a photograph.
- Do not typeset the wordmark in another face. In running text the name is **plern🌱**.

## Files

```
svg/wordmark-light.svg      ink + plum sprout on white
svg/wordmark-dark.svg       white + mint sprout on deep plum
svg/wordmark-mono.svg       ink only, no ground
svg/icon-light.svg          sprouting p on a white rounded tile
svg/icon-dark.svg           sprouting p on a deep-plum rounded tile
svg/favicon.svg             same artwork as the dark icon
png/                        previews, plus the favicon PNGs below
favicon.ico                 16, 32 and 48
social/og.png               1280×640, dark icon mark on deep plum
social/avatar-400.png       dark icon tile
social/avatar-1024.png      dark icon tile
```

Favicon PNGs: `png/favicon-16.png`, `png/favicon-32.png`, `png/apple-touch-icon.png` (180), `png/icon-192.png`, `png/icon-512.png`. Those rasters, and the `.ico`, are flattened onto `#3F1F44` so the platform icon is opaque. The SVG tile keeps its rounded corners. Avatars are the dark icon tile, corners included.

## Web app manifest

Paths below are filenames from this directory, copied to wherever the site serves them.

```json
{
  "name": "Plerni",
  "short_name": "Plerni",
  "icons": [
    { "src": "favicon.svg", "sizes": "any", "type": "image/svg+xml" },
    { "src": "favicon-32.png", "sizes": "32x32", "type": "image/png" },
    { "src": "apple-touch-icon.png", "sizes": "180x180", "type": "image/png" },
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#3F1F44",
  "background_color": "#FFFFFF"
}
```

## Rebuilding the rasters

From this directory, with Node 22 or newer:

```
npm ci --ignore-scripts
npm run export
```

`export.mjs` rewrites the SVGs and the PNG/ICO files. Dependencies are pinned and were checked against the npm registry on 2026-10-15: `opentype.js` 2.0.0 (MIT) and `@napi-rs/canvas` 1.0.11 (MIT). They are tools for this directory only, not appliance dependencies. The repository license-audit gate reads every installed manifest in that dependency graph, including transitive dependencies, peer dependencies, and a required peer that is the package's only external declaration. An optional root peer is not added to that walk. Optional packages for other platforms are not installed on this machine. The gate downloads each locked tarball, checks its integrity, and reads the license from that package's manifest, including a required peer that manifest declares. A child is audited at the version the lockfile selects for that parent, even when another version of the same name is already installed. An optional peer that is not installed is skipped. A missing tarball, a failed integrity check, or a name or version that does not match the lock entry fails closed. An optional peer that this install did not select is skipped. CI installs them with `npm ci --ignore-scripts`, runs `npm run export`, and fails if `git status --porcelain` reports any change under the SVG, PNG, or ICO paths. A missing lockfile, or a locked version that does not satisfy the manifest range, fails the gate. The lockfile's own license field is not the source of the decision. The export refuses any Nunito face other than SemiBold weight 600, checks that every mark still contains the shared `p` path and the shared sprout path, and checks that the sprout's raster centre stays within 2px of the **p** stem (icon) or the **i** stem (wordmark) on a 180px-wide sample. Fully transparent pixels are left out of that sample.
