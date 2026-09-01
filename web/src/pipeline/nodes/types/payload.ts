// ---------------------------------------------------------------------------
// 结构化输出 payload 的纯工具（圈层画像 / 需求洞察 / 创意策略）。
//
// 独立成文件、仅做「类型导入」shared，以避免 shared.tsx ↔ nodeTypes 的运行时初始化
// 循环（直接 import shared 作为入口会让 NodeDefinition 尚未定义时被子类 extend）。
// 这里不 import 任何 shared 的运行时值，getInput 逻辑就地内联。
//
// 约定：管线值仅支持 string|number|null，端口不能传对象。结构化结果以 JSON 串走 text
// 端口，payload 必含纯文本 `summary` 作为只要文本的下游的回退。详见 shared.tsx 说明。
// ---------------------------------------------------------------------------

import type { InputValues, PipelineValue } from './shared'

export interface PipelinePayload {
	/** 纯文本摘要——必有，作为只需要文本的下游的回退值。 */
	summary: string
	[key: string]: unknown
}

/**
 * 把端口拿到的原始值解析为 PipelinePayload。**永不抛**：
 * 非字符串 / 非 JSON / 非对象 / 无 summary / summary 非字符串 → 回退 `{ summary: String(raw) }`。
 */
export function parsePayload(raw: PipelineValue): PipelinePayload {
	if (typeof raw !== 'string') {
		return { summary: raw == null ? '' : String(raw) }
	}
	try {
		const obj = JSON.parse(raw)
		if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.summary === 'string') {
			return obj as PipelinePayload
		}
	} catch {
		// 非 JSON：当作普通文本
	}
	return { summary: raw }
}

/** 取单值（数组取首元素），与 shared.getInput 同语义，内联以避免循环依赖。 */
function firstInput(inputs: InputValues, key: string): PipelineValue {
	const v = inputs[key]
	if (Array.isArray(v)) return v[0] ?? null
	return v ?? null
}

/**
 * 取上游某输入的**纯文本摘要**（给只需要文本的下游：需求洞察/创意策略/文本生成等）。
 * 结构化 JSON 串 → 提取 .summary；普通文本 → 原样返回；缺失/空 summary → fallback。
 */
export function getInputSummaryText(inputs: InputValues, key: string, fallback = ''): string {
	const v = firstInput(inputs, key)
	if (v == null) return fallback
	return parsePayload(v).summary || fallback
}
