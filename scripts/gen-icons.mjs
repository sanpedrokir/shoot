import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPRITE = path.join(ROOT, "public/sprites/blueplane.webp");
const OUT_DIR = path.join(ROOT, "public/icons");

const sizes = [
  { file: "icon-32.png", size: 32 },
  { file: "icon-180.png", size: 180 },
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-1024.png", size: 1024 },
];

function backgroundSvg(size) {
  return Buffer.from(`
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d3d8c" />
      <stop offset="55%" stop-color="#1f6fd6" />
      <stop offset="100%" stop-color="#6fb6f5" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#sky)" />
  <g fill="#ffffff" opacity="0.28">
    <ellipse cx="${size * 0.78}" cy="${size * 0.22}" rx="${size * 0.16}" ry="${size * 0.07}" />
    <ellipse cx="${size * 0.88}" cy="${size * 0.19}" rx="${size * 0.1}" ry="${size * 0.05}" />
    <ellipse cx="${size * 0.16}" cy="${size * 0.8}" rx="${size * 0.18}" ry="${size * 0.075}" />
    <ellipse cx="${size * 0.06}" cy="${size * 0.76}" rx="${size * 0.1}" ry="${size * 0.05}" />
  </g>
</svg>`);
}

async function run() {
  for (const { file, size } of sizes) {
    const planeWidth = Math.round(size * 0.66);
    const plane = await sharp(SPRITE)
      .resize({ width: planeWidth, fit: "inside" })
      .toBuffer({ resolveWithObject: true });

    const bg = sharp(backgroundSvg(size)).png();

    const left = Math.round((size - plane.info.width) / 2);
    const top = Math.round((size - plane.info.height) / 2) - Math.round(size * 0.02);

    await bg
      .composite([{ input: plane.data, left, top }])
      .png()
      .toFile(path.join(OUT_DIR, file));
    console.log("wrote", file);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
