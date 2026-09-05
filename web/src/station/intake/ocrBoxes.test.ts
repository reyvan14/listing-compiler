import { describe, expect, it } from 'vitest';
import {
  BAND_LABEL,
  boxPercent,
  confidenceBand,
  describeConfidence,
  groupLines,
  lowConfidenceWords,
  pending,
  scaleBox,
} from './ocrBoxes';
import { REVIEW_STATE_META, type Candidate, type OcrWord } from './intakeApi';

const word = (text: string, confidence: number, left: number, line = 1): OcrWord => ({
  text,
  confidence,
  box: { left, top: 10, width: 40, height: 12 },
  line,
});

const candidate = (over: Partial<Candidate> = {}): Candidate =>
  ({
    candidate_id: 'cand-0001',
    fact_id: 'ev-capacity',
    key: 'capacity',
    label: '容量',
    value: '350',
    raw_value: '350',
    raw_unit: 'ml',
    display: '350 ml',
    claim_type: 'numeric',
    data_type: 'number',
    origin: 'ocr',
    method: 'tesseract',
    confidence: 0.63,
    source_id: 's1',
    page: null,
    box: { left: 10, top: 10, width: 20, height: 10 },
    excerpt: 'capacity 350 ml',
    review_state: 'needs_review',
    created_at: '',
    reviewed_by: '',
    reviewed_at: '',
    review_note: '',
    ...over,
  }) as Candidate;

describe('box geometry', () => {
  it('scales a source-pixel box onto the rendered image', () => {
    const scaled = scaleBox({ left: 100, top: 50, width: 200, height: 20 }, 1000, 500, 500, 250);
    expect(scaled).toEqual({ left: 50, top: 25, width: 100, height: 10 });
  });

  it('expresses boxes as percentages so a resize cannot desync them', () => {
    const percent = boxPercent({ left: 250, top: 100, width: 500, height: 50 }, 1000, 500);
    expect(percent).toEqual({ left: 25, top: 20, width: 50, height: 10 });
  });

  it('returns an empty box rather than dividing by zero', () => {
    expect(scaleBox({ left: 1, top: 1, width: 1, height: 1 }, 0, 0, 10, 10)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
    expect(boxPercent({ left: 1, top: 1, width: 1, height: 1 }, 0, 10)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('confidence', () => {
  it('treats anything under 75 as low, because 63% is where OCR misread ml as mt', () => {
    expect(confidenceBand(95)).toBe('high');
    expect(confidenceBand(80)).toBe('medium');
    expect(confidenceBand(63)).toBe('low');
    expect(BAND_LABEL.low).toBe('偏低');
  });

  it('describes extractor confidence without ever implying the claim is true', () => {
    const text = describeConfidence(candidate({ confidence: 0.63 }));
    expect(text).toContain('63%');
    expect(text).toContain('提取置信度');
    expect(text).not.toContain('已核实');
    expect(text).not.toContain('verified');
  });

  it('flags the words a person should look at', () => {
    const flagged = lowConfidenceWords([word('Capacity', 88, 0), word('mt', 63, 100)]);
    expect(flagged.map(w => w.text)).toEqual(['mt']);
  });
});

describe('line grouping', () => {
  it('reads words left to right within each line', () => {
    const lines = groupLines([
      word('ml', 60, 200, 1),
      word('Capacity', 90, 20, 1),
      word('350', 70, 120, 1),
      word('Model', 88, 20, 2),
    ]);
    expect(lines.map(l => l.text)).toEqual(['Capacity 350 ml', 'Model']);
  });
});

describe('review state presentation', () => {
  it('never shows an unreviewed candidate as passing', () => {
    expect(REVIEW_STATE_META.needs_review.tone).not.toBe('ok');
    expect(REVIEW_STATE_META.approved.tone).toBe('ok');
    expect(REVIEW_STATE_META.rejected.tone).toBe('danger');
  });

  it('lists exactly the candidates still awaiting a decision', () => {
    const rows = pending([
      candidate({ candidate_id: 'a', review_state: 'needs_review' }),
      candidate({ candidate_id: 'b', review_state: 'approved' }),
      candidate({ candidate_id: 'c', review_state: 'rejected' }),
    ]);
    expect(rows.map(r => r.candidate_id)).toEqual(['a']);
  });
});
