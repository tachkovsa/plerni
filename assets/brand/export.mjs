#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rebuild the Plerni brand SVGs from Nunito ExtraBold outlines plus one shared
 * sprout, then rasterize the favicon, avatar, and social files.
 *
 * Letterforms come from assets/brand/source/Nunito-ExtraBold.ttf (SIL OFL 1.1).
 * The sprout is original geometry. The square icons reuse the wordmark's `p`
 * path and the same sprout path; only the placement of that sprout changes
 * (above the i in the wordmark, above the p stem on the tile).
 *
 * Pinned tools, checked on the npm registry: opentype.js 2.0.0 (MIT),
 * sharp 0.35.5 (Apache-2.0). Run `npm ci && npm run export` in this directory.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";
import sharp from "sharp";

const root = dirname(fileURLToPath(import.meta.url));
const FONT_SIZE = 1000;

const INK = "#1F1A24";
const PLUM = "#6E3F73";
const MINT = "#BFE8D2";
const PAPER = "#FFFFFF";
const GROUND = "#3F1F44";

// Unit leaf, bottom tip at (0, 0), y up. The left leaf is this shape mirrored
// and traced in reverse so both windings match. Coordinates were drawn to the
// approved two-leaf sprout (a shallow notch, rounded tips, shared base).
const LEAF = [
  [[0.42, 0.0], [1.05, 0.18], [1.2, 0.52]],
  [[1.24, 0.74], [0.58, 1.02], [0.2, 0.72]],
  [[0.06, 0.52], [0.02, 0.22], [0.0, 0.0]],
];

const n = (v) => Number(v).toFixed(2);

function cmdsToD(cmds) {
  const parts = [];
  cmds.forEach((c, i) => {
    if (c.type === "M") {
      if (i > 0) parts.push("Z");
      parts.push(`M ${n(c.x)} ${n(c.y)}`);
    } else if (c.type === "L") parts.push(`L ${n(c.x)} ${n(c.y)}`);
    else if (c.type === "Q") parts.push(`Q ${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`);
    else if (c.type === "C") {
      parts.push(`C ${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`);
    } else if (c.type === "Z") parts.push("Z");
  });
  parts.push("Z");
  return parts.join(" ");
}

function glyphAt(font, ch, x) {
  const g = font.charToGlyph(ch);
  let cmds = g.getPath(x, 0, FONT_SIZE).commands;
  if (ch === "i") {
    const dot = cmds.findIndex((c, i) => i > 0 && c.type === "M");
    if (dot > 0) cmds = cmds.slice(0, dot);
  }
  const xs = cmds.filter((c) => c.x != null).map((c) => c.x);
  const ys = cmds.filter((c) => c.y != null).map((c) => c.y);
  return {
    d: cmdsToD(cmds),
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    advance: (g.advanceWidth * FONT_SIZE) / font.unitsPerEm,
  };
}

function sampleLeaf() {
  const pts = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (const [c1, c2, p] of LEAF) {
    for (let t = 1; t <= 16; t++) {
      const u = t / 16;
      const k = 1 - u;
      pts.push({
        x: k * k * k * x + 3 * k * k * u * c1[0] + 3 * k * u * u * c2[0] + u * u * u * p[0],
        y: k * k * k * y + 3 * k * k * u * c1[1] + 3 * k * u * u * c2[1] + u * u * u * p[1],
      });
    }
    x = p[0];
    y = p[1];
  }
  return pts;
}

/**
 * Sprout path in SVG space: bottom centre at (0, 0), growing upward (negative y).
 * The left leaf retraces the mirrored cubics so both contours share a winding.
 */
