# Elin Autoplay (elin-gm)

为 **Elin (EA 23.355)** 打造的「可编程玩家」工具集：

- `server.mjs`：一个 MCP（Model Context Protocol）服务，通过 stdio 暴露约 39 个游戏动作工具（移动、对话、采集、合成、商店、建造、农场、任务、剧情对话等），让 AI agent 不必手写 C# 就能驱动游戏。
- `fix/`：一个 BepInEx 常驻插件 **ElinGmFix**，修掉从世界地图进图时 `BaseGameScreen.RefreshWeather` 抛异常导致的空白画面/卡死。

底层依赖 [Elin Runtime MCP](https://github.com/) 模组（本地 TCP 127.0.0.1:27551-27560，JSON-lines），`elin-gm` 只是它的高层封装。

> ⚠️ 这是**单机存档自动化/研究工具**，会修改游戏状态（给予/移动/建造/时间推进等）。仅在你自己的存档上使用；部分工具（`gm_build`、`gm_cycle`）使用开发者级路径，不等价于正常游玩。

## 目录结构

```
server.mjs            MCP 服务（单文件，Node 18+，无第三方依赖）
fix/Plugin.cs         ElinGmFix 插件源码（Harmony）
fix/csc.rsp           插件编译参数（dotnet SDK 的 csc + 游戏 DLL 引用）
fix/ElinGmFix.dll     预编译插件
fix/package.xml       插件包描述（id: elin.gmfix, version: 0.23.355）
CHANGELOG.md          版本与实测记录
PLAYBOOK.md           agent 循环模板与决策表
```

## 环境要求

| 依赖 | 说明 |
|---|---|
| Elin | EA 23.355（Steam） |
| BepInEx 5 | 已装好并启用 |
| Elin Runtime MCP 模组 | `Package/Mod_ElinRuntimeMcp`，提供 eval/截图/日志/hotload 等 |
| Node.js ≥ 18 | 运行 `server.mjs` |

## 安装

### 1) 安装插件（可选，但强烈建议）

把 `fix/` 里的 `ElinGmFix.dll` 与 `package.xml` 复制到：

```
<游戏目录>/Package/Mod_ElinGmFix/
```

> `package.xml` 的 `<version>` 必须等于游戏版本（当前 `0.23.355`），否则会被当作旧版本包跳过。

源码重建（Windows，dotnet SDK 已装）：

```powershell
dotnet "C:\Program Files\dotnet\sdk\<ver>\Roslyn\bincore\csc.dll" `
  -target:library -out:fix\ElinGmFix.dll `
  -r:<游戏目录>\Elin_Data\Managed\Assembly-CSharp.dll `
  -r:<游戏目录>\BepInEx\core\BepInEx.dll `
  -r:<游戏目录>\Elin_Data\Managed\UnityEngine.dll `
  -r:<游戏目录>\Elin_Data\Managed\UnityEngine.CoreModule.dll `
  fix\Plugin.cs @fix\csc.rsp
```

### 2) 注册 MCP 服务

在 MCP 客户端（如 DSH）注册一个 stdio 服务：

```json
{
  "name": "elin-gm",
  "transport": "stdio",
  "command": "node",
  "args": ["<绝对路径>/elin-gm/server.mjs"],
  "tier": "on-demand"
}
```

服务启动后会自动扫描 27551-27560 端口，找到运行中的 Elin 实例。

## 工具概览

| 分组 | 工具 |
|---|---|
| 观测 | `gm_status` `gm_inventory` `gm_nearby` `gm_npcs` `gm_town` `gm_quests` `gm_recipes` `gm_shop` |
| 移动 | `gm_move_to` `gm_teleport` `gm_walk_map` `gm_travel` `gm_stairs` |
| 交互 | `gm_talk` `gm_talk_to` `gm_drama` `gm_take` `gm_use` `gm_container` |
| 战斗 | `gm_attack` `gm_hunt` |
| 生产 | `gm_gather` `gm_craft` `gm_build` `gm_place` `gm_cycle` `gm_supply` |
| 交易 | `gm_buy` `gm_sell` |
| 任务 | `gm_quest_start` `gm_quest_deliver` `gm_quest_advance` `gm_quest_complete` |
| 存档/救援 | `gm_save` `gm_new_game` `gm_sleep` `gm_screenshot` `gm_repair` `gm_command` |

`gm_cycle` 是殖民地经济循环：`run`（收地面掉落→补种→催熟→采摘→入出货箱）/ `settle`（推进到 05:00 结算并报告现金变化）/ `status`。

`gm_drama` 支持 `read` / `choose` / `next` / `close`，其中 `choose` 会执行剧情选项的跳转步骤，`next` 推进剧情文本（等价于点击对话）。

## 典型用法

```
gm_status                         # 我在哪、血量、状态
gm_town                           # 这个城镇的商店与居民
gm_move_to x=.. z=..              # 走到目标格
gm_talk_to name=波比              # 对话并查看任务变化
gm_drama action=read              # 读当前剧情/选项
gm_drama action=choose index=1    # 选择
gm_gather x=.. z=..               # 采集/砍树/挖矿
gm_craft recipe=workbench         # 合成（自动找 5 格内容器取料）
gm_place name=制作台 x=.. z=..    # 摆放
gm_cycle action=run               # 农场循环
gm_cycle action=settle            # 推进到结算点
```

## 已知限制（实测）

- 快速旅行需要旅粮；世界地图「走路」按格推进时间但不消耗旅粮。
- 卖出物品价格很低；容器类物品（如工具带）卖掉时**会连带卖掉里面的钱**。
- 部分剧情对话节点只有不可选选项，需要 `gm_drama action=next` 推进。
- `gm_build` 通过 `ThingGen.Create` 直接生成建筑，属于开发者路径；墙/地板/门是地图格（block），不在物品栏。
- 极端情况下角色会卡在 `HP 0 + ConSuffocation` 死锁（状态消退要求角色存活，而回血被该状态禁止），纯正常玩法无法自救。
- 从世界地图 `Player.MoveZone` 进图可能触发空白画面——这是 `ElinGmFix` 修掉的问题。

## 相关文档

- [CHANGELOG.md](CHANGELOG.md)：每个版本改了什么、实测数据。
- [PLAYBOOK.md](PLAYBOOK.md)：给 agent 的一轮循环模板、决策表、硬规则。

## 许可

未附带许可证文件。默认保留所有权利；如需开源许可（MIT/Apache-2.0 等），请提交 LICENSE 文件。
