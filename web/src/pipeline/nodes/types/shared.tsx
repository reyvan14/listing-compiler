import { getInputs, getNodeSpec, type NodeInputSpec, type NodeRole } from '@/lib/pipeline-spec'
import classNames from 'classnames'
import { PointerEvent, SyntheticEvent, useCallback, useRef, useState } from 'react'
import {
	Editor,
	T,
	TldrawUiButton,
	TldrawUiButtonIcon,
	TLShapeId,
	TLUiIconJsx,
	useEditor,
	useValue,
} from 'tldraw'
import { AddIcon } from '../../components/icons/AddIcon'
import { SubtractIcon } from '../../components/icons/SubtractIcon'
import { NODE_WIDTH_PX, PORT_TYPE_COLORS, PortDataType } from '../../constants'
import { Port, PortId, ShapePort } from '../../ports/Port'
import { getNodeInputPortValues } from '../nodePorts'
import { NodeShape } from '../NodeShapeUtil'
import { NodeType } from '../nodeTypes'

/**
 * Pipeline values can be strings (prompts, image URLs, model IDs), numbers (steps, cfg scale),
 * or null (no value yet).
 */
export type PipelineValue = string | number | null

/**
 * A special value that can be returned from a node to indicate that execution should stop.
 */
export type STOP_EXECUTION = typeof STOP_EXECUTION
export const STOP_EXECUTION = Symbol('STOP_EXECUTION')

export interface SingleInfoValue {
	value: PipelineValue | STOP_EXECUTION
	isOutOfDate: boolean
	dataType: PortDataType
	multi?: false
}

export interface MultiInfoValue {
	value: (PipelineValue | STOP_EXECUTION)[]
	isOutOfDate: boolean
	dataType: PortDataType
	multi: true
}

export type InfoValue = SingleInfoValue | MultiInfoValue

export function isMultiInfoValue(v: InfoValue): v is MultiInfoValue {
	return v.multi === true
}

export interface InfoValues {
	[key: string]: InfoValue
}

export interface ExecutionResult {
	[key: string]: PipelineValue | STOP_EXECUTION
}

export interface InputValues {
	[key: string]: PipelineValue | PipelineValue[]
}

export interface NodeComponentProps<Node extends { type: string }> {
	shape: NodeShape
	node: Node
}

export abstract class NodeDefinition<Node extends { type: string }> {
	constructor(public readonly editor: Editor) {
		const ctor = this.constructor as NodeDefinitionConstructor<Node>
		this.type = ctor.type
		this.validator = ctor.validator
	}

	readonly type: Node['type']
	readonly validator: T.Validator<Node>
	abstract readonly title: string
	abstract readonly heading?: string
	abstract readonly icon: TLUiIconJsx
	/** A short category label for grouping in the toolbar. */
	abstract readonly category: string
	readonly resultKeys?: readonly string[]
	readonly canResizeNode: boolean = false
	/** If true, this node type is hidden from the toolbar and on-canvas picker. */
	readonly hidden: boolean = false
	/**
	 * Whether the shared footer chrome (run/stop button + overflow menu) is rendered.
	 * Nodes that draw their own run/copy controls inside the body (e.g. the two-pane
	 * creative_strategy / demand_insight) set this false. When false, the footer height
	 * is also excluded from the shape geometry (see getNodeHeightPx).
	 */
	readonly showFooter: boolean = true
	/**
	 * Whether the shared heading chrome (icon + title + output-port row) is rendered.
	 * Nodes that draw their own header inside the body (e.g. the media-gen control panel)
	 * set this false. When false, the heading height is also excluded from the geometry.
	 */
	readonly showHeading: boolean = true

	// ---- 业务关系/约束：单一事实源 @yidooo/pipeline-spec ----
	// 后置(successors)由 OnCanvasNodePicker 直接读 spec；下面两个 getter 为
	// 业务语义角色与前置依赖提供统一入口（技术型/未登记节点返回 undefined / []）。

