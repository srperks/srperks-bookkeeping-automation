import { getDocumentProxy } from 'unpdf';

export interface PdfText {
  pageCount: number;
  /** Visual lines of page 1, top to bottom. */
  page1Lines: string[];
  page1Text: string;
  /** True when the PDF carries a usable text layer (false for scans/photos). */
  hasText: boolean;
}

interface Item {
  str: string;
  x: number;
  y: number;
  h: number;
}

/**
 * Reads page 1 and rebuilds visual lines from text positions. We do not rely on the PDF's
 * own line-break markers, because many invoice generators omit them and headings would fuse
 * with neighbouring text.
 */
export async function readPdfText(buf: Buffer): Promise<PdfText> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  try {
    const pageCount = pdf.numPages;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();

    const items: Item[] = [];
    for (const it of content.items as Array<Record<string, unknown>>) {
      const str = typeof it.str === 'string' ? it.str : '';
      const tr = it.transform as number[] | undefined;
      if (!str.trim() || !tr || tr.length < 6) continue;
      items.push({ str, x: tr[4] ?? 0, y: tr[5] ?? 0, h: Math.abs(tr[3] ?? 0) || 10 });
    }

    // Top to bottom, then left to right.
    items.sort((a, b) => (Math.abs(b.y - a.y) > 0.5 ? b.y - a.y : a.x - b.x));

    const lines: Item[][] = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      const ref = last?.[0];
      if (last && ref && Math.abs(ref.y - it.y) <= Math.max(2, Math.min(ref.h, it.h) * 0.4)) {
        last.push(it);
      } else {
        lines.push([it]);
      }
    }

    const page1Lines = lines
      .map((l) =>
        l
          .sort((a, b) => a.x - b.x)
          .map((i) => i.str.trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean);

    const page1Text = page1Lines.join('\n');
    return { pageCount, page1Lines, page1Text, hasText: page1Text.replace(/\s/g, '').length >= 20 };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}
