# elin-gm 变更记录

## 0.7.0（2026-10-31，token 优化：默认精简输出）

### 新增：重型工具默认精简输出（`verbose=true` 查看原始数据）
- `gm_town`：每家店只给前 3 个商品；居民只保留商人/有委托的，其余只给数量。
- `gm_cycle action=run`：`pickedGround` / `produce` 从完整物品列表改为
  `pickedGroundCount + pickedGroundTop` / `produceCount + produceTop`（按物品名合并计数）；
  `plantErrors` 最多保留 3 条。
- `gm_inventory`：按 `id+name` 合并堆叠，默认只列 30 种（`kinds`/`omittedKinds` 提示总量）。
- `gm_nearby`：只列最近 10 个人（名字/距离/HP）+ 按名字合并的地面物品；附怪物敌意分桶。
- `gm_drama action=read`：选项按「文本+jump」去重，避免多层剧情叠加时重复输出。

### 动机
纯玩法实测中 token 大头是工具输出：`gm_town` 一次约 4–6k tokens、
`gm_cycle run` 每轮约 2–3k tokens。精简后这两类输出降到数百 token 量级。

## 0.6.0（2026-10-31，空白画面根因修复 + 大地图行走）

### 新增：ElinGmFix 常驻插件
- 位置：`G:\Steam\steamapps\common\Elin\Package\Mod_ElinGmFix\`
  - `package.xml`（id `elin.gmfix`，**version 必须写 `0.23.355`**，否则会被当作 "made for game 0.1.0" 跳过）
  - `ElinGmFix.dll`（`BaseUnityPlugin` + `[BepInPlugin("elin.gmfix.weather")]`）
- 作用：给 `BaseGameScreen.RefreshWeather` 挂 Finalizer，吞掉异常。
- 源码：`I:\DSH\elin-gm\fix\Plugin.cs`，编译脚本 `fix\csc.rsp`（dotnet SDK 的 csc + 游戏 DLL 引用）。

### 根因
从世界地图用 `Player.MoveZone` 进城镇时：
```
Scene.Init → ActionMode.Activate → BaseGameScreen.Activate
  → Scene.OnChangeHour → RefreshSky → RefreshWeather → Point.get_cell
