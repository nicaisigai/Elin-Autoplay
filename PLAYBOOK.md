# Elin 自主游玩 Playbook

给 agent 用的一轮循环模板。工具来自 `elin-gm` MCP（17 个），底层是 Elin Runtime MCP mod。

## 一、循环骨架

```
每一轮:
  1. 观测   gm_status + gm_nearby(20)          # 我在哪、我多强、周围有什么
  2. 评估   按下面的决策表挑一个动作
  3. 行动   一次只调一个动作工具
  4. 校验   gm_status / gm_inventory            # 结果和预期不一致就停
  5. 记录   本轮做了什么、为什么
```

**一次只做一个动作。** 连续调用会撞到异步（换层、战斗、制作都有延迟）。

## 二、决策表

| 条件 | 动作 |
|---|---|
| 地面有可拾取物，距离 ≤ 10 | `gm_move_to` 走过去（走不通再 `gm_teleport`）→ `gm_take` |
| 身上有食物且 `hunger < 20` | `gm_use <食物>` |
| 体力耗尽 / 深夜 | `gm_sleep` |
| 附近有敌对目标，且 `target.hp <= pc.hp * 0.5` | `gm_attack` |
| 附近有目标但 hp 高于自己 | **不打**，拉开距离或回营地 |
| 缺材料 | `gm_recipes` 查配方 → 按 missing 列表去捡 |
| 需要木材/矿石/植物 | `gm_gather`（最近的可采集格，或指定 x,z）→ 掉落物在地上 → `gm_take` |
| 材料不在背包、但附近有箱子 | 直接 `gm_craft`（会自动从 5 格内的容器取料）；或先 `gm_container take` 拿进包 |
| 有配方且材料齐、3 格内有工作台 | `gm_craft` |
| 有配方且材料齐、但没有工作台 | 先 `gm_craft workbench` → `gm_place 制作台` → 再 `gm_craft` |
| 手上有家具/制作台要立起来 | `gm_place <名字> [x z]` |
| 想接任务/赚钱 | `gm_quests action=available` 挑 → `gm_quest_start id=...` → `gm_quests action=active` 确认 |
| 当前层探完（无物品、无弱敌） | `gm_stairs` 换层，或 `gm_travel` 回城 |
| 以上都不满足 | `gm_save` 收尾 |

## 三、三条硬规则

1. **打之前比血量**：`target.hp > pc.hp` 就别动手。实测新手角色 HP 16 打史莱姆（95）两下就剩 1。
2. **`gm_use` 的 `ok:false` 不算失败**：满血用绷带、不饿吃饭都会这样，换一个动作即可。
3. **换层是异步的**：`gm_stairs` 返回 `moved:true` 只代表已发起，判断成功要看 `_zone.lv` 或坐标变化，别立刻接下一步。

## 四、一轮实例（AutoTest 档，2026-10-30）

```
观测  status: 康扎萨 hp16/16 (49,49) 原野 饥饿50 背包7
      nearby(20): 物品 空瓶(46,40) | 角色 菲亚玛hp1599 阿什兰德hp1443
评估  唯一可拾取物 = 空瓶，距离 10 → 捡
      NPC hp 1500 > 自己 16 → 不战斗
行动  teleport(46,40) → take → 得到 空瓶
校验  status: 背包 7 → 8 ✅
评估  再扫一圈：无可拾取物，只有高血量 NPC → 收尾
行动  teleport 回 (49,49) → save (AutoTest) ✅
```

## 五、常见失败与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `no matching item in range` | 脚下没有可捡物 | 先 `gm_nearby` 确认坐标 |
| `missing ingredients` | 材料不够 | 按 `missing` 列表去捡，或换配方 |
| `no crafter station in range` | 缺工作台 | `gm_craft workbench` → `gm_place 制作台` → 重试 |
| `not carried: X`（gm_place） | 背包里没这件东西 | 先 `gm_inventory` 确认，或先做出来 |
| `cell occupied by a character` | 目标格有人 | 换一格（`x/z`） |

## 六、已经打通的主链

