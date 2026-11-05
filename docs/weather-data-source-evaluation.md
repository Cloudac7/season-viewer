# 天气数据源评估与「免费 / 开放」升级方案

> 项目：四时 · 中国季节地图（season-viewer / season-atlas）
> 评估对象：当前用 Open-Meteo 估算各点位温度的数据链路
> 文档日期：2026-11-05
> 约束前提：**只使用免费、开放、免注册**的数据源；非商业原型；本文件只做评估与方案，不改代码、不改快照、不改 CI。

---

## 1. 摘要与结论

**结论（先给答案）：有更准的数据源，但在「免费、开放、免注册」的约束内，能拿到的最准数据并不是「换一家 API」这么简单，而是「选对模式 + 历史换成高分辨率再分析 + 用免费站点观测做偏差订正」。**

- 真正显著更准的中国区域格点气温产品是**中国气象局 CLDAS-V2.0（多源陆面同化，约 0.0625°≈6km，逐时，含 2m 气温，融合密集中国站点）**、**CMFD 2.0（0.1°，站点订正，科研用）**、**CMA 站点观测 / CMA-RA 再分析**。这些**都需要在中国气象数据网等平台注册/申请，通常限非商业研究用途，部分需商业授权**——在本项目「免注册、免费、可公开部署」的约束下**不能直接采用**。它们代表免费的「精度天花板」，本报告作为参考记录。
- 在免费/开放范围内，按性价比排序的升级路径为：
  1. **P0**：预报显式指定高技巧模式（ECMWF IFS 0.25°），历史引入 ERA5-Land 0.1° 做回看与校验；先建立留出站点集的基线误差。风险最低。
  2. **P1（收益最大）**：接入**免费站点真值**（NOAA GSOD/ISD 机场站 + Meteostat），做**分区（或逐格网）分月偏差订正**，同时作用于历史与预报。这是免费手段里对「实时判季」最有效的提升。
  3. **P2（可选）**：用 ERA5-Land 0.1° **回填历史窗口**，并把固定 6.5°C/km 递减率升级为分季节/分区域递减率（启发式近似，不增加真实信息）。
  4. **P3（记录，不实施）**：若放宽到注册/商业，升级到 CLDAS / CMFD / CMA 站点为真实精度跃升。

**一句话推荐**：保持 Open-Meteo 作为预报与近实时来源，显式选 ECMWF IFS 0.25° 为主、best_match/CMA 为备；历史回看用 ERA5-Land 0.1°；在此基础上加一层基于 NOAA GSOD/ISD + Meteostat 的站点偏差订正。若某天允许注册研究数据，则历史直接换 CLDAS-V2.0。

---

## 2. 现状与方法（基于代码核实）

### 2.1 当前数据链路

| 环节 | 现状 | 代码位置 |
| --- | --- | --- |
| 县级代表点 | `daily=temperature_2m_mean`，约 2874 个县级单元代表点，走 `api.open-meteo.com/v1/forecast`（`best_match`） | `src/lib/county-weather.ts`、`scripts/update-counties.ts` |
| 1° 独立格网 | 约 1265 个规则格网节点，同样 `temperature_2m_mean` + `cell_selection=land`，`best_match` | `src/lib/spatial-grid.ts`、`scripts/update-weather-grid.ts`、`scripts/import-weather-grid.ts` |
| 城市旧链路 | 近期用 `forecast`，历史用 `archive-api.open-meteo.com/v1/archive` | `src/lib/weather.ts` |
| 高程订正 | Open-Meteo 先把温度下推到请求点 90m DEM；项目再按 `T参考 = T节点 + 0.0065×z节点` 归算，四邻双线性插值，再 `T格点 = T参考插值 − 0.0065×z格点` | `README.md` 第 67 行、`src/lib/spatial-field.ts` |
| 历史窗口 | 快照内最长约 30 个连续完整日（判季只需 9 个连续完整日）；增量每轮抓 `past_days=2`（冷启动 14 天） | `scripts/precompute-spatial.ts`、`county-weather.ts`、`spatial-grid.ts` |
| 预报 | 7 天，`forecast_days=7`，「预计完成换季」用它推断 | `src/lib/forecast.ts` |
| 配额 | 免费接口按「位置 × 时间跨度」计费，保守日上限约 9900；县级 + 格点同轮共用额度账本 | `scripts/open-meteo-request.ts` |

