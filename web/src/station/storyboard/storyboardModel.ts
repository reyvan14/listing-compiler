import type { ContentPackage, Progress, Shot, Validation } from './storyboardApi';

// Pure rules for the storyboard editor.
//
// Two things these helpers refuse to do: invent a percentage, and describe a
// set of clips as a finished video. Both are easy to do by accident and both
// would make the panel lie about what exists.

/** Reorder a shot list. Durations move with the shots; the timeline is rebuilt. */
export function moveShot(shots: Shot[], from: number, to: number): Shot[] {
  if (from === to || from < 0 || to < 0 || from >= shots.length || to >= shots.length) {
    return shots;
  }
  const next = [...shots];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return retimeline(next);
}

export function removeShot(shots: Shot[], shotId: string): Shot[] {
  return retimeline(shots.filter(s => s.shot_id !== shotId));
}

export function addShot(shots: Shot[], duration = 3): Shot[] {
  const next: Shot = {
    ...(shots[shots.length - 1] ?? ({} as Shot)),
    shot_id: `shot-new-${Date.now()}`,
    beat: 'custom',
    label: `分镜 ${shots.length + 1}`,
    duration_s: duration,
    instruction: '',
    overlay_text: '',
    narration: '',
    status: 'pending',
    result_url: '',
    provider_task_id: '',
    attempts: 0,
    error: '',
  };
  return retimeline([...shots, next]);
}

/** Recompute start/end so the timeline stays continuous after any edit. */
export function retimeline(shots: Shot[]): Shot[] {
  let cursor = 0;
  return shots.map(shot => {
    const duration = Number(shot.duration_s) || 0;
    const row = { ...shot, start_s: round(cursor), end_s: round(cursor + duration), duration_s: round(duration) };
    cursor += duration;
    return row;
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function totalSeconds(shots: Shot[]): number {
  return round(shots.reduce((sum, s) => sum + (Number(s.duration_s) || 0), 0));
}

/** Shots that would be paid for in the next run. Successful ones are excluded. */
export function shotsNeedingGeneration(shots: Shot[]): Shot[] {
  return shots.filter(s => s.status !== 'succeeded');
}

export function expectedModelCalls(shots: Shot[]): number {
  return shotsNeedingGeneration(shots).length;
}

/**
 * The progress sentence.
 *
 * Deliberately a count, not a bar: "shot 2/4 generated" is checkable against
 * the shot list, and a percentage derived from elapsed time is not.
 */
export function progressLabel(progress: Progress | null): string {
  if (!progress) return '尚未生成';
  return progress.label;
}

export function hasFakeProgress(label: string): boolean {
  return /%/.test(label);
}

/** How the package should describe itself. Never "a video" unless one exists. */
export function packageSummary(pkg: ContentPackage): string {
  const { generated_clips: clips, shot_count: shots, missing_clips: missing } = pkg.manifest;
  const head = `${clips}/${shots} 个分镜已生成`;
  if (pkg.composed && pkg.final_video) {
    return `${head}，并已合成校验通过的成片。`;
  }
  const tail = missing.length > 0 ? `，仍缺 ${missing.length} 个分镜` : '';
  return `${head}${tail}。未合成成片，包内为独立片段与字幕。`;
}

export function validationSummary(validation: Validation | null): string {
  if (!validation) return '';
  if (validation.ok) {
    return `共 ${validation.shot_count} 个分镜 · ${validation.total_seconds}s · 预计 ${validation.expected_model_calls} 次付费生成调用`;
  }
  return validation.problems.join('　');
}
