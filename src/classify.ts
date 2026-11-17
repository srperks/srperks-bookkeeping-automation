import type { Extraction, DocKind } from './types.js';

const docTypeOf = (k: DocKind): Extraction['document_type'] => (k === 'credit' ? 'credit_note' : k);
import type { PdfText } from './pdftext.js';

export type HeadingKind = 'bill' | 'statement' | 'credit' | 'none' | 'ambiguous';

const isDocKind = (k: HeadingKind | null): k is DocKind => k === 'bill' || k === 'statement' || k === 'credit';

export interface HeadingRules {
  billHeadings: string[];
  statementHeadings: string[];
  creditHeadings: string[];
}

/** Exactly the headings in the brief. Extras can be added in config/rules, never silently. */
export const DEFAULT_RULES: HeadingRules = {
  billHeadings: ['tax invoice', 'supplier bill', 'bill'],
  statementHeadings: ['statement', 'client statement', 'debtor statement'],
  creditHeadings: ['credit note', 'tax credit note', 'supplier credit note', 'adjustment note', 'tax adjustment note', 'credit memo'],
};

const phrasesOf = (kind: DocKind, rules: HeadingRules): string[] =>
  kind === 'bill' ? rules.billHeadings : kind === 'statement' ? rules.statementHeadings : rules.creditHeadings;
const phrasesNotOf = (kind: DocKind, rules: HeadingRules): string[] =>
  (['bill', 'statement', 'credit'] as const).filter((k) => k !== kind).flatMap((k) => phrasesOf(k, rules));

export function buildRules(extraBill: string[] = [], extraStatement: string[] = [], extraCredit: string[] = []): HeadingRules {
  const norm = (a: string[]) => a.map(normLine).filter(Boolean);
  return {
    billHeadings: [...DEFAULT_RULES.billHeadings, ...norm(extraBill)],
    statementHeadings: [...DEFAULT_RULES.statementHeadings, ...norm(extraStatement)],
    creditHeadings: [...DEFAULT_RULES.creditHeadings, ...norm(extraCredit)],
  };
}

const PREFIX_WORDS = new Set(['original', 'copy', 'duplicate', 'reprint']);
const FILLER = new Set(['no', 'number', 'num', 'nr', 'of', 'account', 'accounts', 'copy', 'original', 'duplicate']);
const LABEL_ONLY = new Set(['no', 'number', 'num', 'nr']);

export function normLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A heading line must BE the heading, optionally followed by a document number
 * ("Tax Invoice #123", "Bill 4471", "Statement of Account").
 * "Bill To", "Bill Date", "Statement Date", "Tax Invoice Total" are labels, not headings.
 */
