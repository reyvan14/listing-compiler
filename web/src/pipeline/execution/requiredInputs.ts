import { getInputs, getNodeSpec } from '@/lib/pipeline-spec'
import { message } from '@/lib/antd'
import { Editor, TLShapeId } from 'tldraw'
import { getNodePortConnections, getNodePorts } from '../nodes/nodePorts'
import { EditorAtom } from '../utils'

// ===========================================================================
// T0.6b 执行期约束校验：运行前检查 required 前置是否已连接。
// required 缺失 → 禁止执行 + toast + 高亮缺口（决策基线）。
// recommended/optional 不在此拦截（不阻塞运行）。
// 前置关系以 @yidooo/pipeline-spec 为单一事实源。
// ===========================================================================

export interface MissingRequiredInput {
	nodeId: TLShapeId
	nodeLabel: string
	portId: string
	portLabel: string
}

/** 高亮状态：nodeId -> 缺失的 required 端口 id 集合。Port 组件据此渲染缺口高亮。 */
export const missingRequiredPorts = new EditorAtom<Map<TLShapeId, Set<string>>>(
	'missing required ports',
	() => new Map()
)

export function clearMissingRequiredPorts(editor: Editor) {
	if (missingRequiredPorts.get(editor).size > 0) {
		missingRequiredPorts.set(editor, new Map())
	}
}

/** 从起始节点沿 start 端口向上游游走，收集执行涉及的全部节点（与 ExecutionGraph 一致）。 */
function collectUpstreamNodes(editor: Editor, startingNodeIds: Set<TLShapeId>): TLShapeId[] {
	const seen = new Set<TLShapeId>()
	const toVisit = Array.from(startingNodeIds)
	while (toVisit.length > 0) {
		const id = toVisit.pop()!
		if (seen.has(id)) continue
		const node = editor.getShape(id)
		if (!node || !editor.isShapeOfType(node, 'node')) continue
		seen.add(id)
		for (const c of getNodePortConnections(editor, node)) {
			if (c.terminal === 'start') toVisit.push(c.connectedShapeId)
		}
	}
	return Array.from(seen)
}

/**
 * 返回执行图中所有「required 前置未连接」的缺口。
 * 仅校验「该 required 端口确实存在于节点」的情况——Phase 1 前 spec 端口与节点端口可能尚未
 * 对齐，对不存在的端口不做拦截，避免误伤。
 */
export function getMissingRequiredInputs(
	editor: Editor,
	startingNodeIds: Set<TLShapeId>
): MissingRequiredInput[] {
	const missing: MissingRequiredInput[] = []
	for (const nodeId of collectUpstreamNodes(editor, startingNodeIds)) {
		const node = editor.getShape(nodeId)
		if (!node || !editor.isShapeOfType(node, 'node')) continue
		const type = node.props.node.type
		const required = getInputs(type).filter((i) => i.tier === 'required')
		if (required.length === 0) continue

		const ports = getNodePorts(editor, node)
		const connections = getNodePortConnections(editor, node)
		const nodeLabel = getNodeSpec(type)?.label ?? type

		for (const input of required) {
			if (!ports[input.portId]) continue // 端口尚未在节点实现（Phase 1 前），跳过
			const connected = connections.some(
				(c) => c.terminal === 'end' && c.ownPortId === input.portId
			)
			if (!connected) {
				missing.push({ nodeId, nodeLabel, portId: input.portId, portLabel: input.label })
			}
		}
	}
	return missing
}

/**
 * 执行前守卫：required 齐全则清除高亮并返回 true（可执行）；否则设置缺口高亮 + 全局提示并返回 false。
 * 用全局 antd message（无需 React provider），因为本函数会从 tldraw shape 组件上下文调用，
 * 该上下文拿不到 tldraw 的 ToastsProvider。
 */
export function guardRequiredInputs(editor: Editor, startingNodeIds: Set<TLShapeId>): boolean {
	const missing = getMissingRequiredInputs(editor, startingNodeIds)
	if (missing.length === 0) {
		clearMissingRequiredPorts(editor)
		return true
	}

	const map = new Map<TLShapeId, Set<string>>()
	for (const m of missing) {
		const set = map.get(m.nodeId) ?? new Set<string>()
		set.add(m.portId)
		map.set(m.nodeId, set)
	}
	missingRequiredPorts.set(editor, map)

	const first = missing[0]
	message.warning(
		`「${first.nodeLabel}」缺少必需输入「${first.portLabel}」，无法运行` +
			(missing.length > 1 ? `（共 ${missing.length} 处缺口）` : '')
	)
	return false
}