	/** 业务语义角色（洞察/策略/生成/功能型）。未登记于 spec 的技术型节点为 undefined。 */
	get nodeRole(): NodeRole | undefined {
		return getNodeSpec(this.type)?.nodeRole
	}

	/** 前置依赖（含 required/recommended/optional 三档 + acceptsNodeTypes）。未登记节点为空数组。 */
	get predecessors(): readonly NodeInputSpec[] {
		return getInputs(this.type)
	}

	getWidthPx(_shape: NodeShape, _node: Node): number {
		return NODE_WIDTH_PX
	}

	/** Per-instance heading. Default is the static `heading` / `title`. */
	getHeading(_node: Node): string {
		return this.heading ?? this.title
	}

	abstract getDefault(): Node
	abstract getBodyHeightPx(shape: NodeShape, node: Node): number
	abstract getPorts(shape: NodeShape, node: Node): Record<string, ShapePort>
	onPortConnect(_shape: NodeShape, _node: Node, _port: PortId): void {}
	onPortDisconnect(_shape: NodeShape, _node: Node, _port: PortId): void {}
	/**
	 * 当某个输入端口值为 STOP_EXECUTION 时，是否把本节点输出也短路为 STOP（默认 true：上游停则下游停）。
	 * 像 load_image 这种「自身可作数据源」的节点，在持有自身值时应返回 false，
	 * 避免被上游 STOP/失败掐断（详见 nodePorts 的输出短路逻辑）。
	 */
	shortCircuitsOnInputStop(_node: Node): boolean {
		return true
	}
	/**
	 * 执行前的「节点内部状态」校验（区别于 requiredInputs 的端口连接校验）。
	 * 返回非空字符串 = 校验失败的提示文案（执行入口可据此 toast 并阻止）。默认通过。
	 * 注意：这是 UX 即时提示；真正的兜底守卫应在 execute() 内（返回 STOP_EXECUTION），
	 * 以覆盖整区运行 / 下游拉起等不经过单节点 run 按钮的入口。
	 */
	validateBeforeExecute(_node: Node): string | null {
		return null
	}
	abstract getOutputInfo(shape: NodeShape, node: Node, inputs: InfoValues): InfoValues
	abstract execute(
		shape: NodeShape,
		node: Node,
		inputs: InputValues,
		signal?: AbortSignal
	): Promise<ExecutionResult>
	abstract Component: React.ComponentType<NodeComponentProps<Node>>
}

export interface NodeDefinitionConstructor<Node extends { type: string }> {
	new (editor: Editor): NodeDefinition<Node>
	readonly type: Node['type']
	readonly validator: T.Validator<Node>
}

/**
 * Update the `node` prop within a node shape.
 */
export function updateNode<T extends NodeType>(
	editor: Editor,
	shape: NodeShape,
	update: (node: T) => T,
	isOutOfDate: boolean = true
) {
	const currentShape = editor.getShape(shape.id)
	const currentNode =
		currentShape && editor.isShapeOfType(currentShape, 'node')
			? (currentShape.props.node as T)
			: (shape.props.node as T)

	editor.updateShape({
		id: shape.id,
		type: shape.type,
		props: { node: update(currentNode), isOutOfDate },
	})
}

/**
 * A row in a node. This component just applies some styling.
 */
export function NodeRow({
	children,
	className,
	...props
}: {
	children: React.ReactNode
	className?: string
} & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div {...props} className={classNames('NodeRow', className)}>
			{children}
		</div>
	)
}

/**
 * A label for a port row, displayed next to the port.
 */
export function NodePortLabel({
	children,
	dataType,
}: {
	children: React.ReactNode
	dataType: PortDataType
}) {
	return (
		<span className="NodePortLabel" style={{ color: PORT_TYPE_COLORS[dataType] }}>
			{children}
		</span>
	)
}