```
`EMono.pc.pos.cell` 在此时 `Point.map` 与 `pc.pos` 不同步，越界抛 `IndexOutOfRangeException`，
`Scene.Init` 中断 → 画面停在半初始化的 EloMap → **一片空白 + 原地卡顿**。
天气只是视觉效果，吞掉异常不影响玩法；打上补丁后城镇正常渲染。

### 新增：gm_walk_map（第 39 个工具）
- `action=go zone=<id/名字>` 或 `x/z`：EloMap 上移动队伍标记（免费，不耗旅粮）。
- `action=enter`：进入标记所在区域，进入后自动归位到区域出生点并刷新视野。
- `action=where`：报告标记位置 / 是否世界地图 / elomap 是否激活。
- 每次调用前确保 `elomapActor` 激活，可顺手修复空白地图。

### 修复
- `gm_travel`：进图失败（12 秒内没切过去）**退还旅粮**，返回 `entryFailed`/`refunded`。
- `gm_travel action=region`：回世界地图时初始化 elomapActor，返回 `elomapActive`。
- `gm_repair`：新增 elomap 重建与安全回退（已有）。

### 实测（DungeonRun）
- `gm_travel go palmia`（城镇→城镇）→ `sceneInitError:null`，扣 5 袋、+108 小时、落地 (74,40)
- `gm_walk_map go mysilia` + `enter` → 进入米西利亚，出生点归位 (64,55)，`gm_move_to` 走 4 格正常
- 截图确认城镇正常渲染，报错横幅消失

### 卸载
删除 `Package\Mod_ElinGmFix\` 目录即可，不影响存档。

## 0.5.1（2026-10-30，纯净流程验证 + 站点进入重试）

### 验证结果（载入 LongRun 真实存档，未用调试）
- `gm_town` @帕罗米亚：真实货架，`rationSellers=1`（旅馆店主 奥贝夏克）。
- `gm_supply mode=buy count=10` → bought 5、spent 125、money **12428→12303**、ration **2→7**。
- `gm_travel go 崩塌的草原` → 扣 4 袋旅粮（7→3）、推进 81 小时、成功进图。
- `gm_gather` 在草原只找到树木（草原没有可采矿石）。
- `gm_travel go 迷茫的洞窟` → 扣 3 袋（3→0）、推进 60 小时，但**进图失败**（区域/站点状态未就绪），人留在世界地图。
- 失败后 `EnterLocalZone` 连续 NRE（`elomapActor.IsActive=false`，Elomap 场景未初始化），步行进城也不可用。

### 修复
- `gm_travel`：站点进入增加一次重试（4 秒未切图则重新 CloseLayers + MoveImmediate + MoveZone，总预算 12 秒）。

### 待修
- 进图失败时旅粮已扣，应该退款或延迟扣费。
- 存档直接载入到 Region 时 Elomap actor 未激活，需要显式重建区域场景，否则步行进城 NRE。
- 世界地图"步行"（EloMap 逐格移动 + EnterLocalZone）尚未做成工具。

## 0.5.0（2026-10-30，真实商店货架 + 自制旅粮链）

### 关键修复：商店库存读错容器
- 商人的货架在 `chest_merchant` 容器里，由 `Trait.OnBarter(false)` 按店型懒生成；
  之前读 `merchant.things` 只能看到随身装备（表现为"面包店卖护甲"）。
- `gm_shop` / `gm_town` / `gm_supply` 改读 chest（必要时先 OnBarter 补货）。
- `gm_buy` 从 chest 扣货；`gm_sell` 把货塞回 chest（返回 `intoChest`）。

### gm_supply 新增 mode
- `mode=buy`：找 chest 里有 `ration` 的商人，落地买满。
- `mode=craft`：完整自制链，缺什么就返回 `missing:`，缺站台返回 `no-station:`：
  workbench → millstone → factory_tinker → mixer → rationmaker → 放下 → ration（需要尸体/肉）。
- `mode=auto`：先买后造。

### 实测（新存档 SupplyTest，米西利亚）
- `gm_town`：16 家店 / 197 居民，货架显示真实食品。
- `gm_supply mode=buy count=5` → 旅馆店主 乌腊瓦尔兹：bought 2、spent 100、money 507→407、ration 0→2。
- `gm_supply mode=craft count=5` → 石磨/混合臼/旅粮制造机全部制成并放置，
  再用肉做出 **5 份旅粮**（ration 2→7）。

### 已知条件
- 自制链要求：配方已学会 + 工作台(workbench) + 杂工桌(factory_tinker) + 尸体/肉。
- 旅馆店主是稳定旅粮卖家；食物店（面包/水果/鱼/酒保）卖食品但不卖旅粮。
- 新存档的测试里，钱/材料/配方是用调试补的；购买与制造本身的交易和消耗都是真实的。

## 0.4.0（2026-10-30，旅粮补给 + 城镇居民 + 城镇建设）

### 新增：gm_town（第 34 个工具）
- 一屏返回：城镇 id/名字/是否城镇/地图尺寸、居民列表（名字/ID/坐标/距离/敌意/任务/是否商人，
  最多 40 人）、全部商人及货架前 6 件商品与价格、`rationSellers` 卖旅粮的商人数。

### 新增：gm_supply（第 35 个工具）
- 先搜本图卖 `ration` 的居民商人，落地到旁边按钱买满，返回 bought/spent/money/ration。
- 没有卖家时返回五步制造计划（millstone → mixer → rationmaker → 放置），
  并标注每一步配方是否已学会、需要什么材料。

### 新增：gm_build（第 36 个工具）
- `place`：`ThingGen.Create` + `AddCard` + `SetPlaceState(installed)`，可放墙/地板/门/工作台。
- `remove`：只销毁名字或 ID 匹配的已安装卡（不会误删同格其他物品）。
- 实测墙能阻挡移动（`gm_move_to` 只能走到墙边），移除后恢复。

### 实测发现
- 帕罗米亚 11 家商店、旅行商人营地 4 家商店，**没有一家卖旅粮**；面包店/水果店/鱼店卖的是护甲。
- 旅粮在本存档只能靠制造链（石磨→混合臼→旅粮制造机）或野外采集，营地没有岩石/黏土。
- `gm_supply` 在无卖家时给出完整备料清单，避免 agent 反复试错。

## 0.3.0（2026-10-30，对话选项 + 长跑测试）

### 新增：gm_drama（第 32 个工具）
- `action=read` 读当前对话文本 + 选项；优先读 `DialogDrama.transChoices` 的**活动子节点**（UI 真身），
  `DramaManager._choices` 只作兜底（那份数据经常是上一句残留）。
- `action=choose index=N | text=子串` 通过 `UIButton.onClick.Invoke()` 真实点击。
- `action=close` 关闭对话层。
- 同时支持 `Dialog` 层（是/否、列表选项）：文本取 `UIButton.mainText`，点击 `onClick.Invoke()`。
- `gm_talk_to` 在没有任务响应时改调 `Chara.ShowDialog()`，直接打开真实 NPC 对话，返回 `dialogOpened`。

### 新增：gm_hunt（第 33 个工具）
- Node 侧战斗循环：挑目标 → `TryMoveTowards` 走到 3 格内 → `GoalAutoCombat` 开打 → 轮询死亡。
- 目标优先级：低血（≤60）优先，其次近。
- 打不到/看不见的目标进 skip 集合；连续两次失败会 `GetRandomSurface()` 换块地。
- 运行期间关闭 `autopause`，结束恢复。

### 修复（长跑暴露）
- `gm_teleport` / `gm_hunt`：移动后 `RecalculateFOV()`，否则 `CanSee` 一直是 false。
- `gm_travel`：不在世界地图时用区域坐标补算 `dist`（`tempDist` 为 0 会让旅费算成 0）。
- `gm_travel`：旅行耗时改到**切图之后**推进；城镇落地后推进，站点等地图生成后再推进。
  原来在旧地图推进会触发 `Scene.Init → OnChangeHour → RefreshWeather` 的越界崩溃。
- `gm_travel`：城镇分支即使 `Scene.Init` 报错也继续执行落地归位和队伍同步，返回里带 `sceneInitError`。
- `gm_hunt`：60 秒/目标、卡住检测、跳图兜底。

### 已知限制
- 旅粮耗尽会把人困在当前区域（实测商人不一定卖旅粮）。
- 委托 deadline 真实生效，长途旅行可能把委托拖过期。
- 目标越界卡死时 `Teleport`/`MoveImmediate` 都会崩，只能直接 `pos.Set()` 再 `RecalculateFOV()`。

## 0.2.0（2026-10-30，试运行 + 旅行保真）

### 旅费与时间保真（gm_travel）
- `hours = tempDist * 3 * 100 / (100 + pc.Evalue(407) * 2)`
- `ration = tempDist == 0 ? 0 : 1 + hours / 24`
- 出发前：负重 `burden.GetPhase() >= 3` 拒绝 → `TryPay(ration, "ration")` →
  `player.distanceTravel = tempDist` → `player.dateTravel = now` → 切图后逐小时 `AdvanceHour()`。
- 返回 `travel: "dist=46, hours=138, ration=6"`；失败返回 `need/have`。

### 修复
- `gm_travel`：`Player.MoveZone` 后同步 `pc.currentZone`（否则同名站点会被 `z == currentZone` 提前 return）。
- `gm_travel`：城镇落地 `GetSpawnPos` + `Teleport` 归位。
- `gm_move_to` / `gm_teleport` / 站点进入：队伍同步（修复 `SyncRide → Map.MoveCard → Point.cell` 越界）。
- `gm_move_to`：起点 `IsBlocked` 自动脱困，返回 `unstuck`。
- `gm_inventory`：新增 `name` 过滤。

## 0.1.x 基础能力

- 感知：gm_status / gm_inventory / gm_nearby / gm_npcs / gm_screenshot
- 移动：gm_move_to / gm_teleport / gm_stairs / gm_travel（城镇 + 随机遗迹 + 世界地图）
- 交互：gm_talk / gm_talk_to / gm_use / gm_take / gm_attack / gm_sleep
- 生产：gm_gather / gm_recipes / gm_craft / gm_place / gm_container
- 任务：gm_quests / gm_quest_start / gm_quest_deliver / gm_quest_advance / gm_quest_complete
- 交易：gm_shop / gm_buy / gm_sell
- 剧情：gm_drama
- 流程：gm_save / gm_new_game / gm_command
