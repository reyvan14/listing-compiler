import type { Passport, PassportMedia, Readiness } from './passportApi';

// Pure presentation rules for the Release Passport.
//
// One rule governs everything here: a passport must never read as approval by a
// marketplace, and unresolved items must never disappear into a summary.

export const HANDOFF_DISCLAIMER = [
  '本工具不会向任何平台发布这份 listing。',
  '通过本工具的检查不代表平台会通过审核。',
  '标记为「需人工核验」的项目尚未被任何自动检查判定，由操作者负责确认。',
];

export function canExport(passport: Passport): boolean {
  return passport.readiness !== 'blocked' && passport.readiness !== 'superseded';
}

export type Coverage = {
  label: string;
  covered: boolean;
  note: string;
};

/**
 * What the passport does and does not cover.
 *
 * Absence is rendered explicitly. A section with no records shows "未覆盖"
 * rather than nothing at all, because an empty list and an unchecked area look
 * identical otherwise.
 */
export function coverage(passport: Passport): Coverage[] {
  const verifiedFacts = passport.facts.filter(f => f.state === 'verified');
  const manual = passport.manual_review.length;
  return [
    {
      label: '确定性文本校验',
      covered: Boolean(passport.validation?.validation_id),
      note: passport.validation?.validation_id
        ? `校验 ${passport.validation.validation_id} · ${passport.blockers.length} 阻断 / ${passport.warnings.length} 提醒`
        : '未运行过校验。',
    },
    {
      label: '证据支撑',
      covered: verifiedFacts.length > 0,
      note: verifiedFacts.length > 0
        ? `${verifiedFacts.length} 条已核实事实，引用 ${passport.evidence_documents.filter(d => d.cited).length} 份文件`
        : '没有任何已核实的产品事实，文案中的宣称未被证据支撑。',
    },
    {
      label: '图片像素检查',
      covered: passport.media.length > 0,
      note: passport.media.length > 0
        ? `${passport.media.length} 张图片已按像素检查`
        : '未检查任何图片，图片合规性未覆盖。',
    },
    {
      label: '主体占比 / 叠加文字',
      covered: false,
      note: '需目标检测与 OCR，本工具未启用，始终由人工核验。',
    },
    {
      label: '人工核验项',
      covered: manual === 0,
      note: manual === 0 ? '没有待人工核验的项目。' : `${manual} 项待人工核验，责任在操作者。`,
    },
  ];
}

/** A source link is offered only when the evidence record actually exists. */
export function hasSource(passport: Passport, sourceId: string): boolean {
  return passport.evidence_documents.some(d => d.source_id === sourceId);
}

export function mediaProblem(asset: PassportMedia): string {
  if (!asset.present) return '文件已丢失';
  if (!asset.checksum_verified) return '校验和不一致';
  if (asset.summary.blocked) return '存在阻断项';
  return '';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Readiness states in which an export button may even be rendered. */
export const EXPORTABLE: Readiness[] = ['needs_review', 'ready_for_handoff', 'exported'];
