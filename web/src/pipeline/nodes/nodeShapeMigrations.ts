import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from '@tldraw/tlschema'

// ===========================================================================
// node shape 的 props 迁移机制（T0.3，从零建立）。
//
// 背景：NodeShapeUtil.props = { node: NodeType(各类型 T.object 严格校验的并集), isOutOfDate }。
// tldraw 在「加载持久化记录 → 校验」之前会先按本序列做 up 迁移。因此当我们给**已存在的
// 节点类型**增删 props 字段时（Phase 1 会发生），必须在此追加一条迁移把旧记录补齐默认值，
// 否则旧画布因缺字段而校验失败、无法打开。
//
// ── 约定（务必遵守）───────────────────────────────────────────────────────
// 1. 每次改动「已存在节点类型」的 props 结构 = 在 nodeShapeVersions 注册一个递增版本，
//    并在 sequence 追加一条 { id, up, down }。
// 2. 迁移**逻辑**写在纯函数（本文件下方 backfill* 区），不依赖 React/tldraw，便于单测。
// 3. up 只在「该字段缺失」时补默认值（用 `??=` / 存在性判断），保持幂等。
// 4. down 一般可写 'retired'（见 tldraw 说明：部署数月后的 down 可退役）。
//
// 注意：**新增一个全新节点类型**（如 T0.2 的 text_generation）**不需要**迁移——旧画布里
//      根本没有该类型的 shape；getDefaultProps/各节点 getDefault 负责新建实例的默认值。
//      迁移仅服务于「修改已存在类型」。
// ===========================================================================

/**
 * 版本号注册表。生成形如 `com.tldraw.shape.node/1` 的稳定 id。
 * Phase 1 起在此登记，例如：
 *   { AddImageVideoGenFields: 1, AddDemandInsightSources: 2 }
 */
export const nodeShapeVersions = createShapePropsMigrationIds('node', {
	// Phase 1 / T1.6：图片生成新增 imageType/count；视频生成新增 videoType/platform/duration/count。
	AddGenNodeFields: 1,
	// 图片生成接 ai-server：新增 imageUrls（生成结果图片 URL 列表）。
	AddImageGenUrls: 2,
	// 图片生成「生成即落外部图片节点」：新增 spawnedNodeIds（已自动生成并连线的节点 id）。
	AddImageGenSpawned: 3,
	// 图片节点支持缩略图预览：load_image 新增 thumbnailUrl。
	AddLoadImageThumbnail: 4,
	// 生成节点去掉模型选择(删 model 字段) + 图片/视频类型改用英文码(旧中文值归一为默认)。
	RemoveModelAndRetypeGen: 5,
	// 视频生成接 ai-server：新增 videoUrls / posterUrls（生成结果原件 + 封面 URL 列表）。
	AddVideoGenResults: 6,
	// creative_strategy / demand_insight 双栏改造：新增用户自由文本输入 userInput。
	AddStrategyInsightUserInput: 7,
	// image_generation 新控制面板：新增 mode/model、分辨率改 2K/4K。
	AddImageGenPanelFields: 8,
	// video_generation 新控制面板：新增 mode/model/audio/cameraMode、分辨率归一。
	AddVideoGenPanelFields: 9,
	// video_generation 接后端归一化契约：model 改 seedance/hailuo/pixverse + 各 mode 素材输入字段。
	AddVideoGenModeInputs: 10,
	// image_generation 新增 text2imgDone：文生图首次出图成功后锁住「文生图」tab。
	AddImageGenText2imgDone: 11,
	// image_generation 新增 isResultNode：Run 后 spawn 的基础节点标记。
	AddImageGenResultNode: 12,
	// video_generation 新增 isResultNode：Run 后 spawn 的基础节点标记。
	AddVideoGenResultNode: 13,
	// 圈层画像改造：personaId→personaIds[]、新增 demandSignals[]/businessTendencies[]、
	// contentPreference 删除并尽力回填、lastResult 改结构化 payload（旧 string 置 null）。
	ReworkAudiencePersonaFilters: 14,
	// 需求洞察：analysisTarget→analysisTargets[]、lastResult 改结构化（旧 string 置 null）。
	MultiSelectDemandInsight: 15,
	// 创意策略：删 hookDirection、平台/目标/形式选项收窄、lastResult 改结构化（旧 string 置 null）。
	NarrowCreativeStrategy: 16,
	// video_generation 参考生视频新增 referenceVideos[]/referenceAudios[]（视频/音频参考素材）。
	AddVideoGenRefMedia: 17,
	// video_generation 结果节点新增 crop（自由裁剪框，纯前端显示裁剪元数据）：旧记录补 crop:null。
	AddVideoGenCrop: 18,
	// 圈层画像：demandSignals[]/businessTendencies[] 双多选 → 单选 signalType（需求信号/商业倾向），
	// 由旧字段尽力推断后删旧键（T.object 严格校验）。
	ReworkPersonaSignalType: 19,
	// 图片生成预览改「按结果真实比例」：新增 resultAspectRatio（结果图 naturalWidth:naturalHeight）。
	AddImageGenResultAspectRatio: 20,
	// SKU 上架编译器：删除假阶段进度 stepIndex，新增下游素材包 videoBrief/imageAssets。
	AddSkuDownstreamArtifacts: 21,
})

