import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderConnect, renderLanding, renderPending } from "../src/pages.js";
import { readyUser } from "./helpers.js";

const brand = { product: "Sunshine", agent: "Sunshine" };
const router = { number: "+14155550199" };

/** The few DOM pieces the connect page's script touches, enough to run it outside a browser. */
function fakeElement() {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  let onClick: (() => void) | undefined;
  return {
    hidden: true,
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
    setAttribute: (k: string, v: string) => void attributes.set(k, v),
    removeAttribute: (k: string) => void attributes.delete(k),
    addEventListener: (_type: string, f: () => void) => void (onClick = f),
    click: () => onClick?.(),
    locked: () => classes.has("locked") && attributes.get("aria-disabled") === "true",
  };
}

/** Load the page in a fake browser: run its script against fresh elements and the given storage. */
function load(html: string, storage: Map<string, string>) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const elements = { "send-step": fakeElement(), "save-contact": fakeElement() };
  const localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
  runInNewContext(script, { document: { getElementById: (id: keyof typeof elements) => elements[id] }, localStorage });
  return elements;
}

describe("theme", () => {
  it("is always dark, whatever the device prefers", () => {
    const landing = renderLanding({ signupEnabled: true, requireInvite: true, brand, autoHandle: true });
    expect(landing).toContain('<meta name="color-scheme" content="dark">');
    expect(landing).toContain("color-scheme:dark");
    expect(landing).not.toContain("prefers-color-scheme");
  });
});

describe("motion", () => {
  it("fades the signup page in once, never the connect page that reloads itself, and honors Reduce Motion", () => {
    const landing = renderLanding({ signupEnabled: true, requireInvite: true, brand, autoHandle: true });
    expect(landing).toContain("<h1>Your own personal agent.</h1>");
    expect(landing).toContain('<div class="wrap enter">');
    expect(landing).toContain("prefers-reduced-motion:reduce");
    const provisioning = renderConnect(readyUser({ status: "provisioning" }), router, { brand, autoHandle: true });
    expect(provisioning).toContain('http-equiv="refresh"');
    expect(provisioning).toContain('<div class="wrap">');
  });
});

describe("connect page: save the contact before texting", () => {
  const html = renderConnect(readyUser({ id: "usr_c", handle: "sunshine-maria-abcd" }), router, { brand, autoHandle: true });

  it("ships step 2 unlocked, so a phone without JavaScript is never stuck", () => {
    expect(html).toContain('<div id="send-step">');
    expect(html).not.toContain('class="locked"');
  });

  it("has two buttons, with the text and number folded away for people on a computer", () => {
    expect(html).toContain('>Save Sunshine</a>');
    expect(html).toContain('href="sms:+14155550199&amp;body=connect%20%40sunshine-maria-abcd">Connect to Sunshine</a>');
    const folded = /<details class="manual">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
    expect(folded).toContain("On a computer?");
    expect(folded).toContain("connect @sunshine-maria-abcd");
    expect(folded).toContain('<div class="code" style="margin-bottom:0">+14155550199</div>');
  });

  it("locks step 2 until Save is tapped, and remembers the tap across the page's reloads", () => {
    const storage = new Map<string, string>();
    const first = load(html, storage);
    expect(first["send-step"].locked()).toBe(true);

    first["save-contact"].click();
    expect(first["send-step"].locked()).toBe(false);

    const reloaded = load(html, storage);
    expect(reloaded["send-step"].locked()).toBe(false);
  });

  it("remembers each person separately", () => {
    const storage = new Map<string, string>();
    load(html, storage)["save-contact"].click();
    const other = renderConnect(readyUser({ id: "usr_other", handle: "sunshine-anna-wxyz" }), router, { brand, autoHandle: true });
    expect(load(other, storage)["send-step"].locked()).toBe(true);
  });

  it("puts no script on the check-your-phone page, which has no card to save", () => {
    expect(renderPending("maria", router, { brand })).not.toContain("<script>");
  });
});