function sproutPath(width, height) {
  const samples = sampleLeaf();
  const maxX = Math.max(...samples.map((p) => p.x));
  const maxY = Math.max(...samples.map((p) => p.y));
  const sx = width / 2 / maxX;
  const sy = height / maxY;
  const xy = (px, py) => `${n(px * sx)} ${n(-py * sy)}`;
  const segsFor = (sign) =>
    LEAF.map(([c1, c2, p]) => [
      [sign * c1[0], c1[1]],
      [sign * c2[0], c2[1]],
      [sign * p[0], p[1]],
    ]);
  const forward = (segs) => {
    let d = "M 0 0";
    for (const [c1, c2, p] of segs) {
      d += ` C ${xy(c1[0], c1[1])} ${xy(c2[0], c2[1])} ${xy(p[0], p[1])}`;
    }
    return `${d} Z`;
  };
  const reversed = (segs) => {
    const start = segs[segs.length - 1][2];
    let d = `M ${xy(start[0], start[1])}`;
    for (let i = segs.length - 1; i >= 0; i--) {
      const [c1, c2] = segs[i];
      const end = i === 0 ? [0, 0] : segs[i - 1][2];
      d += ` C ${xy(c2[0], c2[1])} ${xy(c1[0], c1[1])} ${xy(end[0], end[1])}`;
    }
    return `${d} Z`;
  };
  return `${forward(segsFor(1))} ${reversed(segsFor(-1))}`;
}

function svgDoc(viewBox, body, label) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- SPDX-License-Identifier: Apache-2.0 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${label}">
  <title>${label}</title>
  ${body}
</svg>
`;
}

function buildMarks(font) {
  let x = 0;
  const glyphs = {};
  for (const ch of "plerni") {
    const g = glyphAt(font, ch, x);
    glyphs[ch] = g;
    x += g.advance;
  }
  const stemW = glyphs.i.maxX - glyphs.i.minX;
  const pStem = { cx: glyphs.p.minX + stemW / 2, top: glyphs.p.minY };
  const iStem = { cx: (glyphs.i.minX + glyphs.i.maxX) / 2, top: glyphs.i.minY };
  const sproutW = stemW * 1.55;
  const sproutH = stemW * 0.92;
  const gap = stemW * 0.38;
  const sprout = sproutPath(sproutW, sproutH);
  const letters = "plerni"
    .split("")
    .map((ch) => glyphs[ch].d)
    .join(" ");

  const word = (ink, leaf, background) => {
    const tx = iStem.cx;
    const ty = iStem.top - gap;
    const minX = Math.min(glyphs.p.minX, tx - sproutW / 2);
    const maxX = Math.max(glyphs.i.maxX, tx + sproutW / 2);
    const minY = ty - sproutH;
    const maxY = Math.max(..."plerni".split("").map((ch) => glyphs[ch].maxY));
    const pad = sproutH * 0.35;
    const vb = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2].map((v) => n(v));
    const bg = background ? `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${background}"/>` : "";
    const body = `${bg}
  <path fill="${ink}" d="${letters}"/>
  <path fill="${leaf}" transform="translate(${n(tx)} ${n(ty)})" d="${sprout}"/>`;
    return svgDoc(vb.join(" "), body, "plerni");
  };

  const icon = (tile, ink, leaf) => {
    const tx = pStem.cx;
    const ty = pStem.top - gap;
    const minX = Math.min(glyphs.p.minX, tx - sproutW / 2);
    const maxX = Math.max(glyphs.p.maxX, tx + sproutW / 2);
    const minY = ty - sproutH;
    const maxY = glyphs.p.maxY;
    const tileSize = 512;
    const fit = tileSize * 0.66;
    const s = Math.min(fit / (maxX - minX), fit / (maxY - minY));
    const ox = tileSize / 2 - ((minX + maxX) / 2) * s;
    const oy = tileSize / 2 - ((minY + maxY) / 2) * s;
    const rx = n(tileSize * 0.23);
    const body = `<rect width="${tileSize}" height="${tileSize}" rx="${rx}" fill="${tile}"/>
  <g transform="translate(${n(ox)} ${n(oy)}) scale(${n(s)})">
    <path fill="${ink}" d="${glyphs.p.d}"/>
    <path fill="${leaf}" transform="translate(${n(tx)} ${n(ty)})" d="${sprout}"/>
  </g>`;
    return svgDoc(`0 0 ${tileSize} ${tileSize}`, body, "plerni");
  };

  const og = () => {
    const tx = pStem.cx;
    const ty = pStem.top - gap;
    const minX = Math.min(glyphs.p.minX, tx - sproutW / 2);
    const maxX = Math.max(glyphs.p.maxX, tx + sproutW / 2);
    const minY = ty - sproutH;
    const maxY = glyphs.p.maxY;
    const width = 1280;
    const height = 640;
    const fit = height * 0.62;
    const s = Math.min(fit / (maxX - minX), fit / (maxY - minY));
    const ox = width / 2 - ((minX + maxX) / 2) * s;
    const oy = height / 2 - ((minY + maxY) / 2) * s;
    const body = `<rect width="${width}" height="${height}" fill="${GROUND}"/>
  <g transform="translate(${n(ox)} ${n(oy)}) scale(${n(s)})">
    <path fill="${PAPER}" d="${glyphs.p.d}"/>
    <path fill="${MINT}" transform="translate(${n(tx)} ${n(ty)})" d="${sprout}"/>
  </g>`;
    return svgDoc(`0 0 ${width} ${height}`, body, "plerni");
  };

  return {
    pPath: glyphs.p.d,
    sprout,
    wordLight: word(INK, PLUM, PAPER),
    wordDark: word(PAPER, MINT, GROUND),
    wordMono: word(INK, INK, null),
    iconLight: icon(PAPER, INK, PLUM),
    iconDark: icon(GROUND, PAPER, MINT),
    og: og(),
  };
}

