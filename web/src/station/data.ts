export type Phase = 'intake' | 'generating' | 'result' | 'ad';
export type AssetMode = 'compliant' | 'promo';
export type CheckState = 'pass' | 'fix' | 'ad-only';
export type PlatformId = 'amazon' | 'tiktok' | 'shopify';

export type CheckItem = {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
};

export type PlatformDraft = {
  id: PlatformId;
  name: string;
  role: string;
  title: string;
  fields: { label: string; value: string }[];
  imageLabel: string;
  imageUrl?: string;
  checks: CheckItem[];
};

export const DEMO_SKU = {
  name: '折叠硅胶水杯 350ml',
  market: 'US',
  points:
    '折叠到 4cm，口袋能装\n食品级硅胶，-40°C 到 200°C\n防漏盖，350ml\nBPA-Free\n适合徒步、办公、出差',
};

const assetBase = import.meta.env.BASE_URL;
export const IMAGES = {
  white: `${assetBase}station/cup-white.svg?v=2`,
  lifestyle: `${assetBase}station/cup-lifestyle.svg?v=2`,
  promo: `${assetBase}station/cup-promo.svg?v=2`,
};

export const GENERATE_STEPS = [
  '对照规则表（出处 + 摘录日期）',
  '写 Amazon 标题 / 五点 / 搜索词',
  '写 TikTok Shop 短标题与描述',
  '写 Shopify 品牌长描述',
  '按台出图：两台白底主图，品牌站生活图',
  '生成后再验：能贴 / 需改 / 只能去投放',
];

export const EMPTY_HINT: Record<PlatformId, string[]> = {
  amazon: ['标题', '五点', '搜索词', '白底主图', '详情规划'],
  tiktok: ['25–200 短标题', '描述', '白底主图', '商品视频位'],
  shopify: ['品牌标题', '长描述', '生活图（无强制白底）'],
};

export const RULE_ROWS = [
  {
    platform: 'Amazon',
    role: '货架',
    image: '纯白 RGB 255,255,255 · 主体约 85% · 主图禁加字',
    source: 'Seller Central 主图规范',
    date: '2026-08-25',
  },
  {
    platform: 'TikTok Shop',
    role: '货架（连着内容）',
    image: '商品卡主图偏白底、无加字；≠ 信息流广告封面',
    source: 'TikTok Shop 美国卖家大学 Listing',
    date: '2026-08-25',
  },
  {
    platform: 'Shopify',
    role: '品牌站',
    image: '无强制白底，生活图可用',
    source: 'Shopify 商品媒体帮助',
    date: '2026-08-25',
  },
];

const BPA_FIX: CheckItem = {
  id: 'bpa',
  label: 'BPA-Free 宣称',
  state: 'fix',
  detail: '卖点写了 BPA-Free，工位未见证书。标出来，不替平台删，也不担保过审。',
};

function imageCheck(mode: AssetMode, platform: PlatformId): CheckItem {
  if (platform === 'shopify') {
    return {
      id: 'img',
      label: '品牌站用图',
      state: 'pass',
      detail:
        mode === 'promo'
          ? 'Shopify 不强制白底。这张带字竖版可当生活/活动图，不能回填两台货架主图。'
          : '生活图可用。无强制白底。',
    };
  }
  if (mode === 'promo') {
    return {
      id: 'img',
      label: platform === 'amazon' ? '主图纯白无加字' : '商品卡主图无加字',
      state: 'fix',
      detail:
        platform === 'amazon'
          ? '带字竖版、非纯白底。Amazon 主图不能贴。请改用白底无字图，或把这张只去投放。'
          : 'TikTok Shop 商品卡主图不能加字。信息流广告封面是另一套，走投放条。',
    };
  }
  return {
    id: 'img',
    label: platform === 'amazon' ? '主图纯白无加字' : '商品卡主图无加字',
    state: 'pass',
    detail:
      platform === 'amazon'
        ? '纯白底、无加字、主体足够。机械检查通过，不等于平台终审。'
        : '商品卡主图无加字。注意：这不是投放封面。',
  };
}