### 2.2 精度瓶颈（为什么现在只是「估算」）

1. **数据本质是模式估算，不是实测**：`temperature_2m_mean` 来自数值天气模式（`best_match` 会在覆盖该点的模式中自动挑分辨率最高者，中国大陆一般落到 ECMWF IFS 0.25°/GFS 等全球模式），并非地面站点观测，也不是站点同化分析。
2. **有系统性偏差且未订正**：模式对地形复杂区、冬季、城市群常有冷/暖偏差；当前没有任何站点偏差订正。
3. **降尺度是启发式**：固定 `6.5°C/km` 递减率无法表达逆温、坡向、冷空气堆积；90m DEM 只提升「请求点高程」一致性，**不等于 90m 天气精度**（README 第 70 行已声明）。
4. **实时最近几天无法用再分析**：再分析（ERA5-Land 等）有数天到数月滞后，而判季依赖最近几天；这部分只能靠模式 + 订正。
5. **没有常年基准**：GB/T 42074—2022 的正式判定需要 1991–2020 常年日温、偏早二次判断等，README 第 98 行已声明未实现，当前只是滑标参考初判。

---

## 3. 候选数据源对比

### 3.1 免费 / 开放（本项目范围）

| # | 产品 | 类型 | 空间分辨率 | 时间 / 时效 | 中国大陆精度特征 | 许可与获取 | 本项目接入方式与工作量 | 建议用途 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Open-Meteo `best_match`（现状） | 全球模式自动择优 | 0.25°≈9km 起 | 历史 past_days + 7 天预报 | 中等；有系统偏差，山地/冬季更差 | 免费、免注册，非商业；超额度/商用需付费 | 已接入 | 基线 |
| 2 | Open-Meteo `models=ecmwf_ifs025` | ECMWF IFS HRES 0.25° | ≈9km | 预报 + 短历史 | 免费全球模式中技巧最高，稳定性好 | 同上 | 改请求参数即可，工作量很低 | **预报主选** |
| 3 | Open-Meteo CMA 预报 API（`/docs/cma-api`） | CMA 开放数据 | ~0.25° | 预报 | 中国区域本地化好，但官方提示源站负载高、稳定性差 | 免费、开放 | 改基址/参数，工作量低 | 备用 / 对照 |
| 4 | **ERA5-Land**（Open-Meteo Historical API `models=era5_land`，或 Copernicus CDS） | 再分析（陆地） | **0.1°≈9km** | 逐时，1950–至今；ERA5T 初步约 5 天滞后，最终产品滞后更久 | 比 0.25° 细；山地/冬季偏冷，日均温精度优于全球粗网格 | 免费开放（CDS 需注册下载；Open-Meteo 免注册） | Open-Meteo 同一 key 可拉；CDS 需批量脚本 | **历史回看 / 校验主选** |
| 5 | ERA5（0.25°） | 再分析 | 0.25°≈31km | 逐时，1940–至今 | 精度尚可但更粗 | 免费开放 | 同 4 的回退 | 回退 |
| 6 | **NOAA CPC Global Unified Temperature** | 站点融合日分析 | **0.5°** | 日值，约 1–2 天滞后 | 站点参与、独立于 ECMWF，适合作第三方校验 | 免费开放（NOAA PSL FTP/HTTP） | 批量下载 + 与格点比对 | 独立校验 / 粗分辨率参考 |
| 7 | **NOAA GSOD / ISD 站点 + Meteostat** | 地面站点观测 | 点 | 日值，站点覆盖不均 | **真值**；中国站点在东部/机场较密，西部稀疏 | 免费开放 | 新增站点导入 + 偏差场计算 | **偏差订正（P1 核心）** |
| 8 | Open-Meteo Climate API | 气候降尺度 + 偏差订正 | 依底层（ECMWF/ERA5 等） | 逐日气候序列 | 自带统计降尺度与偏差订正（可关闭） | 免费开放 | 新链路，工作量中 | 未来做常年基准时复用 |

