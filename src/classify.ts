import type { Extraction, DocKind } from './types.js';
import type { PdfText } from './pdftext.js';

export type HeadingKind = 'bill' | 'statement' | 'none' | 'ambiguous';

export interface HeadingRules {
  billHeadings: string[];
  statementHeadings: string[];
}

/** Exactly the headings in the brief. Extras can be added in config/rules, never silently. */
export const DEFAULT_RULES: HeadingRules = {
  billHeadings: ['tax invoice', 'supplier bill', 'bill'],
  statementHeadings: ['statement', 'client statement', 'debtor statement'],
};

export function buildRules(extraBill: string[] = [], extraStatement: string[] = []): HeadingRules {
  const norm = (a: string[]) => a.map(normLine).filter(Boolean);
  return {
    billHeadings: [...DEFAULT_RULES.billHeadings, ...norm(extraBill)],
    statementHeadings: [...DEFAULT_RULES.statementHeadings, ...norm(extraStatement)],
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
function lineIsHeading(line: string, phrase: string): boolean {
  const tokens = line.split(' ').filter(Boolean);
  while (tokens.length && PREFIX_WORDS.has(tokens[0]!)) tokens.shift();
  const p = phrase.split(' ');
  if (tokens.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (tokens[i] !== p[i]) return false;
  const rest = tokens.slice(p.length);
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
  return phrases.some((p) => lineIsHeading(line, p));
}

/** Classifies a list of visual lines (first N lines of page 1). */
export function classifyLines(lines: string[], rules: HeadingRules, window = 30): HeadingKind {
  let bill = false;
  let statement = false;
  for (const raw of lines.slice(0, window)) {
    const line = normLine(raw);
    if (!line) continue;
    if (matchesAny(line, rules.billHeadings)) bill = true;
    if (matchesAny(line, rules.statementHeadings)) statement = true;
  }
  if (bill && statement) return 'ambiguous';
  if (bill) return 'bill';
  if (statement) return 'statement';
  return 'none';
}

/** Classifies the single heading string Claude reports. */
export function classifyHeadingString(heading: string, rules: HeadingRules): HeadingKind {
  const line = normLine(heading);
  if (!line) return 'none';
  const bill = matchesAny(line, rules.billHeadings);
  const statement = matchesAny(line, rules.statementHeadings);
  if (bill && statement) return 'ambiguous';
  if (bill) return 'bill';
  if (statement) return 'statement';
  return 'none';
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
  const bill = rules.billHeadings.some(starts);
  const statement = rules.statementHeadings.some(starts);
  if (bill && statement) return 'ambiguous';
  return bill ? 'bill' : statement ? 'statement' : 'none';
}

function phraseAnywhere(text: string, phrases: string[]): boolean {
  const t = ` ${normLine(text.replace(/\n/g, ' '))} `;
  return phrases.some((p) => t.includes(` ${p} `));
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
  const textKind: HeadingKind | null = text && text.hasText ? classifyLines(text.page1Lines, rules) : null;

  // The text layer shows a real heading, and Claude's heading text starts with the same words ("Tax Invoice No").
  if (claudeKind === 'none' && (textKind === 'bill' || textKind === 'statement')) {
    if (looseKind(claude.document_heading, rules) === textKind && claude.document_type === textKind && claude.confidence !== 'low') {
      return { kind: textKind, basis: 'heading confirmed by text layer; Claude read the same words with a label attached' };
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
    return { kind: 'review', reasons: ['The heading matches both a bill and a statement, so the type is ambiguous.'] };
  }

  const claudeIsDoc = claudeKind === 'bill' || claudeKind === 'statement';

  // Agreement between the two readers.
  if (claudeIsDoc && textKind === claudeKind) {
    if (claude.document_type !== claudeKind) {
      return {
        kind: 'review',
        reasons: [`Heading says ${claudeKind} but Claude classed the document as "${claude.document_type}".`],
      };
    }
    return { kind: claudeKind, basis: 'heading confirmed by text layer and by Claude' };
  }

  // Conflict.
  if (claudeIsDoc && (textKind === 'bill' || textKind === 'statement') && textKind !== claudeKind) {
    return {
      kind: 'review',
      reasons: [`Text layer heading says ${textKind} but Claude read a ${claudeKind} heading.`],
    };
  }
  if (!claudeIsDoc && (textKind === 'bill' || textKind === 'statement')) {
    return {
      kind: 'review',
      reasons: [`Text layer heading says ${textKind} but Claude did not read a matching heading ("${claude.document_heading}").`],
    };
  }

  // Claude read a heading the text layer did not show.
  if (claudeIsDoc) {
    const phrases = claudeKind === 'bill' ? rules.billHeadings : rules.statementHeadings;
    if (textKind === null) {
      // Scanned or image-only PDF: only Claude can read it, so demand at least medium confidence.
      // Scanned bills are always flagged for a closer check downstream.
      if (claude.confidence !== 'low' && claude.document_type === claudeKind) {
        return { kind: claudeKind, basis: `scanned PDF, heading read by Claude with ${claude.confidence} confidence` };
      }
      return { kind: 'review', reasons: ['Scanned PDF and Claude was not confident enough about the document type.'] };
    }
    // Text layer exists but the heading line was not detected in the top lines.
    if (claude.confidence === 'high' && claude.document_type === claudeKind && text && phraseAnywhere(text.page1Text, phrases)) {
      return { kind: claudeKind, basis: 'heading found in page text outside the top lines, confirmed by Claude' };
    }
    return {
      kind: 'review',
      reasons: [`Claude read the heading "${claude.document_heading}" but it is not present in the PDF text layer.`],
    };
  }

  return { kind: 'review', reasons: ['Document type could not be decided.'] };
}