```
gm_recipes 查配方
  → 材料够？不够就 gm_gather（树/草/矿）→ gm_take 捡掉落
  → 缺工作台？gm_craft workbench → gm_place 制作台
  → gm_craft <目标物>
```

实测（SandBox 档）：`工作台` 制作 → 放到 (22,11) → `细绳` 制作成功；其间还放了箱子到 (23,11)。
实测（AutoTest 档）：砍树掉落「杉木的树枝」(41,49) → 捡起；割草掉落「草」「叶子」；矿墙 `block` 分支 (20,9) 挖穿。

## 七、还没做的能力（会卡住长线目标）

- **长线任务**：接委托、跑商、下深层地牢，需要更多专用动作
- **自动拾取**：`gm_gather` 后掉落物在地上，需要手动 `gm_take`（或后续合并成一步）

## 八、容器

```
gm_container list  [x z] [name=物品过滤]     # 看箱子里有什么
gm_container put   name=<物品> [x z]         # 把背包里的东西放进箱子
gm_container take  name=<物品> [x z]         # 从箱子拿进背包
```

- 不传 x/z 时自动找 5 格内最近的容器
- `gm_craft` 也会用 5 格内容器里的材料（实测：原木放进箱子后，制作台仍然做得出来，箱子里的原木被扣掉）

## 九、任务

```
gm_quests action=active                 # 已接任务：标题、阶段、奖励、期限
gm_quests action=available [limit=30]   # 游戏里存在的任务定义（id/名称/类型/声望门槛）
gm_quests action=detail                 # 加进度文本、任务状态、委托人
gm_quest_start id=<任务id>              # 接取并开始
gm_quest_deliver id=<id> item=<物品>    # 把物品交给任务（Quest.OnGiveItem，满足即自动 CompleteTask）
gm_quest_advance id=<id>                # 强制下一阶段（剧情类任务的作弊推进）
gm_quest_complete id=<id>               # 强制完成（有坑，见下）
```

**进度文本示例（SandBox 实测）**

```
huntRace  讨伐「巫妖」族: 6 / 10只      委托人 小狗『波比』
debt      欠款: 剩余 19,900,000 奥伦    委托人 开拓监察官『罗伊特尔』
```

**讨伐类任务不用特殊工具**：用 `gm_attack` 杀掉对应种族，游戏的击杀钩子会自动加计数。
实测：生成 1 血巫妖 → `gm_attack` → 进度 6/10 → 7/10。

**坑：`gm_quest_complete` 可能部分执行。**
`Quest.Complete()` 先 `Remove` 再从任务列表移除，然后才 `ShowCompleteText` / `OnDropReward`；
剧情类任务（如 `nasu`）在这两步会 NRE，结果任务**已从列表消失但没有发奖励**。
返回 `{ok:false, stillActive:false}` 时，应当视为「任务被移除但奖励没发」。

## 十、移动

```
gm_move_to x=<x> z=<z> [steps=20]   # A* 寻路，走最多 steps 格
gm_teleport x=<x> z=<z>             # 瞬移，无视地形
```

`gm_move_to` 用游戏自己的 `Chara.TryMoveTowards`（四轮降级寻路：直线 → A* → 战斗寻路 → 放宽距离），
返回 `reached / moved / pos / trail`：

- 能到达：`{"reached":true,"moved":3,"trail":[...]}`（实测 24,9 ↔ 24,12 往返）
- 目标被挡：会走到最近可达点后停住，`reached:false` 但 `moved` 有值（实测去 23,14 时停在 23,13）
- 完全不可达（越界/墙里）：`moved:0`，`trail` 只有一条 `stepped:false`

**优先级**：正常游玩用 `gm_move_to`（会踩陷阱、会触发遭遇，符合游戏逻辑）；只有卡死或调试才用 `gm_teleport`。

**跨区域旅行**

```
gm_travel action=list [kind=town|site|all]   # 14 个城镇 + 随机遗迹，带地图坐标
gm_travel action=go zone=<id 或名字>         # 城镇 / 随机遗迹都能进
gm_travel action=region                      # 回到世界地图（Region）
```