### 3.2 更准但超出免费约束（仅记录「精度天花板」，不实施）

| 产品 | 类型 | 分辨率 | 为什么更准 | 获取限制 |
| --- | --- | --- | --- | --- |
| **CLDAS-V2.0**（CMA 陆面数据同化） | 多源融合实况分析 | **≈0.0625°≈6km**，逐时，含 2m 气温 | 同化中国密集地面站 + 卫星，是中国区域最准的实况格点之一 | 中国气象数据网（`data.cma.cn`）注册/申请，通常限研究、部分商业授权；数据量大需批量管道 |
| **CMFD 2.0**（中国气象强迫数据集） | 站点订正的强迫数据 | 0.1°，3 小时，1979–2018/更新 | 以中国站点订正，历史气候研究常用 | 国家青藏高原科学数据中心注册下载，限科研；近实时截止，需补当前 |
| **CMA-RA / CRA-40** | 中国全球大气再分析 | 0.25° | 中国区域再分析 | CMA 注册 |
| 和风天气 / Meteoblue / CMA 商业 | 商业服务 | 高 | 站点融合 + 高分辨率 + SLA | 商业付费授权 |

> 说明：这些产品若可获取，将是**历史日均温最直接的精度跃升**；但它们与「免费、免注册、可公开部署」的前提冲突，故本方案不采用，仅作为「若放宽约束」的备选记录。

---

## 4. 推荐方案（分级、免费 / 开放）

> 设计原则：不破坏现有「缺测不跨洞填补」「预报只用于推断完成」「资料时间不冒充模式起报时次」等口径；优先低风险、可增量验证的改动。

### 4.1 P0 — 低风险基线（几乎不改结构）

- **预报**：请求显式 `models=ecmwf_ifs025`（ECMWF IFS HRES 0.25°）为主；`best_match` 与 CMA API 作备份/降级。
- **历史回看**：引入 ERA5-Land 0.1°（Open-Meteo `models=era5_land`）作为历史比对与回填来源。
- **先测量**：用留出的中国站点集（NOAA GSOD/ISD）计算当前与 P0 的日均温 RMSE、平均偏差、判季日期差，建立**可量化基线**。
- **预期**：小幅、稳健提升；许可零风险；为 P1 提供对照基线。

### 4.2 P1 — 站点偏差订正（推荐主攻，收益最大）

- **数据**：免费站点真值 = NOAA GSOD/ISD（机场站为主，东部较密）+ Meteostat 补充。
- **方法**：按格网/分区 × 月份估计模式相对站点的**平均偏差与方差**，对历史与预报施加**偏差订正（bias correction）**；对残差做**收缩/正则**，防止小样本过拟合；用留出站点做交叉验证。
- **作用对象**：县级代表点与 1° 格网同法订正；对判季最有价值的是**最近几天**的订正。
- **预期**：相对误差常见可降约 20–40%（具体以本项目留出验证为准），且同时改善历史与 7 天预报。
- **代价**：新增站点导入/偏差场计算模块与快照字段；西部站点稀疏区收益有限，需标注不确定性。

### 4.3 P2 — 历史回填与降尺度增强（可选）

- **历史回填**：用 ERA5-Land 0.1° 回填历史窗口，提升历史回看一致性与「换季日期」稳定性。
- **降尺度**：把固定 6.5°C/km 升级为**分季节/分区域递减率**，并对逆温/冷空气堆积做启发式处理；明确标注为显示近似，不增加真实气象信息。
- **注意**：再分析最近几天不可用 → 回填只能覆盖「已发布」时段，最近 3–7 天仍需预报模式 past_days + 订正。