// 图片/视频「类型」改为传英文码（显示中文、存英文）。旧的中文值/缺失统一回填为默认。
const IMAGE_TYPE_CODES = ['ArtGen', 'RealGen', 'Text2Img']
const VIDEO_TYPE_CODES = ['QuickClip', 'MultiClip', 'BatchClip', 'MotionStyle', 'CineClip']
// 图片生成模型（后端契约取值）。
const IMAGE_GEN_MODELS = ['image-2', 'seedream-5', 'nano-banana-2']
// 旧版展示名 → 后端契约值（早期画布存的是 'Image-2' 等）。
const IMAGE_GEN_MODEL_REMAP: Record<string, string> = {
	'Image-2': 'image-2',
	'Nanabanana-2': 'nano-banana-2',
	'Seedream-5': 'seedream-5',
}
// 视频生成模型（后端契约取值）。
const VIDEO_GEN_MODELS = [
	'seedance-1.5',
	'seedance-2.0',
	'seedance-2.0-fast',
	'hailuo-2.3',
	'pixverse-v6',
	'vidu-3.0pro',
]
// 旧值 → 契约值（早期把视频 model 存成 'Seedream5.0'）。
const VIDEO_GEN_MODEL_REMAP: Record<string, string> = { 'Seedream5.0': 'seedance-2.0' }
// 旧节点只有 videoType（无 model）时，按 videoType 映射到对应模型，保住原模型意图，
// 避免一律落到 seedance-2.0 改变旧画布的请求模型（MotionStyle→hailuo、CineClip→pixverse）。
const VIDEO_TYPE_TO_MODEL: Record<string, string> = {
	QuickClip: 'seedance-1.5',
	MultiClip: 'seedance-2.0',
	BatchClip: 'seedance-2.0-fast',
	MotionStyle: 'hailuo-2.3',
	CineClip: 'pixverse-v6',
}
// 各 model 支持的分辨率（大小写按后端）。
const VIDEO_RES_BY_MODEL: Record<string, string[]> = {
	'seedance-1.5': ['480p', '720p', '1080p'],
	'seedance-2.0': ['480p', '720p', '1080p'],
	'seedance-2.0-fast': ['480p', '720p', '1080p'],
	'hailuo-2.3': ['512P', '768P', '1080P'],
	'pixverse-v6': ['360p', '540p', '720p', '1080p'],
	'vidu-3.0pro': ['540p', '720p', '1080p'],
}
function normalizeVideoResolutionForModel(model: string, current: unknown): string {
	const list = VIDEO_RES_BY_MODEL[model] ?? ['480p', '720p', '1080p']
	const hit = list.find((r) => r.toLowerCase() === String(current ?? '').toLowerCase())
	return hit ?? (model === 'hailuo-2.3' ? '768P' : '720p')
}

