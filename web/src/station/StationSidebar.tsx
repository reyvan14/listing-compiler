import { useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { ImageGenerateIcon } from '@/pipeline/components/icons/ImageGenerateIcon'
import { ListingCompilerIcon } from '@/pipeline/components/icons/ListingCompilerIcon'
import { VideoGenerateIcon } from '@/pipeline/components/icons/VideoGenerateIcon'
import { defaultImageNode, defaultVideoNode, placeMediaNode } from '@/pipeline/nodes/types/mediaStation'
import { defaultSkuNode, frameStation } from '@/pipeline/nodes/types/skuStation'
import { createShapeId } from 'tldraw'
import styles from './stationChrome.module.scss'

function putNode(editor: Editor, node: ReturnType<typeof defaultImageNode> | ReturnType<typeof defaultVideoNode> | ReturnType<typeof defaultSkuNode>) {
  if (node.type === 'image_generation') {
    placeMediaNode(editor, 'image_generation')
    requestAnimationFrame(() => frameStation(editor))
    return
  }
  if (node.type === 'video_generation') {
    placeMediaNode(editor, 'video_generation')
    requestAnimationFrame(() => frameStation(editor))
    return
  }
  const id = createShapeId()
  editor.run(() => {
    editor.createShape({
      id,
      type: 'node',
      x: 36,
      y: 36,
      props: { node },
    })
    editor.select(id)
  })
  requestAnimationFrame(() => frameStation(editor))
}

export function StationSidebar({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState<'add' | 'help' | 'contact' | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!dockRef.current?.contains(event.target as Node)) setOpen(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  return (
    <div ref={dockRef} className={styles.dock}>
      <nav className={styles.rail} aria-label="画布菜单">
        <button
          type="button"
          className={`${styles.railBtn} ${styles.railAdd} ${open === 'add' ? styles.active : ''}`}
          title="添加节点"
          onClick={() => setOpen(cur => (cur === 'add' ? null : 'add'))}
        >
          <span className={styles.plus} />
        </button>
        <button
          type="button"
          className={`${styles.railBtn} ${styles.separated} ${open === 'help' ? styles.active : ''}`}
          title="功能说明"
          onClick={() => setOpen(cur => (cur === 'help' ? null : 'help'))}
        >
          <span className={styles.iconHelp} />
        </button>
        <button
          type="button"
          className={`${styles.railBtn} ${open === 'contact' ? styles.active : ''}`}
          title="联系方式"
          onClick={() => setOpen(cur => (cur === 'contact' ? null : 'contact'))}
        >
          <span className={styles.iconContact} />
        </button>
      </nav>

      {open === 'add' && (
        <section className={styles.menu} aria-label="添加节点">
          <div className={styles.menuTitle}>内容生成</div>
          <div className={styles.tiles}>
            <button
              type="button"
              className={styles.tile}
              onClick={() => {
                putNode(editor, defaultImageNode())
                setOpen(null)
              }}
            >
              <ImageGenerateIcon />
              <span>图片</span>
            </button>
            <button
              type="button"
              className={styles.tile}
              onClick={() => {
                putNode(editor, defaultVideoNode())
                setOpen(null)
              }}
            >
              <VideoGenerateIcon />
              <span>视频</span>
            </button>
          </div>
          <div className={styles.menuTitle}>业务节点</div>
          <button
            type="button"
            className={styles.row}
            onClick={() => {
              putNode(editor, defaultSkuNode())
              setOpen(null)
            }}
          >
            <ListingCompilerIcon />
            <span>上架编译器</span>
          </button>
        </section>
      )}

      {open === 'help' && (
        <section className={styles.menu} aria-label="功能说明">
          <div className={styles.menuTitle}>怎么用</div>
          <p className={styles.help}>
            左侧加图片/视频节点。中间画布跑 SKU 上新。右侧 Agent 只问答，不自动上架、不登广告账户。
          </p>
        </section>
      )}

      {open === 'contact' && (
        <section className={styles.menu} aria-label="联系方式">
          <div className={styles.menuTitle}>联系方式</div>
          <p className={styles.help}>天池初赛演示环境。评委路径走画布：填入演示 → 生成 → 三台检查。不登广告账户。</p>
        </section>
      )}
    </div>
  )
}