### 4.4 P3 — 放宽约束后的真实跃升（记录）

- 升级历史到 **CLDAS-V2.0（0.0625°）** 或 **CMFD 2.0（0.1°）**；短期预报仍用 ECMWF + 订正或 CMA 区域模式。需注册/授权与批量管线。

---

## 5. 关键判断：为什么「免费」里最大的增益是站点订正而不是换再分析

- 再分析（ERA5-Land/CPC）**有滞后**：ERA5T 初步产品约 5 天，最终产品更久；CPC 约 1–2 天。判季用「昨天及之前 4 天」，这段正是再分析缺位区。
- 因此**实时判季的最近几天只能来自预报模式的分析场**；把它和**同地同时段的站点观测**对齐做偏差订正，才是免费手段里对实时判季最直接、最可验证的提升。
- ERA5-Land 0.1° 的价值在**历史回看一致性**与**偏差参考**，而非「替换最近几天」。

---

## 6. 后续实施附录：代码触点与数据流变更（供将来实施）

> 本节只列清单，**本次不改代码**。按变更顺序分组。

### 6.1 传输层与请求构造

| 变更 | 文件 | 要点 |
| --- | --- | --- |
| 从「硬编码单一 URL」改为「provider + model + 基址」 | `src/lib/open-meteo.ts` | 增加 `models=`、archive 基址（`archive-api`）；保留错误类型 |
| 预报/历史请求加模型参数 | `src/lib/county-weather.ts`、`src/lib/spatial-grid.ts` | 加 `models`；`spatial-grid.ts` 保留 `cell_selection=land` 与高程注释 |
| 历史回填 | 新脚本（复用 `src/lib/weather.ts` archive 逻辑） | 用 `models=era5_land` 拉 30 天历史 |
| 备用/降级模式 | 同上 | `ecmwf_ifs025` 失败 → `best_match` → CMA |

### 6.2 配额与限流

| 变更 | 文件 | 要点 |
| --- | --- | --- |
| 复核计费口径 | `scripts/open-meteo-request.ts` | `weatherBatchCost`、`OPEN_METEO_BATCH_SIZE`、`OpenMeteoQuota` 需按新源（ERA5-Land archive 计费可能不同）复核 |
| 会话/冷却 | 同上 | CI session、429 冷却逻辑保持 |

### 6.3 类型与校验（**关键**）

- `source:'open-meteo'` 目前是**字面量联合类型**，散落在：
  - `src/lib/counties.ts`（`CountyWeather.source`、`validCountyWeather`）
  - `src/lib/spatial-grid.ts`（`WeatherGrid.source`、`EMPTY_GRID_WEATHER`、`validGridWeather`）
  - `src/lib/precomputed.ts`（`PrecomputedDetails.weather.source`）
- 需改为**可扩展的 provider 枚举**（如 `'open-meteo' | 'era5-land' | 'cldas' ...`）或增加独立的 `provider`/`model` 字段，并同步校验函数与 `data/precomputed` 版本哈希（`scripts/precompute-spatial.ts` 的 `sourceFiles`/`codeFiles`/`spatial-precompute-v2`）。

### 6.4 偏差订正（P1 新增）

- 新模块：`src/lib/stations.ts`（站点数据模型与校验）、`scripts/import-stations.ts`（NOAA GSOD/ISD、Meteostat 导入）、`scripts/compute-bias.ts`（分区/逐格网分月偏差场）。
- 快照：偏差场落到 `data-sources/` 或 `county-weather.json` / `weather-grid-weather.json` 的 `bias` 字段；**必须定义 schema 与校验**，并纳入预计算版本哈希。
- 应用点：`src/lib/county-weather.ts`、`src/lib/spatial-grid.ts` 写入时，或 `src/lib/spatial-field.ts` / `classifyCounty` 读取时施加。建议在**写入快照时**订正，保证「点选读数 = 展示场」一致。

