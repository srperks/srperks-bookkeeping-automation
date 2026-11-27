/**
 * Financial-year and month folder logic for SharePoint.
 *
 * Australian financial year runs 1 July to 30 June and is named by the year it ENDS.
 *   2026-10-12 -> FY2027 (folder "2027")
 *   2027-07-01 -> FY2028 (folder "2028"), never the "2027" folder
 *
 * The service never creates folders. If the year or month folder is missing, or the month
 * folder cannot be identified with certainty, the email stops for a person.
 */

export function financialYear(iso: string): number {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month >= 7 ? year + 1 : year;
}

/** Replaces {FY} in a folder template with the financial-year folder name for the date. */
export function expandFolder(template: string, iso: string): string {
  return template.replace(/\{FY\}/g, String(financialYear(iso)));
}

export function monthOf(iso: string): number {
  return Number(iso.slice(5, 7));
}

const MONTH_WORDS: string[][] = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sept', 'sep'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];

/** Which calendar months does a folder name mention? Words win; bare numbers (1 to 12) only count when no month word is present. */
function monthsInName(name: string): Set<number> {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set<number>();
  for (const t of tokens) {
    MONTH_WORDS.forEach((words, i) => {
      if (words.includes(t)) out.add(i + 1);
    });
  }
  if (out.size > 0) return out;
  for (const t of tokens) {
    if (/^\d{1,2}$/.test(t)) {
      const n = Number(t);
      if (n >= 1 && n <= 12) out.add(n);
    }
  }
  return out;
}

export type MonthPick = { ok: true; name: string } | { ok: false; reason: string };

/** Finds the one folder for the month. Zero or several matches is not guessed. */
export function pickMonthFolder(folderNames: string[], month: number, where: string): MonthPick {
  const hits = folderNames.filter((n) => monthsInName(n).has(month));
  const label = MONTH_WORDS[month - 1]![0]!;
  if (hits.length === 1) return { ok: true, name: hits[0]! };
  if (hits.length === 0) {
    return { ok: false, reason: `No ${label} folder found in "${where}". Existing folders: ${folderNames.join(', ') || '(none)'}. Create the month folder, then remove the "BK Review" category to retry.` };
  }
  return { ok: false, reason: `More than one folder in "${where}" looks like ${label} (${hits.join(', ')}), so the bill was not filed automatically.` };
}

export type NamePick = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Finds an Outlook folder by name among its siblings. An exact (case-insensitive) match wins.
 * Otherwise the wanted text may be the start of exactly one folder name, for example
 * "CHE001H1" for "CHE001H1 - Hopper Joint PL". Several candidates are never guessed.
 */
export function pickFolderName(names: string[], wanted: string): NamePick {
  const w = wanted.trim().toLowerCase();
  const exact = names.filter((n) => n.trim().toLowerCase() === w);
  if (exact.length === 1) return { ok: true, name: exact[0]! };
  if (exact.length > 1) return { ok: false, reason: `More than one folder is named "${wanted}".` };
  const starts = names.filter((n) => n.trim().toLowerCase().startsWith(w));
  if (starts.length === 1) return { ok: true, name: starts[0]! };
  if (starts.length > 1) return { ok: false, reason: `"${wanted}" matches several folders (${starts.join(', ')}). Use more of the name.` };
  return { ok: false, reason: `No folder named or starting with "${wanted}". Folders found: ${names.slice(0, 40).join(', ') || '(none)'}.` };
}
