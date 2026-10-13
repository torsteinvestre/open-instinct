import { randomBytes, timingSafeEqual } from "node:crypto";
import { isReservedHandle, normalizePhone as normalizeCorePhone, parsePhone, type PhoneCountry } from "@open-instinct/core";

export const HANDLE_RE = /^[a-z0-9-]{3,40}$/;
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * The form's country list. A number written with + or 00 keeps its own country whatever is picked.
 * [sunshine:timezone] `timezone` is the fallback when the browser does not say; a country with several has none.
 */
export const SIGNUP_COUNTRIES: ReadonlyArray<{ code: PhoneCountry; flag: string; name: string; dial: string; example: string; timezone?: string }> = [
  { code: "NO", flag: "🇳🇴", name: "Norway", dial: "+47", example: "912 34 567", timezone: "Europe/Oslo" },
  { code: "SE", flag: "🇸🇪", name: "Sweden", dial: "+46", example: "070-123 45 67", timezone: "Europe/Stockholm" },
  { code: "GB", flag: "🇬🇧", name: "United Kingdom", dial: "+44", example: "07400 123456", timezone: "Europe/London" },
  { code: "US", flag: "🇺🇸", name: "United States", dial: "+1", example: "(415) 555-0123" },
];

/** The form's last option: the number must carry its own country code. */
export const OTHER_COUNTRY = "other";

export const DEFAULT_SIGNUP_COUNTRY: PhoneCountry = "US";

/** A country code from the list, in any case, or undefined. */
export function signupCountry(code: string | undefined): PhoneCountry | undefined {
  const wanted = (code ?? "").trim().toUpperCase();
  return SIGNUP_COUNTRIES.find((c) => c.code === wanted)?.code;
}

export interface SignupValue {
  name: string;
  phone: string;
  email?: string;
  handle: string;
  /** [sunshine:timezone] IANA zone for the agent's clock; absent leaves core's default (the server's, UTC on Maritime). */
  timezone?: string;
}

export type SignupValidation =
  | { ok: true; value: SignupValue }
  | { ok: false; errors: Record<string, string> };

/** E.164. A number written the local way is read as `country`; one with + or 00 keeps its own. */
export function normalizePhone(raw: string, country: PhoneCountry = DEFAULT_SIGNUP_COUNTRY): string {
  return normalizeCorePhone(raw, country);
}

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

const HANDLE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A handle for a signup that does not choose one: "sunshine-anna-k3f9". The first name makes
 * the connect text readable; the random tail keeps two people called Anna apart. Letters that
 * NFKD cannot split (ø, æ) are spelled out so "Bjørn" stays "bjorn".
 */
export function autoHandle(prefix: string, name: string, random: (n: number) => Buffer = randomBytes): string {
  const first = (name.trim().split(/\s+/)[0] ?? "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  const tail = [...random(4)].map((b) => HANDLE_ALPHABET[b % HANDLE_ALPHABET.length]).join("");
  return [normalizeHandle(prefix).replace(/[^a-z0-9-]/g, "").slice(0, 20), first, tail].filter(Boolean).join("-");
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Constant-time compare so an invite code cannot be guessed one character at a time. */
export function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * [sunshine:timezone] A real IANA zone in its canonical spelling, or undefined. UTC and Etc/* say
 * nothing about where someone lives (privacy modes report UTC), so they count as unknown.
 */
export function placeTimezone(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s || s.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(s)) return undefined;
  let zone: string;
  try {
    zone = new Intl.DateTimeFormat("en-US", { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return zone === "UTC" || zone.startsWith("Etc/") ? undefined : zone;
}

/** [sunshine:timezone] The browser's zone when it names a place, else the picked country's single zone. */
export function signupTimezone(browser: string | undefined, country: PhoneCountry | undefined): string | undefined {
  return placeTimezone(browser) ?? SIGNUP_COUNTRIES.find((c) => c.code === country)?.timezone;
}

export interface SignupRules {
  signupSecret?: string;
  defaultCountry?: PhoneCountry;
  /** The gateway picks the handle (GATEWAY_HANDLE_PREFIX), so the form has none to check. */
  autoHandle?: boolean;
}

export function validateSignup(input: Record<string, unknown>, opts: SignupRules = {}): SignupValidation {
  const errors: Record<string, string> = {};
  const name = str(input["name"]);
  const rawPhone = str(input["phone"]);
  const emailRaw = str(input["email"]).toLowerCase();
  const handle = normalizeHandle(str(input["handle"]));
  const inviteCode = str(input["inviteCode"] ?? input["invite_code"] ?? input["invite"]);

  // No country field (an API client) means the gateway's default. "Other" means the number names its own.
  const countryField = str(input["country"]);
  const other = countryField.toLowerCase() === OTHER_COUNTRY;
  const country = countryField && !other ? signupCountry(countryField) : opts.defaultCountry ?? DEFAULT_SIGNUP_COUNTRY;
  // 00 is the international prefix in Europe; written as + it parses the same from any default country.
  const dialed = rawPhone.replace(/^00/, "+");
  const international = dialed.startsWith("+");
  // A signup is the one place a wrong guess cannot be fixed later, so an unplaceable number is an error.
  const phone = (country && (!other || international) ? parsePhone(dialed, country) : undefined) ?? "";

  if (name.length < 1 || name.length > 80) errors["name"] = "Name is required (1 to 80 characters).";
  if (countryField && !other && !country) errors["country"] = "Pick a country from the list.";
  else if (other && !international) errors["phone"] = "Start the number with + and its country code, or pick your country.";
  else if (!E164_RE.test(phone)) errors["phone"] = "That does not look like a phone number for the country you picked. You can also type it with + and the country code.";
  if (emailRaw && !isEmail(emailRaw)) errors["email"] = "Email does not look valid.";
  // With autoHandle the server fills the handle in once it knows this phone is new.
  if (!opts.autoHandle) {
    if (!HANDLE_RE.test(handle)) errors["handle"] = "Handle must be 3 to 40 characters: lowercase letters, digits and dashes.";
    // `owner` names the person behind every agent; core refuses it as a contact handle too.
    else if (isReservedHandle(handle)) errors["handle"] = `"${handle}" is reserved. Pick another handle.`;
  }
  if (opts.signupSecret && !secretMatches(inviteCode, opts.signupSecret)) errors["inviteCode"] = "Invite code is not valid.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const value: SignupValue = { name, phone, handle: opts.autoHandle ? "" : handle };
  if (emailRaw) value.email = emailRaw;
  // [sunshine:timezone] Never an error: the field is hidden, so a bad value just falls back.
  const timezone = signupTimezone(str(input["timezone"]), other ? undefined : country);
  if (timezone) value.timezone = timezone;
  return { ok: true, value };
}
