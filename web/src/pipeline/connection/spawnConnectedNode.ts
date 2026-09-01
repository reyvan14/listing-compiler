import { createShapeId, Editor, TLShapeId, VecModel } from 'tldraw'
import { PortDataType } from '../constants'
import { getNodePorts } from '../nodes/nodePorts'
import { NodeType } from '../nodes/nodeTypes'
import { findFirstCompatiblePort } from '../ports/portCompatibility'
import { createOrUpdateConnectionBinding } from './ConnectionBindingUtil'
import { getNextConnectionIndex } from './keepConnectionsAtBottom'

// ===========================================================================
// 程序化「新建节点 + 自动连线」。从 PointingPort.onClick 的拖拽建连逻辑提炼，
// 供「图片生成 → 自动生成图片节点并连线」等场景复用。
//
// 连线规则同手动建连：connection.start 绑到源节点的 output 口，connection.end 绑到
// 新节点上第一个与源 dataType 兼容的 input 口（找不到则删掉悬空连线、仅保留节点）。
// ===========================================================================

export interface SpawnConnectedNodeParams {
	editor: Editor
	/** 源节点 shape id（连线起点所在节点）。 */
	sourceShapeId: TLShapeId
	/** 源节点的 output 端口 id。 */
	sourcePortId: string
	/** 源 output 的 dataType，用于在新节点上匹配兼容 input 口。 */
	dataType: PortDataType
	/** 新节点的初始 props（如 LoadImageNodeDefinition.getDefault() 并填好 imageUrl）。 */
	nodeProps: NodeType
	/** 新节点 input 端口应落在的页面坐标（连线终点）。 */
	inputPortTarget: VecModel
}

/** 新建一个节点并用一条 connection 连到源节点。返回新节点 id。 */
export function spawnConnectedNode(params: SpawnConnectedNodeParams): TLShapeId {
	const { editor, sourceShapeId, sourcePortId, dataType, nodeProps, inputPortTarget } = params

	const connectionShapeId = createShapeId()
	editor.createShape({
		type: 'connection',
		id: connectionShapeId,
		x: inputPortTarget.x,
		y: inputPortTarget.y,
		index: getNextConnectionIndex(editor),
	})
	createOrUpdateConnectionBinding(editor, connectionShapeId, sourceShapeId, {
		portId: sourcePortId,
		terminal: 'start',
	})

	const newNodeId = createShapeId()
	editor.createShape({
		type: 'node',
		id: newNodeId,
		x: inputPortTarget.x,
		y: inputPortTarget.y,
		props: { node: nodeProps },
	})

	const ports = getNodePorts(editor, newNodeId)
	const inputPort = findFirstCompatiblePort(Object.values(ports), 'end', dataType)
	if (inputPort) {
		// 平移新节点，使其 input 口正好落在 inputPortTarget。
		editor.updateShape({
			id: newNodeId,
			type: 'node',
			x: inputPortTarget.x - inputPort.x,
			y: inputPortTarget.y - inputPort.y,
		})
		createOrUpdateConnectionBinding(editor, connectionShapeId, newNodeId, {
			portId: inputPort.id,
			terminal: 'end',
		})
	} else {
		// 新节点无兼容输入口：删掉悬空连线，仅保留节点。
		editor.deleteShape(connectionShapeId)
	}

	return newNodeId
}