/**
 * A row in a node for a numeric input. If the port is connected, the input is disabled and the
 * value is taken from the port. Otherwise, the input is editable with a spinner for incrementing
 * and decrementing the value.
 */
export function NodeInputRow({
	shapeId,
	portId,
	label,
	value,
	onChange,
	onBlur,
}: {
	shapeId: TLShapeId
	portId: PortId
	label?: string
	value: number
	onChange: (value: number) => void
	onBlur?: () => void
}) {
	const editor = useEditor()
	const inputRef = useRef<HTMLInputElement>(null)
	const portInfo = useValue('from port', () => getNodeInputPortValues(editor, shapeId)[portId], [
		editor,
		shapeId,
		portId,
	])
	const valueFromPort = portInfo?.value
	const isOutOfDate = portInfo?.isOutOfDate

	const [pendingValue, setPendingValue] = useState<string | null>(null)

	const onPointerDown = useCallback((event: PointerEvent) => {
		event.stopPropagation()
	}, [])

	const onSpinner = (delta: number) => {
		const newValue = value + delta
		onChange(newValue)
		setPendingValue(String(newValue))
		inputRef.current?.focus()
	}

	const displayValue = isOutOfDate
		? '...'
		: typeof valueFromPort === 'number'
			? valueFromPort
			: valueFromPort != null
				? String(valueFromPort)
				: (pendingValue ?? value)

	return (
		<NodeRow className="NodeInputRow">
			<Port shapeId={shapeId} portId={portId} />
			{label && <span className="NodeInputRow-label">{label}</span>}
			{isOutOfDate || valueFromPort === STOP_EXECUTION ? (
				<NodePlaceholder />
			) : (
				<input
					ref={inputRef}
					type="text"
					inputMode="decimal"
					disabled={valueFromPort != null}
					value={displayValue}
					onChange={(e) => {
						setPendingValue(e.currentTarget.value)
						const asNumber = Number(e.currentTarget.value.trim())
						if (Number.isNaN(asNumber)) return
						onChange(asNumber)
					}}
					onPointerDown={onPointerDown}
					onBlur={() => {
						setPendingValue(null)
						onBlur?.()
					}}
					onFocus={() => {
						editor.setSelectedShapes([shapeId])
					}}
				/>
			)}
			<div className="NodeInputRow-buttons">
				<TldrawUiButton
					title="decrement"
					type="icon"
					onPointerDown={onPointerDown}
					onClick={() => onSpinner(-1)}
				>
					<TldrawUiButtonIcon icon={<SubtractIcon />} />
				</TldrawUiButton>
				<TldrawUiButton
					title="increment"
					type="icon"
					onPointerDown={onPointerDown}
					onClick={() => onSpinner(1)}
				>
					<TldrawUiButtonIcon icon={<AddIcon />} />
				</TldrawUiButton>
			</div>
		</NodeRow>
	)
}

/**
 * A placeholder for a value that is not yet computed.
 */
export function NodePlaceholder() {
	return <div className="NodeValue_placeholder" />
}

/**
 * An image element that hides itself if the source fails to load.
 */
export function NodeImage({ src, alt }: { src: string; alt: string }) {
	const onError = useCallback((e: SyntheticEvent<HTMLImageElement>) => {
		e.currentTarget.style.display = 'none'
	}, [])
	return <img src={src} alt={alt} onError={onError} />
}

/**
 * Format a pipeline value for display.
 */
export function NodeValue({ value }: { value: PipelineValue | STOP_EXECUTION }) {
	if (value === STOP_EXECUTION || value === null) {
		return <NodePlaceholder />
	}

	if (typeof value === 'number') {
		return <>{formatNumber(value)}</>
	}

	// For strings, truncate long values. 结构化节点的端口值是 payload JSON 串，
	// 预览只展示其 summary（parsePayload 对普通文本是无操作回退）。
	const str = parsePayload(value).summary
	if (str.length > 20) {
		return <span title={str}>{str.slice(0, 18)}...</span>
	}
	return <>{str}</>
}