function ico(pngs) {
  const count = pngs.length;
  const header = 6 + count * 16;
  let offset = header;
  const dir = Buffer.alloc(header);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);
  pngs.forEach(({ size, buffer }, i) => {
    const at = 6 + i * 16;
    dir.writeUInt8(size, at);
    dir.writeUInt8(size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(buffer.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += buffer.length;
  });
  return Buffer.concat([dir, ...pngs.map((p) => p.buffer)]);
}

async function raster(svg, width, height, flatten) {
  // Height is set only when the SVG viewBox already has that aspect (icons, social).
  // Wordmarks pass height=null so the outlined proportions are not stretched.
  let pipeline = height
    ? sharp(Buffer.from(svg)).resize(width, height, { fit: "fill" })
    : sharp(Buffer.from(svg)).resize({ width });
  if (flatten) pipeline = pipeline.flatten({ background: flatten });
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}

function nearest(r, g, b, palette) {
  let name = null;
  let best = 3600;
  for (const [label, c] of palette) {
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < best) {
      best = d;
      name = label;
    }
  }
  return name;
}

async function centroid(buffer, palette, label) {
  const { data, info } = await sharp(buffer)
    .resize({ width: 180 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sx = 0;
  let sy = 0;
  let sn = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (nearest(data[i], data[i + 1], data[i + 2], palette) === label) {
        sx += x;
        sy += y;
        sn++;
      }
    }
  }
  if (sn < 8) throw new Error(`too few ${label} pixels (${sn})`);
  return { x: sx / sn, y: sy / sn, n: sn };
}

