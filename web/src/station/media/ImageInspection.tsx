import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewOriginalButton, useImageLightbox } from '@/components/useImageLightbox';
import type { ListingResultNode } from '@/pipeline/nodes/types/skuStation';
import {
  RESULT_STATE_META,
  imageErrorMessage,
  listAssets,
  originalUrl,
  registerDataUrl,
  toDataUrl,
  uploadImage,
  verifyAsset,
  type ImageAsset,
} from './imageApi';
import { describeValue, formatBytes, openQuestions, orderResults, verdictOf } from './imageSummary';
import styles from './imageInspection.module.scss';

// Image compliance section of the inspector's Compliance tab.
//
// Kept visually separate from the text policy checks for the same reason the
// evidence gate is: a title can satisfy every formatting rule while the main
// image is unusable, and collapsing the two would hide that.

export function ImageInspection({
  node,
  productId,
  revisionId = '',
}: {
  node: ListingResultNode;
  productId: string;
  revisionId?: string;
}) {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const rows = await listAssets(node.platform, productId, signal);
      if (mounted.current) setAssets(rows);
    },
    [node.platform, productId],
  );

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal).catch(err => {
      if (!controller.signal.aborted && mounted.current) setError(imageErrorMessage(err));
    });
    return () => controller.abort();
  }, [reload]);

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
        await reload();
        if (mounted.current) setNotice(done);
      } catch (err) {
        if (mounted.current) setError(imageErrorMessage(err));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [reload],
  );

  const inspectCurrent = () =>
    run(async () => {
      const dataUrl = await toDataUrl(node.imageUrl);
      await registerDataUrl(
        {
          dataUrl,
          platform: node.platform,
          origin: 'generated',
          label: node.imageLabel,
          revisionId,
        },
        productId,
      );
    }, '已按像素检查当前主图。');

  return (
    <section className={styles.block} data-testid="image-inspection">
      <div className={styles.head}>
        <h3>图片检查</h3>
        <span className={styles.kicker}>按实际像素判定 · 与文本政策校验分开</span>
      </div>

      <p className={styles.muted}>
        结论全部来自解码后的图片本身：格式取自文件字节，背景取自边缘像素采样。
        提示词写了「纯白背景」不构成任何证据。
      </p>

      <div className={styles.actions}>
        <button
          type="button"
          disabled={busy || !node.imageUrl}
          data-testid="inspect-current-image"
          onClick={inspectCurrent}
        >
          检查当前主图
        </button>
        <label className={styles.upload}>
          <span>{busy ? '处理中…' : '上传图片检查'}</span>
          <input
            type="file"
            accept="image/*"
            data-testid="inspect-upload"
            disabled={busy}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) {
                void run(
                  () => uploadImage(file, node.platform, productId, revisionId),
                  '已检查上传的图片。',
                );
              }
            }}
          />
        </label>
      </div>

      {error && (
        <p className={styles.error} role="alert" data-testid="image-error">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}

      {assets.length === 0 ? (
        <p className={styles.muted} data-testid="image-none">
          还没有检查过任何图片。示例卡片使用的是 SVG 矢量占位图，没有可采样的像素，
          需要真实的 PNG / JPEG 才能进行像素级检查。
        </p>
      ) : (
        <ul className={styles.assetList}>
          {assets.map(asset => (
            <AssetCard key={asset.asset_id} asset={asset} productId={productId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AssetCard({ asset, productId }: { asset: ImageAsset; productId: string }) {
  const lightbox = useImageLightbox();
  const [checksum, setChecksum] = useState('');
  const verdict = verdictOf(asset);
  const m = asset.measurements;
  const src = originalUrl(asset.asset_id, productId);
  const open = openQuestions(asset);

  return (
    <li className={styles.asset} data-testid="image-asset" data-asset={asset.asset_id}>
      <div className={styles.assetHead}>
        <div className={`${styles.thumb} ImageZoomHost`}>
          <img src={src} alt={`${asset.label} 原图`} />
          <ViewOriginalButton compact onOpen={trigger => lightbox.openLightbox(trigger)} />
        </div>
        <div className={styles.assetMeta}>
          <div className={styles.assetTop}>
            <b>{asset.label}</b>
            <span className={styles.origin}>
              {asset.origin === 'generated' ? '生成' : '上传'}
            </span>
            <span className={styles.verdict} data-tone={verdict.tone} data-testid="image-verdict">
              {verdict.headline}
            </span>
          </div>
          <p className={styles.muted}>{verdict.detail}</p>
          <dl className={styles.measureGrid} data-testid="image-measurements">
            <div>
              <dt>格式</dt>
              <dd>{m.format} · {m.mime_type}</dd>
            </div>
            <div>
              <dt>尺寸</dt>
              <dd>
                {m.width}×{m.height}px · {m.aspect_ratio}
              </dd>
            </div>
            <div>
              <dt>文件大小</dt>
              <dd>{formatBytes(m.size_bytes)}</dd>
            </div>
            <div>
              <dt>色彩模式</dt>
              <dd>
                {m.color_mode}
                {m.has_alpha ? ' · 含透明通道' : ''}
              </dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd>
                <code>{asset.sha256.slice(0, 16)}…</code>
              </dd>
            </div>
            <div>
              <dt>检查方法 / 时间</dt>
              <dd>
                <code>{m.method}</code> · {m.inspected_at}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {asset.background && (
        <div className={styles.background} data-testid="image-background">
          <h4>背景采样</h4>
          <div className={styles.bgRow}>
            <i className={styles.swatch} style={{ background: asset.background.background_hex }} />
            <span>
              估计 <code>{asset.background.background_hex}</code> · 一致度{' '}
              {(asset.background.uniformity * 100).toFixed(0)}% · 采样{' '}
              {asset.background.sample_count} 点（
              {asset.background.sampled_regions.map(r => r.band).join(' / ')}）
            </span>
          </div>
          <p className={styles.muted}>
            一致度 = 与估计色一致的采样点占比（容差 ±{asset.background.tolerance}/通道）。
            它衡量「是否存在单一背景色」，不代表平台会不会通过。方法：
            <code>{asset.background.method}</code>
          </p>
        </div>
      )}

      <ul className={styles.results} data-testid="image-results">
        {orderResults(asset.results).map(r => {
          const meta = RESULT_STATE_META[r.state];
          return (
            <li key={r.rule_id} data-state={r.state} data-rule={r.rule_id}>
              <div className={styles.resultHead}>
                <span className={styles.chip} data-tone={meta.tone}>
                  {meta.label}
                </span>
                <code>{r.rule_id}</code>
              </div>
              <p className={styles.detail}>{r.detail}</p>
              <p className={styles.compare}>
                实测 <b>{describeValue(r.measured)}</b> · 要求{' '}
                <b>{describeValue(r.expected)}</b> · 政策快照{' '}
                <code>{r.policy_snapshot_id}</code> · 方法 <code>{r.method}</code>
              </p>
            </li>
          );
        })}
      </ul>

      {open.length > 0 && (
        <p className={styles.openNote} data-testid="image-open-questions">
          本工具未判定 {open.length} 项（{open.map(r => r.rule_id.split('.').pop()).join('、')}），
          它们既不是通过也不是不通过，需要人工核验后由你负责。
        </p>
      )}

      <div className={styles.assetActions}>
        <button
          type="button"
          data-testid="image-verify"
          onClick={() =>
            verifyAsset(asset.asset_id, productId)
              .then(r =>
                setChecksum(r.matches ? '校验一致：文件与记录的 SHA-256 相同。' : '校验不一致：文件已变化或缺失。'),
              )
              .catch(err => setChecksum(imageErrorMessage(err)))
          }
        >
          校验文件完整性
        </button>
        {checksum && (
          <span className={styles.muted} data-testid="image-checksum">
            {checksum}
          </span>
        )}
      </div>

      {lightbox.render(src, `${asset.label} 原图`, asset.label)}
    </li>
  );
}
