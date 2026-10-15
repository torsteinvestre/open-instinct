import { describe, expect, it } from "vitest";
import { renderLanding } from "../src/pages.js";
import { HANDLE_RE, autoHandle, normalizeHandle, normalizePhone, placeTimezone, secretMatches, signupTimezone, validateSignup } from "../src/validate.js";

describe("validateSignup", () => {
  it("normalizes and accepts a good signup", () => {
    const r = validateSignup({ name: " Maria ", phone: "(415) 555-0123", email: "Maria@Example.com", handle: "@Maria-1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: "Maria", phone: "+14155550123", email: "maria@example.com", handle: "maria-1" });
  });

  it("rejects bad phones, handles and emails with field errors", () => {
    const r = validateSignup({ name: "", phone: "12345", email: "nope", handle: "a b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["email", "handle", "name", "phone"]);
  });

  it("requires E.164 and the handle charset", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("1 415 555 0123")).toBe("+14155550123");
    expect(normalizePhone("")).toBe("");
    expect(normalizeHandle("  @@Sam_Lee ")).toBe("sam_lee");
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam_lee" }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "ab" }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "a".repeat(41) }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+04155550123", handle: "sam" }).ok).toBe(false);
  });

  it("refuses the reserved handle `owner` in any spelling", () => {
    for (const handle of ["owner", "@owner", " Owner "]) {
      const r = validateSignup({ name: "S", phone: "+14155550123", handle });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors["handle"]).toMatch(/reserved/);
    }
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "owner-2" }).ok).toBe(true);
  });

  it("checks the invite code only when configured", () => {
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam" }, { signupSecret: "letmein" }).ok).toBe(false);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam", inviteCode: "letmein" }, { signupSecret: "letmein" }).ok).toBe(true);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam", invite_code: "letmein" }, { signupSecret: "letmein" }).ok).toBe(true);
    expect(validateSignup({ name: "S", phone: "+14155550123", handle: "sam", inviteCode: "wrong" }).ok).toBe(true);
    expect(secretMatches("abc", "abcd")).toBe(false);
    expect(secretMatches(undefined, undefined)).toBe(true);
  });

  it("treats non-string fields as empty", () => {
    const r = validateSignup({ name: 42, phone: null, handle: ["x"] });
    expect(r.ok).toBe(false);
  });

  // [sunshine:signup] the next four tests
  it("reads the phone as the picked country, the way people write it at home", () => {
    const phoneFor = (country: string, phone: string) => {
      const r = validateSignup({ name: "S", handle: "sam", country, phone });
      return r.ok ? r.value.phone : r.errors;
    };
    expect(phoneFor("NO", "457 75 184")).toBe("+4745775184");
    expect(phoneFor("no", "+47 457 75 184")).toBe("+4745775184");
    expect(phoneFor("SE", "070-123 45 67")).toBe("+46701234567");
    expect(phoneFor("GB", "07400 123456")).toBe("+447400123456");
    expect(phoneFor("US", "(415) 555-0123")).toBe("+14155550123");
    // A number with + or 00 keeps its own country whatever is picked.
    expect(phoneFor("NO", "+46 70 123 45 67")).toBe("+46701234567");
    expect(phoneFor("NO", "0046 70 123 45 67")).toBe("+46701234567");
  });

  it("refuses a number that does not fit the picked country instead of guessing", () => {
    // A US number without its 1, picked as Norway, used to become a Swiss-looking +41 number.
    const r = validateSignup({ name: "S", handle: "sam", country: "NO", phone: "415 555 0123" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors["phone"]).toMatch(/country you picked/);
  });

  it("needs a country code for Other, and refuses countries not on the list", () => {
    expect(validateSignup({ name: "S", handle: "sam", country: "other", phone: "+351 912 345 678" }).ok).toBe(true);
    const local = validateSignup({ name: "S", handle: "sam", country: "other", phone: "912 345 678" });
    expect(local.ok).toBe(false);
    if (!local.ok) expect(local.errors["phone"]).toMatch(/\+ and its country code/);
    const unknown = validateSignup({ name: "S", handle: "sam", country: "XX", phone: "+4745775184" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(Object.keys(unknown.errors)).toEqual(["country"]);
  });

  it("uses the gateway's default country when the signup names none", () => {
    const r = validateSignup({ name: "S", handle: "sam", phone: "457 75 184" }, { defaultCountry: "NO" });
    expect(r.ok && r.value.phone).toBe("+4745775184");
  });
});

// [sunshine:timezone] Agents ran in UTC because signup never said where the person lives.
describe("[sunshine:timezone] signup timezone", () => {
  it("accepts real zones in their canonical spelling and refuses the rest", () => {
    expect(placeTimezone("Europe/Oslo")).toBe("Europe/Oslo");
    expect(placeTimezone(" America/Los_Angeles ")).toBe("America/Los_Angeles");
    expect(placeTimezone("europe/oslo")).toBe("Europe/Oslo");
    for (const bad of ["", "Mars/Olympus", "Europe/Oslo<script>", "x".repeat(65), undefined]) expect(placeTimezone(bad), String(bad)).toBeUndefined();
  });

  it("treats UTC as unknown, since privacy modes report it whatever the place", () => {
    for (const zone of ["UTC", "Etc/UTC", "Etc/GMT+2"]) expect(placeTimezone(zone), zone).toBeUndefined();
  });

  it("prefers the browser, then the picked country's single zone", () => {
    expect(signupTimezone("America/New_York", "NO")).toBe("America/New_York");
    expect(signupTimezone("", "NO")).toBe("Europe/Oslo");
    expect(signupTimezone("UTC", "SE")).toBe("Europe/Stockholm");
    expect(signupTimezone(undefined, "GB")).toBe("Europe/London");
    expect(signupTimezone(undefined, "US")).toBeUndefined();
  });

  it("puts the zone on the signup and never fails a signup over it", () => {
    const browser = validateSignup({ name: "S", handle: "sam", country: "NO", phone: "912 34 567", timezone: "Europe/Oslo" });
    expect(browser.ok && browser.value.timezone).toBe("Europe/Oslo");
    const fallback = validateSignup({ name: "S", handle: "sam", country: "SE", phone: "070-123 45 67", timezone: "garbage" });
    expect(fallback.ok && fallback.value.timezone).toBe("Europe/Stockholm");
    const other = validateSignup({ name: "S", handle: "sam", country: "other", phone: "+351 912 345 678" });
    expect(other.ok).toBe(true);
    expect(other.ok && other.value.timezone).toBeUndefined();
    const us = validateSignup({ name: "S", handle: "sam", country: "US", phone: "(415) 555-0123" });
    expect(us.ok && "timezone" in us.value).toBe(false);
  });

  it("the form carries a hidden timezone field the browser fills, kept after an error", () => {
    const page = renderLanding({ signupEnabled: true, requireInvite: false });
    expect(page).toContain('<input type="hidden" id="timezone" name="timezone" value="">');
    expect(page).toContain("resolvedOptions().timeZone");
    const again = renderLanding({ signupEnabled: true, requireInvite: false, values: { timezone: "Europe/Oslo" } });
    expect(again).toContain('name="timezone" value="Europe/Oslo"');
  });
});

// [sunshine:signup]
describe("autoHandle", () => {
  const fixed = () => Buffer.from([0, 1, 2, 35]);

  it("joins the prefix, the first name and a random tail", () => {
    expect(autoHandle("sunshine", "Bjørn Ås", fixed)).toBe("sunshine-bjorn-abc9");
    expect(autoHandle("Sunshine", "  José María ", fixed)).toBe("sunshine-jose-abc9");
    expect(autoHandle("sunshine", "Æsa", fixed)).toBe("sunshine-aesa-abc9");
    expect(autoHandle("sunshine", "Maximilianusworth", fixed)).toBe("sunshine-maximilianus-abc9");
    expect(autoHandle("sunshine", "", fixed)).toBe("sunshine-abc9");
  });

  it("always passes the handle rules, whatever the name", () => {
    for (const name of ["Bjørn Ås", "", "李小龙", "Æsa", "O'Brien-Smith", "x".repeat(80)]) {
      expect(HANDLE_RE.test(autoHandle("sunshine", name)), name).toBe(true);
    }
  });

  it("lets a signup without a handle through when the gateway picks one", () => {
    const r = validateSignup({ name: "S", phone: "+14155550123" }, { autoHandle: true });
    expect(r.ok && r.value.handle).toBe("");
    expect(validateSignup({ name: "S", phone: "+14155550123" }).ok).toBe(false);
  });
});

// [sunshine:signup]
describe("renderLanding country picker", () => {
  it("preselects the default country, keeps the person's pick after an error, and offers Other", () => {
    const page = renderLanding({ signupEnabled: true, requireInvite: false, defaultCountry: "NO" });
    expect(page).toContain('<select id="country" name="country"');
    expect(page).toContain('<option value="NO" selected>🇳🇴 Norway (+47)</option>');
    expect(page).toContain('placeholder="912 34 567"');
    expect(page).toContain('<option value="other">');
    const again = renderLanding({ signupEnabled: true, requireInvite: false, defaultCountry: "NO", values: { country: "SE" } });
    expect(again).toContain('<option value="SE" selected>');
    expect(again).not.toContain('<option value="NO" selected>');
  });
});
