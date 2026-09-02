# 演示证据数据（虚构）

**这些文件全部是为演示编造的，不是任何真实检测报告、认证证书或平台官方文件。**
不得在对外材料中把它们描述为官方证书或官方政策。

它们存在的目的，是让「证据账本 + 发布闸门」在离线环境下可复现地演示出六种情形：

| 文件 | 演示的情形 |
|---|---|
| `aerofold-spec.csv` | 可核实的数值事实（容量 350 ml、折叠 4 cm、耐温区间） |
| `aerofold-manual.txt` | 与规格表一致的第二来源（确认后事实转 verified） |
| `conflicting-spec.csv` | 来源冲突：另一份规格写 300 ml，容量事实转 conflicting |
| `expired-certificate.txt` | 过期证书：配合 `expires_on` 上传，认证类宣称被拦截 |
| `portfolio.csv` | 批量导入用的多 SKU 组合（Phase 2） |

**没有为 BPA-Free 提供任何证据文件，这是故意的**：演示「未获证据支撑的
BPA-Free 宣称必须被发布闸门拦截」。
