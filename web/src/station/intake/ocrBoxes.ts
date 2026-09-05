import type { Candidate, OcrBox, OcrWord } from './intakeApi';

// Pure geometry and presentation rules for the OCR overlay.
//
// Boxes come back in *source image pixels*; the viewer draws them over an image
// scaled to fit a panel. Converting in one tested place keeps a rounding bug
// from silently pointing an operator at the wrong word — which, in a workflow
// whose whole purpose is "check what the machine read", would be worse than
// showing no boxes at all.

export type Scaled = { left: number; top: number; width: number; height: number };

/** Map a source-pixel box onto a rendered image of `renderedWidth` px. */
export function scaleBox(
  box: OcrBox,
  sourceWidth: number,
  sourceHeight: number,
  renderedWidth: number,
  renderedHeight: number,
): Scaled {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const x = renderedWidth / sourceWidth;
  const y = renderedHeight / sourceHeight;
  return {
    left: box.left * x,
    top: box.top * y,
    width: box.width * x,
    height: box.height * y,
  };
}

/** As percentages, so the overlay survives a responsive resize without JS. */
export function boxPercent(box: OcrBox, sourceWidth: number, sourceHeight: number): Scaled {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  return {
    left: (box.left / sourceWidth) * 100,
    top: (box.top / sourceHeight) * 100,
    width: (box.width / sourceWidth) * 100,
    height: (box.height / sourceHeight) * 100,
  };
}

/**
 * Confidence bands.
 *
 * The thresholds are deliberately pessimistic: Tesseract read "ml" as "mt" at
 * 63% in this project's own fixture, so anything under 75 is shown as needing a
 * careful look rather than as a mild caveat.
 */
export type ConfidenceBand = 'high' | 'medium' | 'low';

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 90) return 'high';
  if (confidence >= 75) return 'medium';
  return 'low';
}

export const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: '较高',
  medium: '一般',
  low: '偏低',
};

/** Words worth flagging to a human before anything is approved. */
export function lowConfidenceWords(words: OcrWord[], threshold = 75): OcrWord[] {
  return words.filter(w => w.confidence < threshold);
}

/** Group words into visual lines, left to right — how a person reads them. */
export function groupLines(words: OcrWord[]): { line: number; words: OcrWord[]; text: string }[] {
  const byLine = new Map<number, OcrWord[]>();
  for (const word of words) {
    const bucket = byLine.get(word.line);
    if (bucket) bucket.push(word);
    else byLine.set(word.line, [word]);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, group]) => {
      const ordered = [...group].sort((a, b) => a.box.left - b.box.left);
      return { line, words: ordered, text: ordered.map(w => w.text).join(' ') };
    });
}

/** Candidates still awaiting a human decision. */
export function pending(candidates: Candidate[]): Candidate[] {
  return candidates.filter(c => c.review_state === 'needs_review');
}

/**
 * How an extracted candidate's confidence should be described.
 *
 * Note there is no branch returning anything like "verified" or "confirmed":
 * extractor confidence is about the reading, never about the claim.
 */
export function describeConfidence(candidate: Candidate): string {
  const percent = Math.round(candidate.confidence * 100);
  const band = confidenceBand(percent);
  return `${percent}% · 提取置信度${BAND_LABEL[band]}`;
}
