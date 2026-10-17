#!/usr/bin/env node
/**
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rebuild the Plerni brand SVGs from Nunito SemiBold outlines plus one shared
 * sprout, then rasterize the favicon, avatar, and social files.
 *
 * Letterforms come from assets/brand/source/Nunito-SemiBold.ttf (SIL OFL 1.1).
 * The sprout is original geometry. The square icons reuse the wordmark's `p`
 * path and the same sprout path; only the placement of that sprout changes
 * (above the i in the wordmark, above the p stem on the tile).
 *
 * Pinned tools, checked on the npm registry on 2026-10-15: opentype.js 2.0.0
 * (MIT) and @napi-rs/canvas 1.0.11 (MIT, including its optional platform
 * packages). The canvas Image constructor rasterizes an SVG buffer at the
 * width and height it is given. Run `npm ci --ignore-scripts && npm run export` here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, Image, loadImage } from "@napi-rs/canvas";
import opentype from "opentype.js";

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
  const xs = [];
  const ys = [];
  for (const c of cmds) {
    for (const key of ["x", "x1", "x2"]) if (c[key] != null) xs.push(c[key]);
    for (const key of ["y", "y1", "y2"]) if (c[key] != null) ys.push(c[key]);
  }
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

  const wordTx = iStem.cx;
  const wordTy = iStem.top - gap;
  // Every glyph, including ascenders taller than the sprout (the l), plus the sprout.
  const boxes = Object.values(glyphs);
  const wordMinX = Math.min(...boxes.map((g) => g.minX), wordTx - sproutW / 2);
  const wordMaxX = Math.max(...boxes.map((g) => g.maxX), wordTx + sproutW / 2);
  const wordMinY = Math.min(...boxes.map((g) => g.minY), wordTy - sproutH);
  const wordMaxY = Math.max(...boxes.map((g) => g.maxY), wordTy);
  const wordPad = sproutH * 0.35;
  const wordView = {
    x: wordMinX - wordPad,
    y: wordMinY - wordPad,
    w: wordMaxX - wordMinX + wordPad * 2,
    h: wordMaxY - wordMinY + wordPad * 2,
  };
  const word = (ink, leaf, background) => {
    const vb = [wordView.x, wordView.y, wordView.w, wordView.h].map((v) => n(v));
    const bg = background ? `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${background}"/>` : "";
    const body = `${bg}
  <path fill="${ink}" d="${letters}"/>
  <path fill="${leaf}" transform="translate(${n(wordTx)} ${n(wordTy)})" d="${sprout}"/>`;
    return svgDoc(vb.join(" "), body, "plerni");
  };

  const iconTx = pStem.cx;
  const iconTy = pStem.top - gap;
  const iconMinX = Math.min(glyphs.p.minX, iconTx - sproutW / 2);
  const iconMaxX = Math.max(glyphs.p.maxX, iconTx + sproutW / 2);
  const iconMinY = iconTy - sproutH;
  const iconMaxY = glyphs.p.maxY;
  const tileSize = 512;
  const fit = tileSize * 0.66;
  const iconScale = Math.min(fit / (iconMaxX - iconMinX), fit / (iconMaxY - iconMinY));
  const iconOx = tileSize / 2 - ((iconMinX + iconMaxX) / 2) * iconScale;
  const iconOy = tileSize / 2 - ((iconMinY + iconMaxY) / 2) * iconScale;
  const icon = (tile, ink, leaf) => {
    const rx = n(tileSize * 0.23);
    const body = `<rect width="${tileSize}" height="${tileSize}" rx="${rx}" fill="${tile}"/>
  <g transform="translate(${n(iconOx)} ${n(iconOy)}) scale(${n(iconScale)})">
    <path fill="${ink}" d="${glyphs.p.d}"/>
    <path fill="${leaf}" transform="translate(${n(iconTx)} ${n(iconTy)})" d="${sprout}"/>
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
    // Stem targets are the glyph stems, not the translate used to draw the sprout.
    wordPlace: { view: wordView, ox: 0, oy: 0, s: 1, stemCx: iStem.cx, stemTop: iStem.top, gap, sproutH },
    iconPlace: {
      view: { x: 0, y: 0, w: tileSize, h: tileSize },
      ox: Number(n(iconOx)),
      oy: Number(n(iconOy)),
      s: Number(n(iconScale)),
      stemCx: pStem.cx,
      stemTop: pStem.top,
      gap,
      sproutH,
    },
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

// Move the viewBox origin to (0, 0). A negative origin (the wordmark) is
// otherwise cropped by the rasterizer.
function normalizeSvg(svg) {
  const match = /viewBox="([^"]+)"/.exec(svg);
  if (!match) throw new Error("svg is missing a viewBox");
  const [x, y, w, h] = match[1].split(/\s+/).map(Number);
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <g transform="translate(${-x} ${-y})">
  ${inner}
  </g>
</svg>
`;
}

function pixelSize(svg, width, height) {
  // Height is set only when the SVG viewBox already has that aspect (icons, social).
  // Wordmarks pass height=null so the outlined proportions are not stretched.
  if (height) return { width, height };
  const [, , vw, vh] = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
  return { width, height: Math.round(width / (vw / vh)) };
}

function drawSvg(svg, width, height, flatten) {
  const img = new Image(width, height);
  img.src = Buffer.from(normalizeSvg(svg));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (flatten) {
    ctx.fillStyle = flatten;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

function raster(svg, width, height, flatten) {
  const size = pixelSize(svg, width, height);
  return drawSvg(svg, size.width, size.height, flatten).toBuffer("image/png");
}

async function decodePng(buffer) {
  // loadImage decodes the encoded PNG. Assigning the buffer to Image.src
  // reports the size and then draws an empty frame.
  const img = await loadImage(buffer);
  if (!img.width || !img.height) throw new Error("could not decode png");
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, img.width, img.height);
  return { data: image.data, width: img.width, height: img.height };
}

const SAMPLE_W = 180;
const COLOR_RADIUS = 30;

async function centroid(buffer, rgb) {
  const { data, width, height } = await decodePng(buffer);
  const scale = SAMPLE_W / width;
  let sx = 0;
  let sy = 0;
  let sn = 0;
    for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Rounded-tile corners are transparent and their RGB is 0. Skip them
      // before matching, and keep only pixels close to the sprout colour so
      // antialiased letter edges are not counted as the sprout.
      if (data[i + 3] < 16) continue;
      const d = (data[i] - rgb[0]) ** 2 + (data[i + 1] - rgb[1]) ** 2 + (data[i + 2] - rgb[2]) ** 2;
      if (d > COLOR_RADIUS * COLOR_RADIUS) continue;
      sx += x;
      sy += y;
      sn++;
    }
  }
  if (sn < 8) throw new Error(`too few sprout pixels (${sn})`);
  return { x: (sx / sn) * scale, y: (sy / sn) * scale, n: sn };
}

// Expected sprout centre from the stem, the gap, and the sprout height.
// This does not read the translate that draws the sprout, so a drifted
// translate fails the 2px bound on the SAMPLE_W-wide raster.
function stemTarget(place) {
  const x = place.ox + place.stemCx * place.s;
  const y = place.oy + (place.stemTop - place.gap - place.sproutH / 2) * place.s;
  const view = place.view;
  const x0 = Number(n(view.x));
  const y0 = Number(n(view.y));
  const w = Number(n(view.w));
  const h = Number(n(view.h));
  return {
    x: ((x - x0) / w) * SAMPLE_W,
    y: ((y - y0) / h) * ((SAMPLE_W * h) / w),
  };
}

async function main() {
  const bytes = await readFile(join(root, "source", "Nunito-SemiBold.ttf"));
  const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const names = font.names?.windows ?? {};
  const fullName = names.fullName?.en;
  const family = names.fontFamily?.en;
  const weight = font.tables.os2?.usWeightClass;
  if (fullName !== "Nunito SemiBold" || family !== "Nunito SemiBold" || weight !== 600) {
    throw new Error(
      `expected Nunito SemiBold weight 600, got fullName ${fullName} family ${family} weight ${weight}`,
    );
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
    const buf = raster(svg, w, h, flatten);
    await writeFile(join(root, rel), buf);
    const meta = await decodePng(buf);
    if (meta.width !== w || (h && meta.height !== h)) {
      throw new Error(`${rel} is ${meta.width}x${meta.height}`);
    }
    written[rel] = buf;
    console.log(`${rel} ${meta.width}x${meta.height}`);
  }

  const icoBuf = ico([
    { size: 16, buffer: written["png/favicon-16.png"] },
    { size: 32, buffer: written["png/favicon-32.png"] },
    { size: 48, buffer: raster(marks.iconDark, 48, 48, GROUND) },
  ]);
  await writeFile(join(root, "favicon.ico"), icoBuf);
  console.log(`favicon.ico ${icoBuf.length} bytes (16+32+48)`);

  const plum = [110, 63, 115];
  const mint = [191, 232, 210];
  const placement = {};
  const checks = [
    ["light icon", written["png/icon-light.png"], plum, marks.iconPlace],
    ["dark icon", written["png/icon-dark.png"], mint, marks.iconPlace],
    ["light wordmark", written["png/wordmark-light.png"], plum, marks.wordPlace],
  ];
  for (const [label, buf, rgb, place] of checks) {
    const sprout = await centroid(buf, rgb);
    const target = stemTarget(place);
    const dx = Math.abs(sprout.x - target.x);
    const dy = Math.abs(sprout.y - target.y);
    if (dx > 2 || dy > 2) {
      throw new Error(
        `${label} sprout is not centred on the stem ` +
          `(dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} px, limit 2 on a ${SAMPLE_W}px-wide sample)`,
      );
    }
    placement[label] = { dx: Number(dx.toFixed(2)), dy: Number(dy.toFixed(2)) };
  }
  console.log("placement checks ok", placement);
  console.log(`font ${fullName}; shared p path ${marks.pPath.length} chars; shared sprout ${marks.sprout.length} chars`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
