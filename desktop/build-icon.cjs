const fs = require("node:fs");
const path = require("node:path");

const size = 256;
const curveSegments = [
  [[352, 137], [250, 138], [167, 176], [135, 245]],
  [[135, 245], [114, 290], [124, 336], [152, 363]],
  [[152, 363], [194, 304], [259, 262], [341, 240]],
  [[341, 240], [272, 277], [220, 327], [185, 390]],
  [[185, 390], [231, 412], [288, 404], [326, 370]],
  [[326, 370], [387, 315], [383, 214], [352, 137]],
];

function sampleCurves(segments, steps) {
  const points = [];
  for (const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] of segments) {
    for (let index = 0; index < steps; index += 1) {
      const t = index / steps;
      const u = 1 - t;
      points.push([
        u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
        u ** 3 * y0 + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3,
      ]);
    }
  }
  return points;
}

function containsPoint(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearLine(x, y, points, radius) {
  for (let index = 1; index < points.length; index += 1) {
    const [ax, ay] = points[index - 1];
    const [bx, by] = points[index];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx ** 2 + dy ** 2)));
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= radius ** 2) return true;
  }
  return false;
}

function iconPixels() {
  const pixels = Buffer.alloc(size * size * 4);
  const leaf = sampleCurves(curveSegments, 32);
  const vein = sampleCurves([[[143, 362], [191, 280], [254, 226], [346, 192]]], 48);
  const colors = {
    background: [79, 94, 63, 255],
    leaf: [238, 243, 237, 255],
    vein: [189, 207, 193, 255],
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = (x + 0.5) * (512 / size);
      const sourceY = (y + 0.5) * (512 / size);
      const dx = Math.max(112 - sourceX, 0, sourceX - 400);
      const dy = Math.max(112 - sourceY, 0, sourceY - 400);
      const isBackground = dx === 0 || dy === 0 || dx ** 2 + dy ** 2 <= 112 ** 2;
      const isLeaf = containsPoint(sourceX, sourceY, leaf);
      const color = isLeaf ? colors.leaf : nearLine(sourceX, sourceY, vein, 10.5) ? colors.vein : isBackground ? colors.background : [0, 0, 0, 0];
      const offset = (y * size + x) * 4;
      pixels[offset] = color[2];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[0];
      pixels[offset + 3] = color[3];
    }
  }
  return pixels;
}

function createIco() {
  const dibHeader = Buffer.alloc(40);
  dibHeader.writeUInt32LE(40, 0);
  dibHeader.writeInt32LE(size, 4);
  dibHeader.writeInt32LE(size * 2, 8);
  dibHeader.writeUInt16LE(1, 12);
  dibHeader.writeUInt16LE(32, 14);
  dibHeader.writeUInt32LE(size * size * 4, 20);

  const pixels = iconPixels();
  const bitmap = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc((size / 8) * size);
  for (let y = 0; y < size; y += 1) {
    const sourceOffset = y * size * 4;
    const targetOffset = (size - y - 1) * size * 4;
    pixels.copy(bitmap, targetOffset, sourceOffset, sourceOffset + size * 4);
  }
  const image = Buffer.concat([dibHeader, bitmap, mask]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, image]);
}

const iconPath = path.join(__dirname, "routiner.ico");
fs.writeFileSync(iconPath, createIco());
console.log(`Created ${iconPath}`);
