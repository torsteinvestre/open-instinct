import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { contactCard, sunPng } from "../src/contact.js";

const AMBER = [0xf5, 0x9e, 0x0b];
const CREAM = [0xff, 0xfa, 0xf3];

/** Just enough PNG reading for an 8-bit RGB image with filter 0 rows, which is what sunPng writes. */
function pixels(png: Buffer): { width: number; height: number; at: (x: number, y: number) => number[] } {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 1 + width * 3;
  return { width, height, at: (x, y) => [...raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)] };
}

describe("sunPng", () => {
  it("draws an amber disc and rays on the cream background", () => {
    const png = sunPng();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const p = pixels(png);
    expect([p.width, p.height]).toEqual([256, 256]);
    expect(p.at(128, 128)).toEqual(AMBER); // the disc
    expect(p.at(128, 57)).toEqual(AMBER); // the top ray
    expect(p.at(154, 65)).toEqual(CREAM); // between two rays
    expect(p.at(2, 2)).toEqual(CREAM); // the corner a round crop cuts away
    expect(sunPng()).toBe(png);
  });
});

describe("contactCard", () => {
  it("is a vCard with the name, the number and the sun, in lines phones accept", () => {
    const card = contactCard({ name: "Sun, shine; co", number: "+1 (650) 484-9720" });
    expect(card.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(card).toContain("FN:Sun\\, shine\\; co\r\n");
    expect(card).toContain("TEL;TYPE=CELL:+16504849720\r\n");
    expect(card.endsWith("END:VCARD\r\n")).toBe(true);
    for (const line of card.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
    // Unfolding the continuation lines gives back the exact picture.
    const photo = /PHOTO;ENCODING=b;TYPE=PNG:([A-Za-z0-9+/=]+)/.exec(card.replace(/\r\n /g, ""))?.[1] ?? "";
    expect(Buffer.from(photo, "base64").equals(sunPng())).toBe(true);
  });
});