- **城镇旅行**：`EClass.player.MoveZone(z)`（内部 `scene.Init` 直接换图）。
- **随机遗迹旅行**（已打通）：`gm_travel` 内部按游戏自己的流程走：

  ```
  CloseLayers()                     # 关掉对话层，否则切场景被 LayerDrama 挡住
  pc.MoveImmediate(zone.RegionPos)  # 把队伍标记挪到世界地图上的站点
  player.lastZonePos = null
  state = zone.RegionEnterState（Dir 则按朝向换算）
  pc.MoveZone(zone, state)          # 挂起 transition
  # 下一帧 Scene.OnUpdate 发现 pc.currentZone != activeZone 且 transition 非空
  #   → player.MoveZone(pc.currentZone) → scene.Init → Zone.Activate()
  #   → isGenerated 为假 → Generate() 现场生成地图
  ```

  工具会自动轮询到切图完成，返回里带 `after: { zone, name, lv, hasMap }`。

- 实测：`gm_travel go 受到庇护的森林` → `hasMap:true`，站内 14 个敌人正常生成；再 `go mysilia` 回城。
- **旅费与时间（已按游戏公式实现）**：

  ```
  hours = tempDist * 3 * 100 / (100 + pc.Evalue(407) * 2)
  ration = tempDist == 0 ? 0 : 1 + hours / 24
  ```

  出发前依次：`burden >= 3` 拒绝 → `pc.TryPay(ration, "ration")` 扣旅粮 → `player.distanceTravel = tempDist`
  → `player.dateTravel = now` → 逐小时 `world.date.AdvanceHour()`。

  实测（米西利亚 → 帕罗米亚）：`dist=46, hours=138, ration=6`，日期 486/6/17 14:00 → 486/6/23 8:00（+138h），旅粮 28→22。
  旅粮清零后再走：`{"moved":false,"reason":"not enough ration","need":5,"have":0}`。
- **别手动调 `zone.Generate()`**：它只置 `isGenerated=true` 不建 Map，反而让 `Zone.Activate()` 走进「(Bug) File does not exist」分支，之后这个站点就废了（要等重新生成）。让 `Activate()` 自己调 `Generate()`。

## 十一、NPC 对话

```
gm_npcs [radius=10]                 # 附近角色：名字/ID/HP/距离/敌我/商人/任务
gm_talk_to [name] [radius=6]        # 跟最近的或指定角色说话
```

`gm_talk_to` 的执行顺序：

1. `QuestManager.OnShowDialog(npc)` —— 任务管理器里挂在这个 NPC 身上的任务
2. 没反应就试 `npc.quest.UpdateOnTalk()` —— NPC 自己挂的委托（如居民的「供应委托」）
3. 还是没有任务变化，就按 NPC 心情说一句气泡（`TalkTopic` + `Talk`）

返回 `questUpdated` 和 `changed`（含 `phase`；`own:true` 表示走的是 NPC 自己的委托）。

**实测（SandBox 矿洞）**：

```
gm_npcs → 小妖精 阿艾拉夫(Ally, pcFaction, quest=supplyBulk_junk)、乌龟(Neutral)、鬼火(Neutral)
gm_talk_to 阿艾拉夫 → questUpdated:true,
  changed:[{id:"supplyBulk_junk", title:"最坏的事态", phase:1, own:true}]
```

**边界**：

- `merchant:true` 只能**识别**商人，**没有买卖动作**（开店 UI 需要另外接入）
- 没有「选项对话」（Dialog 的分支选择）——剧情分歧目前只能靠 `gm_quest_advance` 强制推进

## 十二、商店买卖

```
gm_shop [merchant=名字] [radius=8]      # 商人货架：名称/数量/ID/买价 + 自己身上的钱
gm_buy  item=<名称或ID> [count=1]       # 买：扣钱、进货
gm_sell item=<名称或ID> [count=1]       # 卖：移给商人、进钱
```

- 商人 = `trait is TraitMerchant` 的附近角色（12 格内）
- 价格走游戏自己的 `Thing.GetPrice(CurrencyType.Money, sell:...)`
- 货币是 `"money"`（`GetCurrency` / `ModCurrency`）

**实测（SandBox 矿洞，现场生成「道具店店主 娜哥诺尔多」）**：