### 6.5 更新/预计算/CI

- 脚本：`scripts/update-counties.ts`、`update-weather-grid.ts`、`import-weather-grid.ts`、`seed-production-weather.ts`、`refresh-precomputed.ts`、`precompute-spatial.ts` 均需同步新参数/新字段/新哈希。
- CI：`.github/workflows/daily-weather.yml` 的缓存键（`weather-v1-*`）、`OPEN_METEO_QUOTA_SESSION`、配额账本清理逻辑需复核；新增站点下载步骤需考虑运行时长（当前 `timeout-minutes: 120`）。

### 6.6 对外署名 / 前端文案

- `src/App.tsx`：字段来源注记「Open-Meteo + Terrarium DEM · …」、「Open-Meteo 模型数据」、「模型参考」等。
- `src/components/CountyMap.tsx`：tooltip footer「Open-Meteo 模型 · 非全县实测或全县均温」。
- `src/lib/map-export.ts`：导出图页脚「Open-Meteo + Terrarium DEM · … 模型估算，非地面实测」、`OPEN-METEO · DAILY MODEL`。
- `README.md`：数据来源、许可、配额、方法说明。
- **合规要求**：若引入 ERA5-Land/CPC/NOAA/Meteostat，需按其许可补充署名与「模型估算，非地面实测」表述保持一致。

---

## 7. 边界情况与失败模式

1. **再分析滞后与近实时缺口**：ERA5-Land/CPC 无法覆盖最近几天 → 必须与预报 API past_days 混合，并在前端标注来源时效。
2. **站点稀疏/缺测**：西部、高原、海岛站点少 → 偏差订正按大区分区并加收缩；稀疏区标注「订正置信度低」。
3. **小样本过拟合**：分月 × 分区样本不足 → 用跨年/邻近月份池化、正则化、留出验证。
4. **模式单点大偏差或源站故障**：CMA 源负载高、ECMWF 更新时次 → 多模式备选与降级，单批失败保留旧快照（沿用现有 checkpoint 机制）。
5. **海岸/高山/城市热岛**：固定递减率与粗网格难以表达 → 明确标注不确定性，不夸大精度。
6. **配额与许可**：免费额度、署名要求、非商业限制；不得用免费接口承接超额生产流量（沿用 README 第 100 行口径）。
7. **不改变既有口径**：缺测不跨洞填补；预报只用于推断完成；边界与行政归属口径不变。

---

## 8. 验收与测试标准

### 8.1 本报告验收清单
- [ ] 结论明确回答「是否有更准数据源」并区分「免费内」与「需授权」。
- [ ] 对比表每个源都有分辨率、时间/时效、许可、接入成本、建议用途。
- [ ] 推荐方案分级、可执行、与「免费/开放/免注册」一致。
- [ ] 代码触点与仓库实际一致（文件路径、字面量类型、脚本、CI 均核对）。
- [ ] 引用链接有效。

### 8.2 后续实施测试要求（写入报告，供将来执行）
- 单测：请求参数与模型选择（断言 `models=ecmwf_ifs025`、archive 基址）；校验器对新增 provider/schema 的接受与拒绝。
- 偏差订正确定性：同一输入 → 同一输出（可复现）；留出站点集量化 RMSE/偏差改善（对比 P0 基线）。
- 回归：判季结果与换季口径不变（对既有测试样本）；快照兼容与配额预算核算（`bootstrapCalls`、日增量）。
- 预计算：`precompute-spatial` 版本哈希随源/模型/订正变化刷新；发布原子性与 `verifyPublicationFiles` 不回归。

---

## 9. 假设与范围外

