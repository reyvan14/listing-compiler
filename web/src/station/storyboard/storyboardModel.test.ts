import { describe, expect, it } from 'vitest';
import {
  addShot,
  expectedModelCalls,
  hasFakeProgress,
  moveShot,
  packageSummary,
  progressLabel,
  removeShot,
  retimeline,
  shotsNeedingGeneration,
  totalSeconds,
  validationSummary,
} from './storyboardModel';
import { SHOT_STATUS_META, type ContentPackage, type Progress, type Shot } from './storyboardApi';

const shot = (id: string, duration: number, status: Shot['status'] = 'pending'): Shot =>
  ({
    shot_id: id,
    beat: 'hook',
    label: id,
    start_s: 0,
    end_s: duration,
    duration_s: duration,
    instruction: '',
    fact_ids: [],
    source_image_asset_id: '',
    overlay_text: '',
    narration: '',
    platform: 'tiktok',
    status,
    attempts: 0,
    provider_task_id: '',
    result_url: status === 'succeeded' ? 'c.mp4' : '',
    error: '',
    updated_at: '',
  }) as Shot;

const base = () => [shot('a', 3), shot('b', 5), shot('c', 4), shot('d', 3)];

describe('timeline editing', () => {
  it('keeps the timeline continuous after a reorder', () => {
    const rows = moveShot(base(), 3, 0);
    expect(rows.map(r => r.shot_id)).toEqual(['d', 'a', 'b', 'c']);
    expect(rows[0].start_s).toBe(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].start_s).toBe(rows[i - 1].end_s);
    }
  });

  it('leaves the list alone for an out-of-range move', () => {
    const rows = base();
    expect(moveShot(rows, 0, 0)).toBe(rows);
    expect(moveShot(rows, -1, 2)).toBe(rows);
    expect(moveShot(rows, 0, 99)).toBe(rows);
  });

  it('closes the gap when a shot is removed', () => {
    const rows = removeShot(base(), 'b');
    expect(rows.map(r => r.shot_id)).toEqual(['a', 'c', 'd']);
    expect(totalSeconds(rows)).toBe(10);
    expect(rows[1].start_s).toBe(3);
  });

  it('appends a new shot at the end of the timeline', () => {
    const rows = addShot(base(), 2);
    expect(rows).toHaveLength(5);
    expect(rows[4].start_s).toBe(15);
    expect(rows[4].status).toBe('pending');
    expect(rows[4].result_url).toBe('');
  });

  it('rebuilds the timeline deterministically', () => {
    const rows = retimeline([shot('a', 2.5), shot('b', 1.25)]);
    expect(rows.map(r => [r.start_s, r.end_s])).toEqual([
      [0, 2.5],
      [2.5, 3.75],
    ]);
  });
});

describe('cost', () => {
  it('counts only the shots that still need generating', () => {
    const rows = [shot('a', 3, 'succeeded'), shot('b', 3), shot('c', 3, 'failed')];
    expect(shotsNeedingGeneration(rows).map(r => r.shot_id)).toEqual(['b', 'c']);
    expect(expectedModelCalls(rows)).toBe(2);
  });

  it('charges nothing when every shot already succeeded', () => {
    expect(expectedModelCalls([shot('a', 3, 'succeeded')])).toBe(0);
  });

  it('states the call count in the validation summary before generating', () => {
    const text = validationSummary({
      ok: true,
      problems: [],
      total_seconds: 15,
      shot_count: 4,
      expected_model_calls: 4,
      requires_confirmation: true,
    });
    expect(text).toContain('4 次付费生成调用');
  });

  it('shows the problems instead of a summary when the timeline is invalid', () => {
    const text = validationSummary({
      ok: false,
      problems: ['第 2 个分镜时长 0.2s，短于 1s。'],
      total_seconds: 3,
      shot_count: 2,
      expected_model_calls: 2,
      requires_confirmation: true,
    });
    expect(text).toContain('短于');
  });
});

describe('progress is counted, never estimated', () => {
  it('shows a sentence a person can check against the shot list', () => {
    const progress = { label: '分镜 2/4 已生成' } as Progress;
    expect(progressLabel(progress)).toBe('分镜 2/4 已生成');
    expect(hasFakeProgress(progressLabel(progress))).toBe(false);
  });

  it('says nothing has been generated rather than showing 0%', () => {
    expect(progressLabel(null)).toBe('尚未生成');
    expect(hasFakeProgress(progressLabel(null))).toBe(false);
  });
});

describe('the package never claims a film it does not have', () => {
  const pkg = (over: Partial<ContentPackage> = {}): ContentPackage =>
    ({
      composed: false,
      final_video: null,
      manifest: {
        shot_count: 4,
        generated_clips: 2,
        missing_clips: ['c', 'd'],
        captions: [],
        narration: '',
        final_video: null,
        generated_at: '',
      },
      ...over,
    }) as ContentPackage;

  it('describes separate clips as separate clips', () => {
    const text = packageSummary(pkg());
    expect(text).toContain('2/4 个分镜已生成');
    expect(text).toContain('未合成成片');
    expect(text).not.toContain('成片已生成');
  });

  it('only mentions a final film when one was composed and validated', () => {
    const text = packageSummary(
      pkg({
        composed: true,
        final_video: { path: 'final.mp4', bytes: 100, duration_s: 15 },
        manifest: { ...pkg().manifest, generated_clips: 4, missing_clips: [] },
      }),
    );
    expect(text).toContain('已合成校验通过的成片');
  });
});

describe('shot status presentation', () => {
  it('never shows a pending or failed shot as done', () => {
    expect(SHOT_STATUS_META.succeeded.tone).toBe('ok');
    expect(SHOT_STATUS_META.pending.tone).not.toBe('ok');
    expect(SHOT_STATUS_META.failed.tone).toBe('danger');
    expect(SHOT_STATUS_META.cancelled.tone).not.toBe('ok');
  });
});