```
gm_shop  → 钢的防护服 480 / 塑料的头盔 112，身上 12587
gm_buy 头盔            → paid 112, money 12475, 背包 +1
gm_sell 塑料的头盔      → unitPrice 20, earned 20（回收价远低于买价）
gm_buy armor_coat     → paid 480, money 12131
钱清零后 gm_buy        → {"ok":false,"reason":"not enough money","need":711,"money":0}
```

**匹配规则**：先精确 `id` 或整名相等，再退化成子串包含。
实测踩过坑：卖「头盔」时子串先命中玩家原有的「铁的头盔+1」，把不该卖的东西卖了——所以精确匹配优先。

## 十三、实战演练：跨城镇跑商

一次完整链路（2026-10-30，SandBox → 存为新档 TradeDrill）：

```
1  gm_travel action=region           → 世界地图 ntyris
2  gm_travel action=go zone=mysilia  → 米西利亚
3  gm_npcs radius=15                 → 3 个商人（万事屋/酒保/铁匠）
4  gm_shop merchant=哥梅斯           → 鳞的轻铠 270、传单 9、商人的包 0
5  gm_buy 传单                       → 9 奥伦，money 12131 → 12122
6  gm_travel action=go zone=palmia   → 帕罗米亚
7  gm_move_to x=70 z=65              → 走了 10 格（城内有路可走）
8  gm_npcs radius=12                 → 找到道具店店主（quest=huntRace）
9  gm_teleport 到柜台前 (67,53)       → 商铺内部寻路进不去，只能传送
10 gm_shop merchant=阿里科尔         → 木制胸甲 50、商人的包 0
11 gm_sell 传单                      → 回收价 5，money 12127
12 gm_talk_to 阿里科尔               → 他自己的 huntRace 委托 phase 0 → 1
13 gm_quests action=detail           → 讨伐「巫妖」7/10、欠款 19.9M 奥伦
14 gm_save name=TradeDrill           → 另存新档，SandBox 保持原样
```

**结论与坑**：

- 买 9 卖 5，**单纯倒卖是亏的**——价格由 `Thing.GetPrice` 决定，同城回收价低于买入价，跨城也不涨。想赚钱得靠任务奖励/采集制作，而不是搬货。
- **旅行落点可能在 blocked 格**：第一次 `gm_move_to` 直接 `moved:0`，查到 `pos.IsBlocked=true`。已给 `gm_move_to` 加自动脱困（`GetNearestPoint` + `Teleport`），返回里会带 `unstuck:true`。
- **商铺内部寻路不通**：店主在屋内柜台后，从街上是走不进去的（`moved:0`），这一步用 `gm_teleport` 落到柜台前是正确做法。
- **NPC 自己的委托与任务列表可能是两份实例**：`gm_talk_to` 报 `own:true` 的 phase 1 不会同步到 `gm_quests action=detail` 里的 phase 0。

## 十四、试运行记录（2026-10-30，DungeonRun 档）

一次完整的「下遗迹 → 打怪 → 拾取 → 换层 → 回城 → 卖货 → 存档」：

```
1  gm_travel go 受到庇护的森林       → 站点生成，hasMap:true
2  gm_nearby radius=12              → 22 个敌人（最弱 14 HP）、上行楼梯在脚下
3  gm_attack 螃蟹                    → 进入 GoalCombat
4  gm_nearby                        → 亡者之手从 3 只变 2 只（击杀成功）
5  gm_nearby                        → 掉落「怪异的内脏」「斗鸡的尸体」
6  gm_take 斗鸡的尸体                → 拿到（队友 auto-pick 会先捡走一部分）
7  gm_stairs down                   → 下层，坐标 (18,5)，12 个敌人
8  gm_stairs up                     → 回上层
9  gm_travel go mysilia             → 回城，pcPos 归位到出生点 (73,84)
10 gm_npcs radius=15                → 6 个商人（道具/魔法/鱼/面包/水果/魔女）
11 gm_sell 废铁 ×10                 → 单价 6，赚 60
12 gm_save name=DungeonRun          → 另存
```

**试运行暴露并修掉的三个 bug**：

