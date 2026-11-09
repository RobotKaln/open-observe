// What may be stored from a telemetry batch (see "Privacy" in the README). Everything that ends up in
// an observe table passes through here: free text is scrubbed and capped, addresses lose their query and fragment,
// attributes with a sensitive name are dropped.

export const MAX_MESSAGE = 500;
export const MAX_STACK = 4000;
export const MAX_BODY = 500;
export const MAX_ROUTE = 200;
export const MAX_ATTR_VALUE = 200;
export const MAX_ATTRS = 20;
export const MAX_ATTRS_JSON = 2000;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Query and fragment of an address inside text: tokens and ids travel there.
const URL_TAIL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>()]*)[?#][^\s"'<>()]*/gi;
// Long opaque strings: JWTs, API keys, base64 blobs.
const TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
const HEX = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
// National identification numbers written with a slash (800102/1234).
const SLASH_ID_NUMBER = /\b\d{6}\/\d{3,4}\b/g;
// Eight or more digits, also split by single spaces or dashes (phone numbers, IBANs, account numbers).
const LONG_NUMBER = /\+?\d(?:[ -]?\d){7,}/g;
const MEDIUM_NUMBER = /\d{6,}/g;

export function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// E-mails, long digit runs, hex codes, UUIDs and tokens become a marker; addresses lose query and fragment. `stack`
// keeps six and seven digit numbers (line and column numbers), everything longer still goes.
export function scrubText(value: string, { stack = false } = {}): string {
  let text = value
    .replace(URL_TAIL, '$1')
    .replace(EMAIL, '[email]')
    .replace(UUID, '[uuid]')
    .replace(TOKEN, '[token]')
    .replace(SLASH_ID_NUMBER, '[num]')
    .replace(LONG_NUMBER, '[num]')
    .replace(HEX, '[hex]');
  if (!stack) text = text.replace(MEDIUM_NUMBER, '[num]');
  return text;
}

// Error message, log body: scrubbed and capped to `max` (the cap applies after scrubbing, so a marker is never cut).
export function scrubMessage(value: unknown, max = MAX_MESSAGE): string {
  return typeof value === 'string' ? cap(scrubText(value), max) : '';
}

export function scrubStack(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return cap(scrubText(value, { stack: true }), MAX_STACK);
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

// An address without query and fragment; scrubbed like text, so ids in the path go too.
export function scrubUrl(value: string, max = MAX_ATTR_VALUE): string {
  const end = value.search(/[?#]/);
  return cap(scrubText(end === -1 ? value : value.slice(0, end)), max);
}

// A route is a template (`/p/[code]`). What the client sends is trusted no further than that: an address loses its
// query and fragment (and its origin), and anything that looks like data in it is replaced.
export function scrubRoute(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let route = value.trim();
  if (!route) return null;
  if (ABSOLUTE_URL.test(route)) {
    try {
      route = new URL(route).pathname;
    } catch {
      return null;
    }
  }
  const end = route.search(/[?#]/);
  if (end !== -1) route = route.slice(0, end);
  return route ? cap(scrubText(route), MAX_ROUTE) : null;
}

// Parts of an attribute name that mark it as something that must not be kept.
const DENIED_KEY_PARTS = ['params', 'body', 'header', 'token', 'email', 'password', 'passwd', 'authorization', 'cookie', 'secret', 'phone'];

export const isDeniedAttribute = (key: string) => {
  const lower = key.toLowerCase();
  return DENIED_KEY_PARTS.some((part) => lower.includes(part));
};

export type AttrValue = string | number | boolean;

// Attributes that are stored in the `attrs` JSON of a log: scalar values only, the first MAX_ATTRS that pass the
// denylist, strings scrubbed (an address also loses query and fragment) and capped, the whole JSON capped. Null when
// nothing is left.
export function safeAttributes(entries: Iterable<[string, unknown]>): string | null {
  const out: Record<string, AttrValue> = {};
  let count = 0;
  for (const [key, value] of entries) {
    if (count >= MAX_ATTRS) break;
    if (!key || key.length > 80 || isDeniedAttribute(key)) continue;
    let clean: AttrValue;
    if (typeof value === 'string') {
      clean = ABSOLUTE_URL.test(value) || value.startsWith('/') ? scrubUrl(value) : cap(scrubText(value), MAX_ATTR_VALUE);
    } else if (typeof value === 'number' && Number.isFinite(value)) clean = value;
    else if (typeof value === 'boolean') clean = value;
    else continue;
    const next = { ...out, [key]: clean };
    if (JSON.stringify(next).length > MAX_ATTRS_JSON) break;
    out[key] = clean;
    count++;
  }
  return count === 0 ? null : JSON.stringify(out);
}

// Version, model and similar identifiers: short, printable, scrubbed.
export function scrubLabel(value: unknown, max = 64): string | null {
  if (typeof value !== 'string') return null;
  const label = cap(scrubText(value.trim()), max);
  return label || null;
}

const UPDATE_ID = /^[0-9a-f-]{8,64}$/i;
// An OTA update id is a UUID and is meant to be kept; anything else is not an update id.
export const cleanUpdateId = (value: unknown): string | null =>
  typeof value === 'string' && UPDATE_ID.test(value.trim()) ? value.trim().toLowerCase() : null;