function formatNumber(value: number): string {
	if (value === 0) return '0'
	if (!isFinite(value)) return value.toString()

	const absValue = Math.abs(value)
	const sign = value < 0 ? '-' : ''

	if (absValue >= 1_000_000) {
		return sign + (absValue / 1_000_000).toPrecision(3) + 'M'
	}
	if (absValue >= 1_000) {
		return sign + (absValue / 1_000).toPrecision(3) + 'k'
	}

	if (absValue >= 1) {
		return sign + absValue.toPrecision(5).replace(/\.?0+$/, '')
	} else if (absValue >= 0.001) {
		return sign + absValue.toPrecision(3)
	} else {
		return value.toExponential(2)
	}
}

export function areAnyInputsOutOfDate(inputs: InfoValues): boolean {
	return Object.values(inputs).some((input) => input.isOutOfDate)
}

/**
 * Load a URL (data URL or http URL) into an HTMLImageElement.
 */
export function loadImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = (_e) => reject(new Error('Failed to load image'))
		img.crossOrigin = 'anonymous'
		img.src = url
	})
}

/**
 * Convert a Blob to a data URL via FileReader.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onloadend = () => resolve(reader.result as string)
		reader.onerror = reject
		reader.readAsDataURL(blob)
	})
}

// ---------------------------------------------------------------------------
// Input coercion helpers
// ---------------------------------------------------------------------------

/** Coerce any pipeline value to a string. */
export function coerceToText(value: PipelineValue, fallback = ''): string {
	if (value == null) return fallback
	if (typeof value === 'number') return String(value)
	return value
}

/** Coerce any pipeline value to a number. */
export function coerceToNumber(value: PipelineValue, fallback = 0): number {
	if (value == null) return fallback
	if (typeof value === 'number') return value
	const n = parseFloat(value)
	return Number.isNaN(n) ? fallback : n
}

/** Extract a single value from an InputValues entry (takes first element if array). */
export function getInput(inputs: InputValues, key: string): PipelineValue {
	const v = inputs[key]
	if (Array.isArray(v)) return v[0] ?? null
	return v ?? null
}

/** Always return an array from an InputValues entry. */
export function getInputMulti(inputs: InputValues, key: string): PipelineValue[] {
	const v = inputs[key]
	if (v == null) return []
	if (Array.isArray(v)) return v
	return [v]
}

/** Extract a single value and coerce to string. */
export function getInputText(inputs: InputValues, key: string, fallback = ''): string {
	return coerceToText(getInput(inputs, key), fallback)
}

/** Extract a single value and coerce to number. */
export function getInputNumber(inputs: InputValues, key: string, fallback = 0): number {
	return coerceToNumber(getInput(inputs, key), fallback)
}

// ---------------------------------------------------------------------------
// 结构化输出 payload（圈层画像 / 需求洞察 / 创意策略）。
//
// 背景：管线值 PipelineValue 仅支持 string|number|null，端口无法直接传对象。
// 这些洞察/策略节点把结构化结果以 JSON 串走 text 端口，约定：
//   · execute() 输出 `JSON.stringify(payload)`；
//   · payload 必含纯文本字段 `summary`，作为只要文本的下游（文本/图片/视频生成等）的回退；
//   · 下游一律用 getInputSummaryText() 读取，绝不直接把端口原值（可能是 JSON 串）塞进 prompt。
// 构造 payload 时务必保持固定键顺序，避免 JSON.stringify 抖动导致 isOutOfDate 误传播。
//
// 实现放在独立的 ./payload（仅类型导入 shared），避免 shared ↔ nodeTypes 运行时循环。
// 此处本地引入并再导出：本地绑定供 NodeValue 使用，再导出保持各节点 `from './shared'` 引用不变。
// ---------------------------------------------------------------------------

import { getInputSummaryText, parsePayload, type PipelinePayload } from './payload'
export { getInputSummaryText, parsePayload, type PipelinePayload }