1. **`pc.currentZone` 残留** → `gm_travel` 里站点进入会因 `z == currentZone` 直接 return。修：每次 `player.MoveZone` 后同步 `pc.currentZone`。
2. **掉队的队友导致位移必崩** → 小妖精留在上一个城镇（坐标 90,136），当前图只有 29×29，`Teleport` 触发 `SyncRide → Map.MoveCard → Point.cell` 越界。修：`gm_move_to` / `gm_teleport` / 站点进入后都做一次「队伍同步」。
3. **进城不归位** → 从地牢回城时玩家停在旧坐标 (22,7)，而城镇是 150×150，NPC 全在 (70,84) 附近，`gm_npcs` 返回空。修：城镇旅行后 `z.GetSpawnPos(pc)` + `Teleport`。

**其它观察**：

- 队友改造（`AllyAutoPick`、`pickeverylootonleave`）会自动捡掉落，`gm_take` 有时扑空——正常。
- `gm_npcs` 的 `radius` 上限 30，传 40 会被钳到 30。
- 尸体可以捡（`斗鸡的尸体` id `_meat`），但过一阵会腐烂消失。

## 十七、空白画面 / 卡死修复（ElinGmFix 插件）

**症状**：在世界地图上移动/进城后，画面一片空白、角色原地卡顿，左上角出现
`IndexOutOfRangeException: Index was outside the bounds of the array.` 横幅。

**根因**：

```
Player.MoveZone(town) → Scene.Init(Zone) → ActionMode.Activate
  → BaseGameScreen.Activate → Scene.OnChangeHour → RefreshSky
  → RefreshWeather → EMono.pc.pos.cell → IndexOutOfRange
```

此时 `Point.map` 与 `pc.pos` 不同步，越界中断 `Scene.Init`，EloMap 屏幕留在半初始化状态。
天气只是视觉，异常可直接吞掉。

**修复**：`G:\Steam\steamapps\common\Elin\Package\Mod_ElinGmFix\`（package.xml + ElinGmFix.dll），
对 `BaseGameScreen.RefreshWeather` 挂 Harmony Finalizer。启动日志出现
`[Elin GM Fix] ElinGmFix active: RefreshWeather exceptions are suppressed.` 即生效。
`package.xml` 的 `<version>` 必须写 `0.23.355`，否则会被 "Skipped (made for game …)"。

**配套工具**：

- `gm_repair`：清 transition/UI 层、关自动暂停、重建 elomap、必要时回退到主城
- `gm_walk_map`：`go zone=...` 免费移动世界地图标记；`enter` 进城并自动归位出生点
- `gm_travel`：进图失败会退旅粮（`entryFailed` + `refunded`）

**卸载**：删掉 `Package\Mod_ElinGmFix\` 目录。

## 十六、旅粮补给 / 城镇居民 / 城镇建设

**商店库存的真相**：商人的货架不在 `merchant.things`，而在 `merchant.things.Find("chest_merchant")` 这个容器里，
并且由 `Trait.OnBarter(false)` 按店型 + `RestockDay` 懒生成。直接读 `things` 只能看到商人的随身装备（所以之前
看起来"面包店卖护甲"）。gm_shop / gm_buy / gm_sell / gm_town / gm_supply 现在都读写 chest：买=从 chest 扣，
卖=塞回 chest。

**gm_town**：城镇 id/名字/尺寸、居民（最多 40 人，坐标/敌意/任务/是否商人）、
所有商店的真实货架（前 6 件 + 价格）、`rationSellers` 计数。

**gm_supply**（`count` + `mode=auto|buy|craft`）：

- `buy`：找 chest 里有 `ration` 的居民商人 → 落到旁边 → 按钱买满。
- `craft`：完整自制链（配方向已学会为前提）：

```
gm_build name=workbench          # 石磨需要工作台
gm_craft recipe=millstone        # 岩石/细绳/树枝
gm_build name=factory_tinker     # 混合臼需要杂工桌
gm_craft recipe=mixer            # 岩石/树脂/粘土
gm_craft recipe=rationmaker      # 石料/石磨/混合臼
gm_build name=rationmaker        # 放下制造机
gm_craft recipe=ration           # 尸体/肉 → 旅粮
```

**实测（新存档 SupplyTest，米西利亚）**：

```
gm_town                              → 16 家店、197 居民，旅馆店主卖食品
gm_supply mode=buy count=5           → 旅馆店主 乌腊瓦尔兹，bought 2，spent 100，money 507→407，ration 0→2
gm_supply mode=craft count=10         → millstone ok / mixer ok / rationmaker ok / machinePlaced true
                                        ration 缺“尸体”，市集杀鸡难，改用肉