- **假设**：保持免费、开放、免注册；非商业原型；本次只交付报告，**不改代码 / 快照 / CI**。
- **范围外**：
  - 不接入需注册/付费的 CLDAS / CMFD / CMA 商业数据（仅作精度天花板记录）。
  - 不实现 1991–2020 常年基准与 GB/T 全业务判定（作为可选后续记录）。
  - 不做前端/地图/导出的大改；不改变既有判季与换季口径。
- **未验证项**：各源当前配额、模型清单、许可细则以实施时官方文档为准（见参考链接）。

---

## 10. 参考链接

- Open-Meteo 官方文档：<https://open-meteo.com/en/docs>
- Open-Meteo 模式更新与可用性：<https://open-meteo.com/en/docs/model-updates>
- Open-Meteo 历史天气 API（含 ERA5 / ERA5-Land）：<https://open-meteo.com/en/docs/historical-weather-api>
- Open-Meteo CMA 预报 API：<https://open-meteo.com/en/docs/cma-api>
- Open-Meteo Climate API（统计降尺度/偏差订正）：<https://open-meteo.com/en/docs/climate-api>
- Open-Meteo 定价与商业许可：<https://open-meteo.com/en/pricing>
- ERA5-Land 气温资料在中国大陆区域的精度评价（黄晓龙等）：<https://zgkjqk.com/periodical/hnqx/hnqx202504003>
- 七种再分析地表气温产品在中国大陆的综合比较（Remote Sensing）：<https://www.mdpi.com/2072-4292/18/16/2752>
- 三种再分析气温数据系统在中国的多尺度评估（Agriculture）：<https://doi.org/10.3390/agriculture11121292>
- NOAA CPC Global Unified Temperature（0.5° 日值）：<https://psl.noaa.gov/rest/data.cpc.globaltemp.html>
- CPC Global Daily Surface Air Temperature Analyses（说明 PDF）：<https://ftp.cpc.ncep.noaa.gov/precip/PEOPLE/wd52ws/global_temp/CPC-GLOBAL-T.pdf>
- Meteostat 站点数据库：<https://meteostat.net/>
- CLDAS-V2.0 实时产品（中国气象数据网）：<https://k.data.cma.cn/mekb/?dataCode=NAFP_CLDAS2.0_RT&r=data/detail>
- CLDAS-V2.0 业务化试运行方案论证（CMA）：<https://www.cma.gov.cn/2011xwzx/2011xqxkj/2011xkjdt/201610/t20161026_339709.html>
- 中国气象数据网 CLDAS 检索：<https://data.cma.cn/search/uSearch.html?keywords=CLDAS>
- China Meteorological Forcing Dataset（CMFD，1979–2018）：<https://data.casearth.cn/thematic/CS/647>
- 王开存等（HCD01 与 ERA5-Land 日尺度独立检验对比表）：<https://dx.doi.org/10.1360/sste-2025-0190>
- 项目内 `README.md` 第 61–70、92–100 行；`src/lib/open-meteo.ts`、`src/lib/county-weather.ts`、`src/lib/spatial-grid.ts`、`scripts/open-meteo-request.ts`。

---

## 附：一页决策摘要

| 问题 | 回答 |
| --- | --- |
| 有更准的数据源吗？ | **有**：CLDAS-V2.0（≈0.0625°）、CMFD 2.0（0.1°）、CMA 站点/再分析最准，但需注册/授权。 |
| 免费/免注册内最优做法 | 预报显式 ECMWF IFS 0.25°；历史 ERA5-Land 0.1°；**加站点偏差订正（NOAA GSOD/ISD + Meteostat）**。 |
| 最大增益杠杆 | 站点偏差订正（对实时判季最有效）；ERA5-Land 主要提升历史回看一致性。 |
| 近期最该先做 | 先做 P0 基线测量 + P1 站点偏差订正；P2 视收益再定。 |
| 不建议做 | 在免费约束内无法直接拿 CLDAS/CMFD；单个再分析替换也解决不了「最近几天」缺口。 |
