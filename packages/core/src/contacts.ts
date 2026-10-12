/**
 * People the owner knows, with their trust tier and the addresses that identify
 * them. Stored as a plain JSON array in contacts.json so the owner can edit it.
 */
import type { StateDir } from "./state.js";
import { isReservedHandle, normalizeEmail, normalizeHandle, normalizePhone, type PhoneCountry } from "./principal.js";
import type { Contact, Tier } from "./types.js";

const FILE = "contacts.json";

/** "Sam Lee" -> "sam-lee". Ids are stable and readable because they appear in grants. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "contact";
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/** Callers get deep copies so a mutated result can never leak back into the cache. */
function copy(c: Contact): Contact {
  return structuredClone(c);
}

export interface ContactStoreOptions {
  /** How numbers written without a country code are read. Pass `phoneCountryOf(config)`. */
  phoneCountry?: PhoneCountry;
}

export class ContactStore {
  private readonly state: StateDir;
  private readonly phoneCountry: PhoneCountry | undefined;
  private cache: Contact[] | undefined;

  constructor(state: StateDir, opts: ContactStoreOptions = {}) {
    this.state = state;
    this.phoneCountry = opts.phoneCountry;
  }

  private phone(s: string): string {
    return normalizePhone(s, this.phoneCountry);
  }

  private load(): Contact[] {
    if (!this.cache) {
      const raw = this.state.readJson<unknown>(FILE, []);
      this.cache = Array.isArray(raw) ? (raw as Contact[]) : [];
    }
    return this.cache;
  }

  private save(list: Contact[]): void {
    this.cache = list;
    this.state.writeJson(FILE, list);
  }

  all(): Contact[] {
    return this.load().map(copy);
  }

  get(id: string): Contact | undefined {
    const found = this.load().find((c) => c.id === id);
    return found ? copy(found) : undefined;
  }

  findByPhone(phone: string): Contact | undefined {
    const n = this.phone(phone);
    if (!n) return undefined;
    const found = this.load().find((c) => c.phones.some((p) => this.phone(p) === n));
    return found ? copy(found) : undefined;
  }

  findByEmail(email: string): Contact | undefined {
    const n = normalizeEmail(email);
    if (!n) return undefined;
    const found = this.load().find((c) => c.emails.some((e) => normalizeEmail(e) === n));
    return found ? copy(found) : undefined;
  }

  findByHandle(handle: string): Contact | undefined {
    const n = normalizeHandle(handle);
    if (!n) return undefined;
    const found = this.load().find((c) => c.agentHandle && normalizeHandle(c.agentHandle) === n);
    return found ? copy(found) : undefined;
  }

  /** Case-insensitive substring search over name, id, addresses, handle and notes. */
  search(q: string): Contact[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return this.all();
    const digits = needle.replace(/\D/g, "");
    return this.load()
      .filter((c) => {
        const hay = [c.name, c.id, c.agentHandle ?? "", c.notes ?? "", ...c.emails].join(" ").toLowerCase();
        if (hay.includes(needle)) return true;
        return digits.length >= 4 && c.phones.some((p) => p.replace(/\D/g, "").includes(digits));
      })
      .map(copy);
  }

  /**
   * Create or update. Matching order: explicit id, then any shared phone, email or
   * agent handle, then the slug of the name. Addresses are merged, not replaced.
   */
  upsert(input: Partial<Contact> & { name: string }): Contact {
    const list = this.load();
    const now = new Date().toISOString();
    const phones = uniq((input.phones ?? []).map((p) => this.phone(p)));
    const emails = uniq((input.emails ?? []).map(normalizeEmail));
    const handle = input.agentHandle ? normalizeHandle(input.agentHandle) : undefined;
    if (handle !== undefined && isReservedHandle(handle)) {
      throw new Error(`"${handle}" is a reserved handle and cannot belong to a contact's agent`);
    }

    const existing =
      (input.id ? list.find((c) => c.id === input.id) : undefined) ??
      list.find(
        (c) =>
          c.phones.some((p) => phones.includes(this.phone(p))) ||
          c.emails.some((e) => emails.includes(normalizeEmail(e))) ||
          (handle !== undefined && c.agentHandle !== undefined && normalizeHandle(c.agentHandle) === handle),
      ) ??
      (input.id === undefined ? list.find((c) => c.id === slugify(input.name)) : undefined);

    if (existing) {
      existing.name = input.name;
      if (input.tier) existing.tier = input.tier;
      existing.phones = uniq([...existing.phones.map((p) => this.phone(p)), ...phones]);
      existing.emails = uniq([...existing.emails.map(normalizeEmail), ...emails]);
      if (handle) existing.agentHandle = handle;
      if (input.notes !== undefined) existing.notes = input.notes;
      existing.updatedAt = now;
      this.save(list);
      return copy(existing);
    }

    // A second person with the same name needs an explicit id ("alex-kim-work"):
    // by default the name merges, because "add Alex's email" is the common case.
    const id = input.id ?? slugify(input.name);

    const contact: Contact = {
      id,
      name: input.name,
      tier: input.tier ?? "contact",
      phones,
      emails,
      createdAt: now,
      updatedAt: now,
    };
    if (handle) contact.agentHandle = handle;
    if (input.notes !== undefined) contact.notes = input.notes;
    list.push(contact);
    this.save(list);
    return copy(contact);
  }

  setTier(id: string, tier: Tier): Contact | undefined {
    const list = this.load();
    const c = list.find((x) => x.id === id);
    if (!c) return undefined;
    c.tier = tier;
    c.updatedAt = new Date().toISOString();
    this.save(list);
    return copy(c);
  }

  remove(id: string): boolean {
    const list = this.load();
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }
}