gm_supply mode=craft count=5          → millstone/mixer/rationmaker 全 ok，ration 5 份 ok，ration 2→7
```

**结论**：

- 旅馆店主（merchant_inn）是稳定的旅粮卖家；你之前"食品库存被卖光"说的没错——是工具读错了容器。
- 自制链真正卡的是三样：**配方是否学会**、**工作台/杂工桌**、**尸体或肉**。三者齐了就能量产。
- 制造机放下后不必当站台用，`ration` 配方本身不需要工作台。

**gm_build**：`place name=<id>`（东侧或 x/z）、`remove name=<id>`；墙实测能挡路，remove 只删匹配项。

## 十五、长跑测试（2026-10-30，LongRun 档）

目标：接受「定期巡逻」委托（讨伐 16 只），下遗迹连续清怪，再回城。实际轨迹：

```
gm_drama read                      → 从 NPC 对话里读到「同意 / 拒绝」
gm_drama choose index=0            → 接受委托，deadline 20 天
gm_travel go 受到庇护的森林         → dist=0（在城内时 tempDist 不可用，已修）
gm_hunt count=3 radius=8           → 0 杀（自动暂停 + 视线问题，见下）
（修好 autopause / FOV / GoalAutoCombat）
gm_hunt count=3 radius=12          → 3 杀
gm_hunt count=3 radius=12          → 2 杀
gm_stairs down + gm_hunt           → 下层 3/3 全杀，再来一轮 5/5 全杀
gm_quests detail                   → 委托已从列表消失：旅行推进了几百小时，deadline 过期
gm_travel go palmia/kapul          → 旅粮不足 / 场景初始化崩溃（已修）
gm_save name=LongRun               → 长跑落盘
```

**长跑揪出的五个关键问题（全部已修）**：

1. **自动暂停会冻结 AI**：`autopause` 开启时，玩家 `HasNoGoal` → `Scene.paused=true`，AI 完全不跑。
   `gm_hunt` 现在开场关掉、结束恢复。
2. **传送后 FOV 不刷新**：`gm_teleport` 后 `CanSee` 仍是 false，所有敌人被判定「不可见」而放弃。
   现在 `gm_teleport` / `gm_hunt` 每次移动后都 `RecalculateFOV()`。
3. **PC 战斗必须用 `GoalAutoCombat(enemy)`**：通用 `GoalCombat` 在 `CanSee` 失败时直接 `Success()` → `NoGoal`，看起来像「AI 不响应」。
4. **视线半径只有 4**：暗处只能看见 4 格，远一点的目标根本进不了战斗；`gm_hunt` 因此改成「先走到 3 格内再打」。
5. **旅行推进时间不能在切图前做**：在遗迹里 `AdvanceHour` 后切场景，`Scene.Init → OnChangeHour → RefreshWeather` 用失效坐标越界崩溃。
   现在城镇在落地后推进、站点在切图完成后推进。

**另外两条硬约束**：

- **旅粮能把人困死**：旅粮耗尽后无法离开当前区域，商人也不一定卖旅粮（实测只找到铁匠/道具店）。长跑到最后就是这样结束的。
- **委托 deadline 是真的**：长途旅行累计几百小时后，「定期巡逻」在 5/16 阶段直接过期消失。

**越界卡死的恢复手法**（`Teleport` / `MoveImmediate` 都会在 `Card.PlayEffect → Point.Position` 崩）：

```csharp
var sp = EClass._zone.GetSpawnPos(EClass.pc);
EClass.pc.pos.Set(sp.x, sp.z);   // 直接写坐标，绕开地图搬运
EClass.pc.RecalculateFOV();
```
