/**
 * The "save to contacts" card on the connect page. On the shared iMessage line every
 * agent writes from the router's number, and iMessage shows only that number: Inkbox
 * shares an identity's name and photo on dedicated lines alone. A contact card gives
 * the thread the agent's name and a picture with one tap.
 */
import { crc32, deflateSync } from "node:zlib";

/** The site's colors (pages.ts): an amber sun on the cream background. */
const SUN_RGB: [number, number, number] = [0xf5, 0x9e, 0x0b];
const BG_RGB: [number, number, number] = [0xff, 0xfa, 0xf3];

/** The page's sun mark in its own 24-unit grid: a disc and eight rays with round ends. */
const DISC_R = 4.5;
const RAY_HALF_WIDTH = 1;
const RAYS: Array<[number, number, number, number]> = [
  [12, 2.5, 12, 5], [12, 19, 12, 21.5], [2.5, 12, 5, 12], [19, 12, 21.5, 12],
  [5.3, 5.3, 7.1, 7.1], [16.9, 16.9, 18.7, 18.7], [5.3, 18.7, 7.1, 16.9], [16.9, 7.1, 18.7, 5.3],
];

function distanceToSegment(px: number, py: number, [ax, ay, bx, by]: [number, number, number, number]): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inSun(x: number, y: number): boolean {
  if (Math.hypot(x - 12, y - 12) <= DISC_R) return true;
  return RAYS.some((ray) => distanceToSegment(x, y, ray) <= RAY_HALF_WIDTH);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

let cachedPng: Buffer | undefined;

/**
 * A square PNG of the sun, drawn here so the gateway ships no image file. The sun takes the
 * middle 80% because phones crop contact photos to a circle. Edges are smoothed by sampling
 * each pixel 4x4 times.
 */
export function sunPng(size = 256): Buffer {
  if (size === 256 && cachedPng) return cachedPng;
  const samples = 4;
  const scale = 24 / (size * 0.8);
  const offset = size * 0.1;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples - offset) * scale;
          const y = (py + (sy + 0.5) / samples - offset) * scale;
          if (inSun(x, y)) hits++;
        }
      }
      const a = hits / (samples * samples);
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round(BG_RGB[c]! + (SUN_RGB[c]! - BG_RGB[c]!) * a);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (size === 256) cachedPng = png;
  return png;
}

/** vCard text values escape backslash, comma, semicolon and newline. */
function vcardText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r?\n/g, "\\n");
}

/** vCard lines stay under 75 characters; longer ones continue on lines that start with a space. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join("\r\n");
}

/** A vCard 3.0 for the number the agent writes from, with the agent's name and the sun as its photo. */
export function contactCard(opts: { name: string; number: string }): string {
  const name = vcardText(opts.name);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    `N:;${name};;;`,
    `TEL;TYPE=CELL:${opts.number.replace(/[^\d+]/g, "")}`,
    `PHOTO;ENCODING=b;TYPE=PNG:${sunPng().toString("base64")}`,
    "END:VCARD",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