async function main() {
  const bytes = await readFile(join(root, "source", "Nunito-ExtraBold.ttf"));
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const fullName = font.names?.windows?.fullName?.en ?? font.names?.windows?.fontFamily?.en;
  if (!String(fullName).includes("Nunito")) {
    throw new Error(`expected Nunito ExtraBold, name table says ${fullName}`);
  }
  const marks = buildMarks(font);
  for (const svg of [marks.wordLight, marks.wordDark, marks.wordMono, marks.iconLight, marks.iconDark, marks.og]) {
    if (!svg.includes(marks.pPath) || !svg.includes(marks.sprout)) {
      throw new Error("a mark dropped the shared p path or the shared sprout path");
    }
  }
  if (marks.iconLight.split(marks.sprout).length !== marks.wordLight.split(marks.sprout).length) {
    throw new Error("sprout path is not shared equally");
  }

  const files = {
    "svg/wordmark-light.svg": marks.wordLight,
    "svg/wordmark-dark.svg": marks.wordDark,
    "svg/wordmark-mono.svg": marks.wordMono,
    "svg/icon-light.svg": marks.iconLight,
    "svg/icon-dark.svg": marks.iconDark,
    "svg/favicon.svg": marks.iconDark,
  };
  for (const dir of ["svg", "png", "social"]) await mkdir(join(root, dir), { recursive: true });
  for (const [rel, text] of Object.entries(files)) await writeFile(join(root, rel), text);

  const jobs = [
    ["png/wordmark-light.png", marks.wordLight, 1600, null, null],
    ["png/wordmark-dark.png", marks.wordDark, 1600, null, null],
    ["png/icon-light.png", marks.iconLight, 1024, 1024, null],
    ["png/icon-dark.png", marks.iconDark, 1024, 1024, null],
    ["png/favicon-16.png", marks.iconDark, 16, 16, GROUND],
    ["png/favicon-32.png", marks.iconDark, 32, 32, GROUND],
    ["png/apple-touch-icon.png", marks.iconDark, 180, 180, GROUND],
    ["png/icon-192.png", marks.iconDark, 192, 192, GROUND],
    ["png/icon-512.png", marks.iconDark, 512, 512, GROUND],
    ["social/og.png", marks.og, 1280, 640, null],
    ["social/avatar-400.png", marks.iconDark, 400, 400, null],
    ["social/avatar-1024.png", marks.iconDark, 1024, 1024, null],
  ];
  const written = {};
  for (const [rel, svg, w, h, flatten] of jobs) {
    const buf = await raster(svg, w, h, flatten);
    await writeFile(join(root, rel), buf);
    const meta = await sharp(buf).metadata();
    if (meta.width !== w || (h && meta.height !== h)) {
      throw new Error(`${rel} is ${meta.width}x${meta.height}`);
    }
    written[rel] = buf;
    console.log(`${rel} ${meta.width}x${meta.height}`);
  }

  const icoBuf = ico([
    { size: 16, buffer: written["png/favicon-16.png"] },
    { size: 32, buffer: written["png/favicon-32.png"] },
    { size: 48, buffer: await raster(marks.iconDark, 48, 48, GROUND) },
  ]);
  await writeFile(join(root, "favicon.ico"), icoBuf);
  console.log(`favicon.ico ${icoBuf.length} bytes (16+32+48)`);

  const lightPalette = [
    ["sprout", [110, 63, 115]],
    ["ink", [31, 26, 36]],
    ["paper", [255, 255, 255]],
  ];
  const darkPalette = [
    ["sprout", [191, 232, 210]],
    ["ink", [255, 255, 255]],
    ["ground", [63, 31, 68]],
  ];
  const iconLight = await Promise.all([
    centroid(written["png/icon-light.png"], lightPalette, "sprout"),
    centroid(written["png/icon-light.png"], lightPalette, "ink"),
  ]);
  if (!(iconLight[0].x < iconLight[1].x - 8) || !(iconLight[0].y < iconLight[1].y - 8)) {
    throw new Error(`light icon sprout is not above the p stem: ${JSON.stringify(iconLight)}`);
  }
  const wordLight = await Promise.all([
    centroid(written["png/wordmark-light.png"], lightPalette, "sprout"),
    centroid(written["png/wordmark-light.png"], lightPalette, "ink"),
  ]);
  if (!(wordLight[0].x > wordLight[1].x) || !(wordLight[0].y < wordLight[1].y)) {
    throw new Error(`wordmark sprout is not above the i: ${JSON.stringify(wordLight)}`);
  }
  const iconDark = await centroid(written["png/icon-dark.png"], darkPalette, "sprout");
  const iconDarkInk = await centroid(written["png/icon-dark.png"], darkPalette, "ink");
  if (!(iconDark.x < iconDarkInk.x - 8) || !(iconDark.y < iconDarkInk.y - 8)) {
    throw new Error(`dark icon sprout is not above the p stem`);
  }
  console.log("placement checks ok", {
    iconSprout: iconLight[0],
    iconInk: iconLight[1],
    wordSprout: wordLight[0],
  });
  console.log(`font ${fullName}; shared p path ${marks.pPath.length} chars; shared sprout ${marks.sprout.length} chars`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