// ---- 洞察/策略节点改造用常量（与各节点 getDefault / 选项列表保持一致）----------
// 创意策略收窄后的合法选项；旧画布里不在集合内的值回填为默认。
const CS_PLATFORMS = ['TikTok', 'Instagram', 'Facebook']
const CS_GOALS = ['提升曝光', '提升互动', '提升种草', '提升转化']
const CS_FORMS = ['短视频', '图文']
// ---------------------------------------------------------------------------
// 纯迁移逻辑（无 React / 无 tldraw 运行时依赖，可在 node 中直接单测）。
// 形参/返回值都是普通对象 `node`（即 shape.props.node）。
//
// 注意（Phase 2 起出现的「减字段」迁移）：T.object 严格校验拒绝未知键，故移除字段时
// 必须 delete 旧键；旧 string 型 lastResult 改结构化后置 null（有损，旧 mock 结果作废）。
// 所有改写都做存在性/类型判断，保持幂等。
// ---------------------------------------------------------------------------

/**
 * 当前所有 up 迁移对单个 node 对象的累积变换。仅在字段缺失时补默认值（`??=`），保持幂等。
 * 默认值须与各节点 getDefault() 一致。
 */
export function backfillNodeProps(node: Record<string, unknown>): Record<string, unknown> {
	switch (node.type) {
		case 'image_generation':
			node.count ??= 1
			node.imageUrls ??= []
			node.spawnedNodeIds ??= []
			// 参考生图/图片编辑：本地上传的参考图列表。
			node.referenceImages ??= []
			// 新面板字段：mode（tab）+ model（模型选择，重新作为字段）。
			node.mode ??= 'text2img'
			// 旧展示名（Image-2…）归一到后端契约值（image-2…）。
			if (typeof node.model === 'string' && IMAGE_GEN_MODEL_REMAP[node.model]) {
				node.model = IMAGE_GEN_MODEL_REMAP[node.model]
			}
			if (typeof node.model !== 'string' || !IMAGE_GEN_MODELS.includes(node.model)) {
				node.model = 'image-2'
			}
			// 分辨率改 2K/4K：旧的「标准/高清」或缺失统一归一为 2K。
			if (node.resolution !== '2K' && node.resolution !== '4K') {
				node.resolution = '2K'
			}
			// 图片类型仍传后端（新面板未暴露）：旧中文值/缺失回填默认英文码。
			if (typeof node.imageType !== 'string' || !IMAGE_TYPE_CODES.includes(node.imageType)) {
				node.imageType = 'ArtGen'
			}
			// 文生图首次出图成功后锁「文生图」tab 的标记。
			node.text2imgDone ??= false
			// 基础节点标记（spawn 出的承载单张结果的节点）。旧画布的 image_generation 都是生成器。
			node.isResultNode ??= false
			// #40 新增必填 name 但漏了 backfill：旧画布缺 name 会让整批 createShapes 校验抛错、整张画布加载失败。
			node.name ??= '图片节点'
			// 结果图真实比例（"1600:900"）。旧记录无该字段 → null：出图 onLoad 时按 naturalWidth/Height 写入，
			// 写入前预览用中性 16:9（请求比例按钮不再决定预览/结果显示）。
			if (typeof node.resultAspectRatio !== 'string') node.resultAspectRatio = null
			break
		case 'video_generation':
			node.platform ??= 'TikTok'
			node.duration ??= '5s'
			node.count ??= 1
			node.videoUrls ??= []
			node.posterUrls ??= []
			// 新控制面板字段：mode（tab）/ model / audio / cameraMode + 各 mode 素材输入。
			node.mode ??= 'text2video'
			node.referenceImages ??= []
			node.referenceVideos ??= []
			node.referenceAudios ??= []
			node.firstFrameUrl ??= null
			node.lastFrameUrl ??= null
			node.referenceVideoUrl ??= null
			node.audio ??= false
			node.cameraMode ??= '固定'
			// 基础节点标记（spawn 出的承载结果的节点）。旧画布的 video_generation 都是生成器。
			node.isResultNode ??= false
			// 自由裁剪框（纯前端显示裁剪）：旧记录无该字段 → null（未裁剪，全画幅）。
			node.crop ??= null
			// model 归一到后端契约值（旧 'Seedream5.0' → seedance-2.0；非法值回默认）。
			if (typeof node.model === 'string' && VIDEO_GEN_MODEL_REMAP[node.model]) {
				node.model = VIDEO_GEN_MODEL_REMAP[node.model]
			}
			if (typeof node.model !== 'string' || !VIDEO_GEN_MODELS.includes(node.model)) {
				const fromType =
					typeof node.videoType === 'string' ? VIDEO_TYPE_TO_MODEL[node.videoType] : undefined
				node.model = fromType ?? 'seedance-2.0'
			}
			// 分辨率按当前 model 归一（大小写对齐能力集）。
			node.resolution = normalizeVideoResolutionForModel(node.model as string, node.resolution)
			if (typeof node.aspectRatio !== 'string') node.aspectRatio = '9:16'
			// 视频类型改用英文码：旧中文值（口播/开箱…）或缺失统一回填默认。
			if (typeof node.videoType !== 'string' || !VIDEO_TYPE_CODES.includes(node.videoType)) {
				node.videoType = 'QuickClip'
			}
			break
		case 'sku_listing':
			// 假阶段进度已移除（后端不上报阶段），删旧键（T.object 严格校验拒绝未知键）。
			if ('stepIndex' in node) delete node.stepIndex
			// 下游素材包：生成成功后写入的视频 brief 与去重图片资产。旧画布补空值，
			// 下一次生成成功时自然填充。
			node.videoBrief ??= ''
			if (!Array.isArray(node.imageAssets)) node.imageAssets = []
			break
		case 'load_image':
			node.thumbnailUrl ??= null
			break
		case 'audience_persona':
			// personaId(单选 string) → personaIds[]，保住旧选择。
			if (!Array.isArray(node.personaIds)) {
				node.personaIds =
					typeof node.personaId === 'string' && node.personaId ? [node.personaId] : []
			}
			// 与 personaIds 同序的 agent_persona_json 集合；旧画布缺该字段补空数组。
			if (!Array.isArray(node.personaAgentJsons)) node.personaAgentJsons = []
			// 信号维度改单选 signalType（需求信号 默认 / 商业倾向）。由旧多选 / 旧 contentPreference 尽力推断后删旧键。
			if (node.signalType !== 'demand' && node.signalType !== 'business') {
				const oldBiz = Array.isArray(node.businessTendencies) && node.businessTendencies.length > 0
				const oldDemand = Array.isArray(node.demandSignals) && node.demandSignals.length > 0
				const prefBiz = node.contentPreference === 'preference-business'
				node.signalType = (oldBiz && !oldDemand) || prefBiz ? 'business' : 'demand'
			}
			// 移除旧字段（T.object 严格校验拒绝未知键）。
			if ('personaId' in node) delete node.personaId
			if ('contentPreference' in node) delete node.contentPreference
			if ('demandSignals' in node) delete node.demandSignals
			if ('businessTendencies' in node) delete node.businessTendencies
			// lastResult 改结构化：旧 string（或 undefined）置 null；已是对象/ null 则保留。
			if (typeof node.lastResult !== 'object') node.lastResult = null
			break
		case 'demand_insight':
			// analysisTarget(单选 string) → analysisTargets[]，保住旧选择。
			if (!Array.isArray(node.analysisTargets)) {
				node.analysisTargets =
					typeof node.analysisTarget === 'string' && node.analysisTarget
						? [node.analysisTarget]
						: []
			}
			if ('analysisTarget' in node) delete node.analysisTarget
			node.userInput ??= ''
			if (typeof node.lastResult !== 'object') node.lastResult = null
			break
		case 'creative_strategy':
			node.userInput ??= ''
			// 删除已移除的 Hook 方向字段。
			if ('hookDirection' in node) delete node.hookDirection
			// 目标平台改多选 string[]：旧 string → [合法值] 或 []；已是数组则过滤非法值。
			if (Array.isArray(node.platform)) {
				node.platform = node.platform.filter((p) => CS_PLATFORMS.includes(p as string))
			} else if (typeof node.platform === 'string') {
				node.platform = CS_PLATFORMS.includes(node.platform) ? [node.platform] : []
			} else {
				node.platform = []
			}
			// 内容目标/形式单选：非法/缺失归一为空串（触发框显示占位 label）。
			if (typeof node.contentGoal !== 'string' || !CS_GOALS.includes(node.contentGoal)) {
				node.contentGoal = ''
			}
			if (typeof node.contentForm !== 'string' || !CS_FORMS.includes(node.contentForm)) {
				node.contentForm = ''
			}
			if (typeof node.lastResult !== 'object') node.lastResult = null
			break
	}
	return node
}

