import { createHash } from 'node:crypto';

export const sha256 = (b: Buffer | Uint8Array): string => createHash('sha256').update(b).digest('hex');

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol + 1e-9;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Dates. All business dates in this system are ISO strings (YYYY-MM-DD).
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function buildIso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

export function isValidIsoDate(s: string | null | undefined): s is string {
  if (!s) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  return buildIso(Number(m[1]), Number(m[2]), Number(m[3])) === s;
}

/**
 * Parses a date exactly as printed on an Australian document. Numeric dates are read
 * day first (dd/mm/yyyy). Returns null when the string cannot be read with confidence,
 * in which case callers must not treat it as a mismatch.
 */
export function parsePrintedDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
    .replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, '');

  let m: RegExpExecArray | null;

  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) {
    return buildIso(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) {
    const yr = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return buildIso(yr, Number(m[2]), Number(m[1]));
  }
  if ((m = /^(\d{1,2})[ -]([A-Za-z]+)\.?,?[ -](\d{2}|\d{4})$/.exec(s))) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    if (!mon) return null;
    const yr = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return buildIso(yr, mon, Number(m[1]));
  }
  if ((m = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(s))) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    if (!mon) return null;
    return buildIso(Number(m[3]), mon, Number(m[2]));
  }
  return null;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const f = Date.parse(`${fromIso}T00:00:00Z`);
  const t = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((t - f) / 86_400_000);
}

/** Today's date in the clients' timezone (Melbourne), as YYYY-MM-DD. */
export function todayIso(now: Date = new Date(), timeZone = 'Australia/Melbourne'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ---------------------------------------------------------------------------
// Names and file names
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = new Set(['pty', 'ltd', 'limited', 'proprietary', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'trust', 'the']);

/** Normalises a business name so "Acme Pty. Ltd." and "ACME PTY LTD" compare equal. */
export function normaliseBusinessName(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !LEGAL_SUFFIXES.has(t));
  return tokens.join(' ');
}

/** Token overlap used to spot "close but not equal" supplier names. */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normaliseBusinessName(a).split(' ').filter(Boolean));
  const tb = new Set(normaliseBusinessName(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = inter / union;
  const contains = inter === Math.min(ta.size, tb.size) ? 0.8 : 0;
  return Math.max(jaccard, contains);
}

export function normaliseDocNumber(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Makes text safe as part of a SharePoint/OneDrive file name. Keeps it readable:
 * invalid characters become a hyphen (for slashes) or are dropped.
 */
export function sanitiseFilePart(input: string, maxLen = 120): string {
  let s = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, '-')
    .replace(/[:*?"<>|~#%&{}]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s-]+/, '').replace(/[.\s]+$/, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  if (RESERVED_WIN.test(s)) s = `${s}_`;
  return s;
}

export function formatDateParts(iso: string): string {
  return iso.replace(/-/g, ' ');
}

export function moneyFmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return n.toFixed(2);
}


const LEGAL_FORMS: Record<string, string> = {
  pty: 'Pty', ltd: 'Ltd', limited: 'Limited', inc: 'Inc', co: 'Co', corp: 'Corp', llc: 'LLC', 'p/l': 'P/L', 't/a': 'T/A', nz: 'NZ',
};
const KEEP_UPPER = new Set(['IGA', 'ABC', 'NSW', 'VIC', 'QLD', 'SA', 'WA', 'NT', 'ACT', 'AU', 'NZ', 'USA', 'UK', 'IT', 'HR', 'ATM', 'CBD', 'GST', 'ABN', 'ACN', 'BBQ', 'TV', 'PC', 'AV', 'HVAC']);
const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'to', 'in', 'on', 'at', 'by', 'a', 'an']);

function titleToken(t: string): string {
  return t.toLowerCase().replace(/(^|[-'\u2019/&.(])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

/**
 * Supplier names are shown the way a person would write them: "FLICK ANTICIMEX PTY LTD" and
 * "Flick Anticimex PTY LTD" both become "Flick Anticimex Pty Ltd". A name that already mixes
 * upper and lower case is left alone apart from the legal forms (Pty, Ltd and so on).
 */
export function properName(name: string): string {
  const words = name.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const allCaps = !/[a-z]/.test(name);
  return words
    .map((w, i) => {
      const bare = w.toLowerCase().replace(/[.,]+$/g, '');
      const trail = w.slice(bare.length);
      const legal = LEGAL_FORMS[bare];
      if (legal) return legal + trail;
      if (!allCaps) return w;
      const upper = w.toUpperCase().replace(/[.,]+$/g, '');
      if (KEEP_UPPER.has(upper)) return w;
      if (i > 0 && SMALL_WORDS.has(bare)) return w.toLowerCase();
      return titleToken(w);
    })
    .join(' ');
}