export function buildDrafts(mode: AssetMode): PlatformDraft[] {
  return [
    {
      id: 'amazon',
      name: 'Amazon',
      role: '货架',
      title:
        'Collapsible Silicone Travel Cup 350ml, Leak-Proof Lid, Heat-Resistant Pocket Cup for Hiking Camping Office',
      fields: [
        { label: '五点 1', value: 'Folds flat to 4cm — slips into a jacket pocket or carry-on side pouch.' },
        { label: '五点 2', value: 'Food-grade silicone body; dishwasher-safe; rated -40°C to 200°C.' },
        { label: '五点 3', value: 'Leak-proof lid with sip hole for commuting and trail breaks.' },
        { label: '五点 4', value: '350ml / 12oz — one coffee or one refill of water.' },
        { label: '五点 5', value: 'Unexpand the ring stack after wash; air-dry with the lid off.' },
        {
          label: '搜索词',
          value: 'collapsible cup; silicone travel mug; hiking cup 350ml; pocket cup leak proof',
        },
        {
          label: '详情规划',
          value: 'Hero 折叠演示 → 防漏测试 → 温度范围 → 尺寸对照 → 清洗 → 场景 → 规格表 → FAQ',
        },
      ],
      imageLabel: '白底主图 1:1',
      checks: [
        { id: 'title', label: '标题长度', state: 'pass', detail: '英文字段完整，未超常见 200 字符上限。' },
        { id: 'bullets', label: '五点齐全', state: 'pass', detail: '五条独立卖点，未塞促销标语。' },
        imageCheck(mode, 'amazon'),
        BPA_FIX,
      ],
    },
    {
      id: 'tiktok',
      name: 'TikTok Shop',
      role: '货架 · 连着内容',
      title: '350ml foldable silicone travel cup — leak-proof lid, pocket size for hike & commute',
      fields: [
        {
          label: '描述',
          value:
            'Pack a real cup, not a disposable. Folds to 4cm, 350ml, leak-proof lid. Food-grade silicone, -40°C to 200°C. Product card uses a clean main image; the 15s clip lives on the ad strip.',
        },
        { label: '标题长度', value: '97 字符（规则 25–200）' },
        { label: '商品视频位', value: '1 条货架短视频位，待从投放条回填。不是信息流广告。' },
      ],
      imageLabel: '商品卡主图',
      checks: [
        { id: 'title', label: '标题 25–200', state: 'pass', detail: '短标题落在卖家大学 Listing 区间内。' },
        imageCheck(mode, 'tiktok'),
        BPA_FIX,
      ],
    },
    {
      id: 'shopify',
      name: 'Shopify',
      role: '品牌站',
      title: 'Pocket Cup 350',
      fields: [
        {
          label: '长描述',
          value:
            'A cup that disappears into a pocket. Pocket Cup 350 is a collapsible silicone vessel for people who already carry too much. 350ml. Folds to 4cm. Lid that actually seals.\n\nThe shelf channels want a white card. This page can show the cup on a desk, in a bag, at a trailhead.',
        },
        {
          label: '媒体',
          value: '生活图可用（无强制白底）。活动竖版可挂品牌站，不可回填 Amazon / TikTok Shop 主图。',
        },
      ],
      imageLabel: '品牌站生活图',
      checks: [
        { id: 'copy', label: '品牌标题与长描述', state: 'pass', detail: '站点语气，不是五点模板。' },
        imageCheck(mode, 'shopify'),
      ],
    },
  ];
}

export const AD_CUT = {
  duration: '15 秒',
  ratio: '9:16',
  destinations: 'TikTok / Reels 投放同事',
  script: [
    '0–3s  口袋抽出，展开成杯。无口播标语压主图。',
    '3–8s  倒水、盖盖、倒立两秒。字幕：350ml · 防漏。',
    '8–12s 折叠回 4cm，塞进夹克。字幕：口袋能装。',
    '12–15s 结束卡：Pocket Cup 350。不出现「已发布」。',
  ],
  note: '这是投放条，不是第四个上新台。按钮只下载，不登广告账户。',
};

export function summarize(drafts: PlatformDraft[]) {
  const all = drafts.flatMap(d => d.checks);
  return {
    pass: all.filter(c => c.state === 'pass').length,
    fix: all.filter(c => c.state === 'fix').length,
    adOnly: all.filter(c => c.state === 'ad-only').length,
  };
}