function lineIsHeading(line: string, phrase: string, siblings: string[] = []): boolean {
  const tokens = line.split(' ').filter(Boolean);
  while (tokens.length && PREFIX_WORDS.has(tokens[0]!)) tokens.shift();
  const p = phrase.split(' ');
  if (tokens.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (tokens[i] !== p[i]) return false;
  let rest = tokens.slice(p.length);
  // Combined headings: "Receipt / Tax Invoice", "Tax Invoice and Receipt". The slash is gone after
  // normalising, so a second heading phrase straight after the first still counts as the heading.
  for (const other of siblings) {
    const o = other.split(' ');
    const at = rest[0] === 'and' ? 1 : 0;
    if (o.every((w, i) => rest[at + i] === w)) {
      rest = rest.slice(at + o.length);
      break;
    }
  }
  if (rest.length === 0) return true;
  if (rest.length > 4) return false;
  for (const t of rest) {
    if (!FILLER.has(t) && !/\d/.test(t)) return false;
  }
  // "Bill Number" with no actual number is a column label, not a heading.
  if (rest.every((t) => LABEL_ONLY.has(t))) return false;
  return true;
}

function matchesAny(line: string, phrases: string[]): boolean {
  return phrases.some((p) => lineIsHeading(line, p, phrases));
}

/**
 * A multi-word heading that sits at the END of a busy row: "DUE DATE 16/11/2026 TAX INVOICE NUMBER MEL469705".
 * Only multi-word phrases are tried this way ("tax invoice"), never single words like "bill", and the words after the
 * phrase must still be just a number or label, so "Please pay this tax invoice by Friday" does not count.
 */
function endsWithHeading(line: string, phrases: string[]): boolean {
  const tokens = line.split(' ').filter(Boolean);
  const multi = phrases.filter((p) => p.includes(' '));
  for (let i = 1; i < tokens.length; i++) {
    const tail = tokens.slice(i).join(' ');
    if (multi.some((p) => lineIsHeading(tail, p, phrases))) return true;
  }
  return false;
}

const KINDS = ['bill', 'statement', 'credit'] as const;

function pickKind(found: Record<DocKind, boolean>): HeadingKind {
  const hits = KINDS.filter((k) => found[k]);
  if (hits.length > 1) return 'ambiguous';
  return hits[0] ?? 'none';
}

/** Classifies a list of visual lines (first N lines of page 1). */
export function classifyLines(lines: string[], rules: HeadingRules, window = 30): HeadingKind {
  const found: Record<DocKind, boolean> = { bill: false, statement: false, credit: false };
  for (const [idx, raw] of lines.slice(0, window).entries()) {
    const line = normLine(raw);
    if (!line) continue;
    for (const k of KINDS) {
      if (matchesAny(line, phrasesOf(k, rules))) found[k] = true;
      if (idx < 12 && !found[k] && endsWithHeading(line, phrasesOf(k, rules))) found[k] = true;
    }
  }
  return pickKind(found);
}

/** Classifies the single heading string Claude reports. */
export function classifyHeadingString(heading: string, rules: HeadingRules): HeadingKind {
  const line = normLine(heading);
  if (!line) return 'none';
  return pickKind({
    bill: matchesAny(line, rules.billHeadings),
    statement: matchesAny(line, rules.statementHeadings),
    credit: matchesAny(line, rules.creditHeadings),
  });
}

/**
 * Looser reading of the heading Claude reports: does it START with a recognised heading?
 * Claude sometimes copies a label such as "Tax Invoice No" instead of the title "TAX INVOICE".
 * This is only ever used together with an independent match in the PDF's own text layer.
 */
function looseKind(heading: string, rules: HeadingRules): HeadingKind {
  const tokens = normLine(heading).split(' ').filter(Boolean);
  while (tokens.length && PREFIX_WORDS.has(tokens[0]!)) tokens.shift();
  const starts = (phrase: string) => {
    const p = phrase.split(' ');
    return tokens.length >= p.length && p.every((w, i) => tokens[i] === w);
  };
  return pickKind({
    bill: rules.billHeadings.some(starts),
    statement: rules.statementHeadings.some(starts),
    credit: rules.creditHeadings.some(starts),
  });
}

function phraseAnywhere(text: string, phrases: string[]): boolean {
  const t = ` ${normLine(text.replace(/\n/g, ' '))} `;
  return phrases.some((p) => t.includes(` ${p} `));
}

function looksLikeLedger(text: string): boolean {
  const t = ` ${normLine(text.replace(/\n/g, ' '))} `;
  const has = (w: string) => t.includes(` ${w} `);
  return has('balance') && has('invoice') && (has('due') || has('amount')) && !phraseAnywhere(text, ['tax invoice']);
}

export type Decision =
  | { kind: DocKind; basis: string }
  | { kind: 'other'; reason: string }
  | { kind: 'review'; reasons: string[] };

/**
 * Combines two independent readings of the document heading:
 *  1. the PDF's own text layer (deterministic), and
 *  2. what Claude read off the page.
 * Anything short of agreement stops for a human. A wrong filing costs more than a manual one.
 */
export function decideType(text: PdfText | null, claude: Extraction, rules: HeadingRules): Decision {
  const claudeKind = classifyHeadingString(claude.document_heading, rules);
  const textKind: HeadingKind | null = text && text.hasText ? classifyLines([...text.page1Lines, ...(text.page1Segments ?? [])], rules) : null;

  // The text layer shows a real heading, and Claude's heading text starts with the same words ("Tax Invoice No").
  if (claudeKind === 'none' && isDocKind(textKind)) {
    if (looseKind(claude.document_heading, rules) === textKind && claude.document_type === docTypeOf(textKind) && claude.confidence !== 'low') {
      return { kind: textKind, basis: 'heading confirmed by text layer; Claude read the same words with a label attached' };
    }
  }

  // Claude's heading holds a recognised phrase inside a longer title ("Tax Invoice / Receipt",
  // "Original Tax Invoice (Customer Copy)") and the PDF's own text shows the same phrase near the top.
  if (claudeKind === 'none' && (claude.document_type === 'bill' || claude.document_type === 'statement' || claude.document_type === 'credit_note') && claude.confidence !== 'low' && text && text.hasText) {
    const kind: DocKind = claude.document_type === 'credit_note' ? 'credit' : claude.document_type;
    const other = phrasesNotOf(kind, rules);
    const mine = phrasesOf(kind, rules);
    const top = [...text.page1Lines.slice(0, 12), ...(text.page1Segments ?? [])].join('\n');
    if (
      phraseAnywhere(claude.document_heading, mine) &&
      !phraseAnywhere(claude.document_heading, other) &&
      phraseAnywhere(top, mine) &&
      !phraseAnywhere(top, other)
    ) {
      return { kind, basis: 'heading phrase found inside a longer title, confirmed by text layer and by Claude' };
    }
  }

  // Both readers see no recognised heading: this is a random PDF. Leave it in the inbox.
  if (claudeKind === 'none' && (textKind === 'none' || textKind === null)) {
    if (claude.document_type === 'other') return { kind: 'other', reason: 'No recognised bill or statement heading.' };
    return {
      kind: 'review',
      reasons: [
        `Claude classed the document as "${claude.document_type}" but no recognised heading was found (heading read: "${claude.document_heading}").`,
      ],
    };
  }

  if (claudeKind === 'ambiguous' || textKind === 'ambiguous') {
    return { kind: 'review', reasons: ['The heading matches more than one document type (bill, credit note, statement), so the type is ambiguous.'] };
  }

  const claudeIsDoc = isDocKind(claudeKind);

  // Agreement between the two readers.
  if (claudeIsDoc && textKind === claudeKind) {
    if (claude.document_type !== docTypeOf(claudeKind)) {
      return {
        kind: 'review',
        reasons: [`Heading says ${claudeKind} but Claude classed the document as "${claude.document_type}".`],
      };
    }
    return { kind: claudeKind, basis: 'heading confirmed by text layer and by Claude' };
  }

  // Conflict.
  if (claudeIsDoc && isDocKind(textKind) && textKind !== claudeKind) {
    return {
      kind: 'review',
      reasons: [`Text layer heading says ${textKind} but Claude read a ${claudeKind} heading.`],
    };
  }
  if (!claudeIsDoc && isDocKind(textKind)) {
    return {
      kind: 'review',
      reasons: [`Text layer heading says ${textKind} but Claude did not read a matching heading ("${claude.document_heading}").`],
    };
  }

  // Claude read a heading the text layer did not show.
  if (claudeIsDoc) {
    const phrases = phrasesOf(claudeKind, rules);
    if (textKind === null) {
      // Scanned or image-only PDF: only Claude can read it, so demand at least medium confidence.
      // Scanned bills are always flagged for a closer check downstream.
      if (claude.confidence !== 'low' && claude.document_type === docTypeOf(claudeKind)) {
        return { kind: claudeKind, basis: `scanned PDF, heading read by Claude with ${claude.confidence} confidence` };
      }
      return { kind: 'review', reasons: ['Scanned PDF and Claude was not confident enough about the document type.'] };
    }
    // Text layer exists but the heading line was not detected in the top lines.
    if (claude.confidence === 'high' && claude.document_type === docTypeOf(claudeKind) && text && phraseAnywhere(text.page1Text, phrases)) {
      return { kind: claudeKind, basis: 'heading found in page text outside the top lines, confirmed by Claude' };
    }
    // A statement title drawn as a picture or outlines never reaches the text layer. Filing a statement only saves
    // a PDF (no Xero bill), so a high-confidence statement whose text looks like a ledger is accepted.
    if (claudeKind === 'statement' && claude.confidence === 'high' && claude.document_type === 'statement' && textKind === 'none' && text && looksLikeLedger(text.page1Text)) {
      return { kind: 'statement', basis: 'statement title not in the text layer, but the page text is a balance ledger and Claude is confident' };
    }
    return {
      kind: 'review',
      reasons: [`Claude read the heading "${claude.document_heading}" but it is not present in the PDF text layer.`],
    };
  }

  return { kind: 'review', reasons: ['Document type could not be decided.'] };
}
