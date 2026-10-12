import { timingSafeEqual } from "node:crypto";
import { isReservedHandle, normalizePhone as normalizeCorePhone, parsePhone, type PhoneCountry } from "@open-instinct/core";

export const HANDLE_RE = /^[a-z0-9-]{3,40}$/;
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/** The form's country list. A number written with + or 00 keeps its own country whatever is picked. */
export const SIGNUP_COUNTRIES: ReadonlyArray<{ code: PhoneCountry; name: string; dial: string; example: string }> = [
  { code: "NO", name: "Norway", dial: "+47", example: "912 34 567" },
  { code: "SE", name: "Sweden", dial: "+46", example: "070-123 45 67" },
  { code: "GB", name: "United Kingdom", dial: "+44", example: "07400 123456" },
  { code: "US", name: "United States", dial: "+1", example: "(415) 555-0123" },
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

export function validateSignup(input: Record<string, unknown>, opts: { signupSecret?: string; defaultCountry?: PhoneCountry } = {}): SignupValidation {
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
  if (!HANDLE_RE.test(handle)) errors["handle"] = "Handle must be 3 to 40 characters: lowercase letters, digits and dashes.";
  // `owner` names the person behind every agent; core refuses it as a contact handle too.
  else if (isReservedHandle(handle)) errors["handle"] = `"${handle}" is reserved. Pick another handle.`;
  if (opts.signupSecret && !secretMatches(inviteCode, opts.signupSecret)) errors["inviteCode"] = "Invite code is not valid.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const value: SignupValue = { name, phone, handle };
  if (emailRaw) value.email = emailRaw;
  return { ok: true, value };
}