// ---------------------------------------------------------------------------
// tldraw 迁移序列（把纯逻辑接到 shape props 上）。
// 目前为空：尚未修改任何已存在节点类型的 props。Phase 1 起按上方约定追加条目。
// ---------------------------------------------------------------------------
export const nodeShapeMigrations = createShapePropsMigrationSequence({
	sequence: [
		{
			// 旧画布的 image/video 节点缺新增字段会校验失败，此处补全默认值。
			id: nodeShapeVersions.AddGenNodeFields,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 image_generation 补 imageUrls（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddImageGenUrls,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 image_generation 补 spawnedNodeIds（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddImageGenSpawned,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 load_image 补 thumbnailUrl（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddLoadImageThumbnail,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 删 image/video 的 model 字段 + 图片/视频类型归一为英文码（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.RemoveModelAndRetypeGen,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 video_generation 补 videoUrls / posterUrls（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddVideoGenResults,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 creative_strategy / demand_insight 补 userInput（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddStrategyInsightUserInput,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 image_generation 补 mode/model + 归一 resolution（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddImageGenPanelFields,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 video_generation 补 mode/model/audio/cameraMode + 归一 resolution。
			id: nodeShapeVersions.AddVideoGenPanelFields,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 视频接归一化契约：model 改 seedance/hailuo/pixverse + referenceImages/首尾帧/续写视频字段。
			id: nodeShapeVersions.AddVideoGenModeInputs,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 image_generation 补 text2imgDone（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddImageGenText2imgDone,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 image_generation 补 isResultNode（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddImageGenResultNode,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 video_generation 补 isResultNode（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddVideoGenResultNode,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 圈层画像改造：personaId→personaIds[]、新增 demandSignals/businessTendencies、
			// 删 contentPreference、lastResult 结构化（backfillNodeProps 含删字段，幂等）。
			id: nodeShapeVersions.ReworkAudiencePersonaFilters,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 需求洞察：analysisTarget→analysisTargets[]、lastResult 结构化。
			id: nodeShapeVersions.MultiSelectDemandInsight,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 创意策略：删 hookDirection、选项收窄回填、lastResult 结构化。
			id: nodeShapeVersions.NarrowCreativeStrategy,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 video_generation 补 referenceVideos/referenceAudios（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddVideoGenRefMedia,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 video_generation 补 crop（自由裁剪框，默认 null；backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddVideoGenCrop,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 圈层画像信号维度改单选：删 demandSignals/businessTendencies、推断写入 signalType（backfillNodeProps 含删字段，幂等）。
			id: nodeShapeVersions.ReworkPersonaSignalType,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// 给已存在的 image_generation 补 resultAspectRatio（backfillNodeProps 累积且幂等）。
			id: nodeShapeVersions.AddImageGenResultAspectRatio,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
		{
			// sku_listing：删 stepIndex、补 videoBrief/imageAssets（backfillNodeProps 含删字段，幂等）。
			id: nodeShapeVersions.AddSkuDownstreamArtifacts,
			up: (props) => ({
				...props,
				node: backfillNodeProps({ ...(props.node as Record<string, unknown>) }),
			}),
			down: 'retired',
		},
	],
})
