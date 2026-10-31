#!/usr/bin/env node
// elin-gm: a tiny gameplay-oriented MCP server for Elin.
// Talks to the "Elin Runtime MCP" mod (127.0.0.1:27551-27560, one JSON per line)
// and exposes high-level tools so the agent does not have to hand-write C#.
import net from 'node:net';
import fs from 'node:fs';

const HOST = '127.0.0.1';
const PORT_START = 27551;
const PORT_COUNT = 10;
const SERVER = { name: 'elin-gm', version: '0.1.0' };

let nextId = 1;

function request(port, op, args = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const socket = net.connect({ host: HOST, port });
    let buf = '';
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`timeout ${timeoutMs}ms on ${op} @${port}`))), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ id, op, args }) + '\n'));
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      let reply;
      try { reply = JSON.parse(line); } catch { finish(() => reject(new Error('bad reply: ' + line.slice(0, 200)))); return; }
      finish(() => reply.ok ? resolve(reply.result) : reject(new Error(reply.error || 'in-game error')));
    });
    socket.on('error', (e) => finish(() => reject(e)));
    socket.on('close', () => finish(() => reject(new Error('closed before reply'))));
  });
}

async function findPort() {
  for (let i = 0; i < PORT_COUNT; i++) {
    const port = PORT_START + i;
    try { const hello = await request(port, 'hello', {}, 1500); return { port, hello }; } catch { /* next */ }
  }
  throw new Error('no Elin instance listening on 27551-27560. Start the game (elin_launch) and make sure the Runtime MCP mod is enabled.');
}

async function withGame(fn) {
  const { port, hello } = await findPort();
  if (!hello.gameStarted) throw new Error(`Elin is at the ${hello.sceneMode || 'title'} screen; load a save first.`);
  if (hello.scripting === false) throw new Error('scripting is disabled in this instance.');
  return fn(port);
}

const ev = (port, code, timeout = 60000) => request(port, 'eval', { code }, timeout);

// JSON-escape a piece of text into a C# string literal.
const cs = (text) => JSON.stringify(String(text ?? ''));

// ---- output compaction (keeps the model-facing payload small) ----
const tryParse = (text) => { try { return JSON.parse(text); } catch { return null; } };

function countByName(list, max = 8) {
  const map = new Map();
  for (const raw of list || []) {
    const s = String(raw);
    const m = s.match(/^(.*?) x(\d+)(\[ship\])?$/);
    let name = (m ? m[1] : s).replace(/\[ship\]$/, '');
    // strip leading quantity words like "3个番茄" -> "番茄"
    name = name.replace(/^\d+\s*[个颗块把份袋瓶卷张串堆盘碗杯根片枚套顶座口只条株支管桶箱包盒罐缸枝花朵束粒册]/, '').trim();
    const num = m ? Number(m[2]) || 1 : 1;
    map.set(name, (map.get(name) || 0) + num);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, num]) => (num > 1 ? name + ' x' + num : name));
}

function compactInventory(obj, verbose) {
  if (!obj || !Array.isArray(obj.items)) return obj;
  const agg = new Map();
  for (const it of obj.items) {
    const key = (it.id || '') + '|' + (it.name || '');
    const cur = agg.get(key) || { id: it.id, name: it.name, num: 0, stacks: 0 };
    cur.num += Number(it.num) || 0;
    cur.stacks += 1;
    agg.set(key, cur);
  }
  const rows = [...agg.values()];
  const out = { count: obj.count, matched: obj.matched, kinds: rows.length };
  if (verbose) { out.items = rows; return out; }
  out.items = rows.slice(0, 30);
  if (rows.length > 30) out.omittedKinds = rows.length - 30;
  return out;
}

function compactNearby(obj) {
  if (!obj) return obj;
  const chars = Array.isArray(obj.chars) ? obj.chars : [];
  const things = Array.isArray(obj.things) ? obj.things : [];
  const host = {};
  for (const c of chars) { const k = c.hostility || '?'; host[k] = (host[k] || 0) + 1; }
  const names = new Map();
  for (const t of things) names.set(t.name, (names.get(t.name) || 0) + 1);
  return {
    radius: obj.radius,
    charCount: chars.length,
    charsByHostility: host,
    chars: chars.slice(0, 10).map((c) => ({ name: c.name, dist: Math.round(c.dist), hp: c.hp })),
    thingCount: things.length,
    ground: [...names.entries()].slice(0, 10).map(([name, n]) => (n > 1 ? name + ' x' + n : name)),
  };
}

function compactTown(obj) {
  if (!obj) return obj;
  const shops = (obj.shops || []).map((s) => ({
    name: s.name,
    id: s.id,
    dist: Math.round(s.dist),
    ration: s.ration,
    goods: (s.goods || []).slice(0, 3).map((g) => g.name + ' @' + g.price),
  }));
  const res = obj.residents || [];
  const interesting = res.filter((r) => r.merchant || r.quest).slice(0, 10)
    .map((r) => ({ name: r.name, id: r.id, dist: Math.round(r.dist), quest: r.quest || undefined }));
  return {
    zone: obj.zone,
    zoneName: obj.zoneName,
    isTown: obj.isTown,
    mapSize: obj.mapSize,
    residentCount: obj.residentCount,
    shopCount: obj.shopCount,
    rationSellers: obj.rationSellers,
    shops,
    notableResidents: interesting,
    otherResidents: Math.max(0, (obj.residentCount || 0) - interesting.length),
  };
}

function compactCycle(obj) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const key of ['pickedGround', 'produce']) {
    if (Array.isArray(out[key])) {
      out[key + 'Count'] = out[key].length;
      out[key + 'Top'] = countByName(out[key], 8);
      delete out[key];
    }
  }
  if (Array.isArray(out.plantErrors)) out.plantErrors = out.plantErrors.slice(0, 3);
  return out;
}

const TOOLS = [
  {
    name: 'gm_status',
    description: 'Snapshot of the player character: name, hp/maxHp, level, position, zone, hunger, held item, active conditions, inventory size, nearby character count. Start here.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gm_inventory',
    description: 'List what the player is carrying (compact by default: stacked/aggregated, top 30 kinds). Pass name to filter (exact id/name first, then substring). verbose=true returns every stack.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        name: { type: 'string' },
        verbose: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'gm_nearby',
    description: 'Characters and ground items within radius (compact by default: top 10 chars, ground items grouped by name). verbose=true returns full arrays.',
    inputSchema: {
      type: 'object',
      properties: {
        radius: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
        verbose: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'gm_talk',
    description: 'Make the player character say something as a speech bubble.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'] },
  },
  {
    name: 'gm_teleport',
    description: 'Teleport the player to a map cell. Use gm_status/gm_nearby to find coordinates.',
    inputSchema: { type: 'object', properties: { x: { type: 'integer' }, z: { type: 'integer' } }, required: ['x', 'z'] },
  },
  {
    name: 'gm_command',
    description: 'Run an in-game ReflexCLI console command (e.g. "mod.pos", "mod.elin_dev true").',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string', minLength: 1 } }, required: ['cmd'] },
  },
  {
    name: 'gm_screenshot',
    description: 'Capture the game window and return it as an image.',
    inputSchema: { type: 'object', properties: { scale: { type: 'number', minimum: 0.1, maximum: 1, default: 0.5 } } },
  },
  {
    name: 'gm_save',
    description: 'Save the current game. Pass name to save under a new slot id (changes Game.id), omit it to overwrite the current slot.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } } },
  },
  {
    name: 'gm_new_game',
    description: 'Start a brand-new game via the debug quick-start. Must be called from the title screen (kill and relaunch Elin first if a game is loaded). Optionally names the save slot.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } } },
  },
  {
    name: 'gm_take',
    description: 'Pick up an item from the ground: nearest within radius, or the exact cell when x/z are given. Optional name filter (substring or id).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'integer' },
        z: { type: 'integer' },
        radius: { type: 'integer', minimum: 0, maximum: 10, default: 1 },
      },
    },
  },
  {
    name: 'gm_use',
    description: 'Use/consume/equip an item carried by the player, matched by name substring or id.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
  },
  {
    name: 'gm_stairs',
    description: 'Use a staircase on the current map (default: downstairs) to change zone level.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'], default: 'down' } } },
  },
  {
    name: 'gm_attack',
    description: 'Order the player to attack a character, picked by name substring or the nearest non-party character. Sets the combat AI goal.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, radius: { type: 'integer', minimum: 1, maximum: 30, default: 12 } } },
  },
  {
    name: 'gm_hunt',
    description: 'Auto-hunt hostiles: repeatedly picks the nearest enemy within radius, attacks it and waits for the kill, up to count kills or a time budget. Returns the kill log.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
        radius: { type: 'integer', minimum: 1, maximum: 30, default: 15 },
        timeoutSec: { type: 'integer', minimum: 5, maximum: 600, default: 180 },
      },
    },
  },
  {
    name: 'gm_sleep',
    description: 'Make the player lie down and sleep (skips time until waking).',
    inputSchema: { type: 'object', properties: {} },
  },  {
    name: 'gm_travel',
    description: 'World map travel. action=list returns towns and sites in the region (id, name, level, map position); action=go moves the player to the zone given by id or name. Also accepts a bare zone id for backwards compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'go', 'region'], default: 'go' },
        zone: { type: 'string' },
        kind: { type: 'string', enum: ['town', 'site', 'all'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 40 },
      },
    },
  },
  {
    name: 'gm_recipes',
    description: 'List recipes the player currently knows (id + name). Read-only helper for crafting decisions.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 300, default: 60 } } },
  },
  {
    name: 'gm_craft',
    description: 'Craft one item by recipe id (or name substring) from a known recipe: checks ingredients in the player inventory and, when the recipe needs one, a crafter station within 3 cells. Consumes ingredients and returns the produced item.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: { type: 'string', minLength: 1 },
        times: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
      },
      required: ['recipe'],
    },
  },
  {
    name: 'gm_place',
    description: 'Place a carried item (furniture, workbench, container…) onto the map as an installed card. Defaults to the cell the player stands on; pass x/z for a specific cell.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        x: { type: 'integer' },
        z: { type: 'integer' },
      },
      required: ['name'],
    },
  },
  {
    name: 'gm_gather',
    description: 'Gather from the nearest harvestable cell: mine a wall/ore block, or cut/chop an object such as a tree or plant. Pass x/z to target a specific cell. Radius defaults to 1.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        z: { type: 'integer' },
        radius: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
      },
    },
  },
  {
    name: 'gm_container',
    description: 'Inspect or move items in a nearby container (chest, box, fridge…). action=list shows contents; take moves matching items into the player inventory; put moves matching carried items into the container. Containers are searched within 5 cells unless x/z are given.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'take', 'put'], default: 'list' },
        name: { type: 'string' },
        container: { type: 'string' },
        x: { type: 'integer' },
        z: { type: 'integer' },
      },
      required: ['action'],
    },
  },
  {
    name: 'gm_quests',
    description: 'Quest helper: action=active lists accepted quests with title/phase/reward/deadline; action=available lists quest definitions that exist in the game (id, name, type, minFame) so you can start one; action=detail adds progress text, task state and client name per active quest.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['active', 'available', 'detail'], default: 'active' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
      },
    },
  },
  {
    name: 'gm_quest_start',
    description: 'Accept and start a quest by definition id (see gm_quests action=available).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'] },
  },
  {
    name: 'gm_quest_deliver',
    description: 'Hand a carried item to the active quest task that wants it (calls Quest.OnGiveItem, which auto-completes the task when satisfied).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, item: { type: 'string', minLength: 1 } },
      required: ['id', 'item'],
    },
  },
  {
    name: 'gm_quest_advance',
    description: 'Force an active quest to its next phase (ChangePhase). Cheat for story/phase-driven quests that would normally need dialogue.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'] },
  },
  {
    name: 'gm_quest_complete',
    description: 'Force-complete an active quest (Quest.Complete), granting rewards if the game allows it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'] },
  },
  {
    name: 'gm_move_to',
    description: 'Walk the player toward a target cell using the game\'s own A* pathfinding (Chara.TryMoveTowards). Moves up to `steps` tiles in one call (default 20) and returns the trail plus whether the target was reached.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        z: { type: 'integer' },
        steps: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['x', 'z'],
    },
  },
  {
    name: 'gm_cycle',
    description: 'Colony economic cycle. action=status reports farm/shipping state; action=run replants empty farm cells from carried seed stacks, grows crops, harvests mature plants (PopHarvest) and moves sellable produce into the registered shipping chest (compact result: counts + top item groups; verbose=true returns every pickup); action=settle advances time to the next 05:00 and reports the cash gain.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'run', 'settle'], default: 'run' },
        verbose: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'gm_npcs',
    description: 'List nearby characters with practical flags: distance, hp, faction/hostility, merchant and quest-client markers.',
    inputSchema: { type: 'object', properties: { radius: { type: 'integer', minimum: 1, maximum: 30, default: 10 } } },
  },
  {
    name: 'gm_talk_to',
    description: 'Talk to a nearby character by name (or the nearest one): runs the quest-dialogue hook (QuestManager.OnShowDialog) and reports which quests changed phase; if no quest reacts, shows a mood-based speech bubble.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, radius: { type: 'integer', minimum: 1, maximum: 20, default: 6 } },
    },
  },
  {
    name: 'gm_shop',
    description: 'Show the goods of the nearest merchant (trait TraitMerchant) within the radius: item name, stack, id, buy price, plus how much money the player carries.',
    inputSchema: { type: 'object', properties: { merchant: { type: 'string' }, radius: { type: 'integer', minimum: 1, maximum: 20, default: 8 } } },
  },
  {
    name: 'gm_buy',
    description: 'Buy items from the nearest merchant: pays with the player\'s "money" currency and moves the goods into the inventory.',
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 999, default: 1 }, merchant: { type: 'string' } },
      required: ['item'],
    },
  },
  {
    name: 'gm_sell',
    description: 'Sell carried items to the nearest merchant: moves them into the merchant inventory and credits "money".',
    inputSchema: {
      type: 'object',
      properties: { item: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 999, default: 1 }, merchant: { type: 'string' } },
      required: ['item'],
    },
  },
  {
    name: 'gm_build',
    description: 'Town construction: place a structural thing (wall, floor, door, workbench…) on a map cell, or remove an installed thing there. Defaults to the cell east of the player. Use gm_town first to see where you are.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['place', 'remove'], default: 'place' },
        name: { type: 'string' },
        x: { type: 'integer' },
        z: { type: 'integer' },
      },
    },
  },
  {
    name: 'gm_supply',
    description: 'Resupply rations: finds the nearest resident merchant on this map who stocks 旅粮 (ration), walks/lands next to them, and buys up to count. Returns purchases and the remaining ration/money.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        mode: { type: 'string', enum: ['auto', 'buy', 'craft'], default: 'auto' },
      },
    },
  },
  {
    name: 'gm_town',
    description: 'Town overview (compact by default: every shop with top-3 goods, notable merchants/quest clients only). Use it before shopping or building. verbose=true returns the raw resident/shop dump.',
    inputSchema: {
      type: 'object',
      properties: { verbose: { type: 'boolean', default: false } },
    },
  },
  {
    name: 'gm_walk_map',
    description: 'World-map walking (no ration cost): action=go moves the party marker to a zone (by id/name) or to x/z cells; action=enter enters the zone under the marker; action=where reports the marker state. Initializes the EloMap actor first, so it also repairs a blank world-map scene.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['go', 'enter', 'where'], default: 'go' },
        zone: { type: 'string' },
        x: { type: 'integer' },
        z: { type: 'integer' },
      },
    },
  },
  {
    name: 'gm_repair',
    description: 'Recover from a blank/stuck scene: clears transitions and UI layers, turns off autopause, re-initializes the world-map actor when on the region, and falls back to the home zone if the active map is broken. Use it when the screen goes blank after a failed world-map move.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gm_drama',
    description: 'Read or drive the active story dialogue. action=read returns the current line and numbered choices; action=choose picks a choice by index (or by text substring), running its click handler or jumping to its drama step; action=next advances the current drama line (DramaSequence.PlayNext); action=close dismisses the dialogue layer.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'choose', 'next', 'close'], default: 'read' },
        index: { type: 'integer', minimum: 0 },
        text: { type: 'string' },
      },
    },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'gm_status': {
      const code = `
var p = EClass.pc;
var o = new Dictionary<string, object>();
o["name"] = p.Name;
o["hp"] = p.hp;
o["maxHp"] = p.MaxHP;
o["lv"] = p.LV;
o["pos"] = new Dictionary<string, object> { { "x", p.pos.x }, { "z", p.pos.z } };
o["zone"] = EClass._zone == null ? null : EClass._zone.Name;
o["hunger"] = p.hunger.value;
o["held"] = p.held == null ? null : p.held.Name;
o["conditions"] = p.conditions.Where(c => c != null).Select(c => c.Name).ToList();
o["inventoryCount"] = p.things.Count;
o["nearbyChars"] = EClass._map.charas.Where(c => c != null && c != p && c.pos.Distance(p.pos) <= 8).Count();
o["dead"] = p.isDead;
return JsonConvert.SerializeObject(o);`;
      return { text: await withGame((port) => ev(port, code)) };
    }
    case 'gm_inventory': {
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const filter = args.name ? cs(args.name) : 'null';
      const verbose = !!args.verbose;
      const code = `
var p = EClass.pc;
string want = ${filter};
var pool = p.things.Where(t => t != null).ToList();
if (!string.IsNullOrEmpty(want)) {
  var exact = pool.Where(t => t.id == want || (t.Name ?? "") == want).ToList();
  pool = exact.Count > 0 ? exact : pool.Where(t => (t.Name ?? "").Contains(want) || t.id.Contains(want)).ToList();
}
var items = pool.Take(Math.Max(${limit}, 200)).Select(t => new Dictionary<string, object> { { "name", t.Name }, { "num", t.Num }, { "id", t.id } }).ToList();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "count", p.things.Count }, { "matched", pool.Count }, { "items", items } });`;
      const raw = await withGame((port) => ev(port, code));
      if (verbose) return { text: raw };
      const parsed = tryParse(raw);
      if (!parsed) return { text: raw };
      const out = compactInventory(parsed, false);
      out.items = (out.items || []).slice(0, limit);
      return { text: JSON.stringify(out) };
    }
    case 'gm_nearby': {
      const r = Math.max(1, Math.min(30, Number(args.radius) || 8));
      const verbose = !!args.verbose;
      const code = `
var p = EClass.pc;
var chars = EClass._map.charas.Where(c => c != null && c != p && c.pos.Distance(p.pos) <= ${r})
  .OrderBy(c => c.pos.Distance(p.pos))
  .Select(c => new Dictionary<string, object> { { "name", c.Name }, { "x", c.pos.x }, { "z", c.pos.z }, { "dist", c.pos.Distance(p.pos) }, { "hp", c.hp }, { "hostility", c.hostility.ToString() } })
  .Take(40).ToList();
var things = EClass._map.things.Where(t => t != null && t.pos != null && t.pos.Distance(p.pos) <= ${r})
  .Select(t => new Dictionary<string, object> { { "name", t.Name }, { "num", t.Num }, { "x", t.pos.x }, { "z", t.pos.z } })
  .Take(40).ToList();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "radius", ${r} }, { "chars", chars }, { "things", things } });`;
      const raw = await withGame((port) => ev(port, code));
      if (verbose) return { text: raw };
      const parsed = tryParse(raw);
      if (!parsed) return { text: raw };
      return { text: JSON.stringify(compactNearby(parsed)) };
    }
    case 'gm_talk': {
      const text = String(args.text || '');
      if (!text) throw new Error('text is required');
      const code = `EClass.pc.TalkRaw(${cs(text)}); return "ok";`;
      return { text: await withGame((port) => ev(port, code)) };
    }
    case 'gm_teleport': {
      const x = Number(args.x), z = Number(args.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('x and z must be numbers');
      const code = `
var p = EClass.pc;
var __follows = new List<Chara>(); if (p.parasite != null) __follows.Add(p.parasite); if (p.ride != null) __follows.Add(p.ride); foreach (var __m in p.party.members) { if (__m != null && !__m.IsPC) __follows.Add(__m); } foreach (var __f in __follows) { if (__f.currentZone != EClass._zone || !__f.pos.IsInBounds) { try { EClass._zone.AddCard(__f, p.pos.Copy()); __f.currentZone = EClass._zone; } catch (Exception ex) { } } }
p.Teleport(new Point(${Math.trunc(x)}, ${Math.trunc(z)}), false, true);
p.RecalculateFOV();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "x", p.pos.x }, { "z", p.pos.z } });`;
      return { text: await withGame((port) => ev(port, code)) };
    }
    case 'gm_command': {
      const cmd = String(args.cmd || '').trim();
      if (!cmd) throw new Error('cmd is required');
      const { port, hello } = await findPort();
      if (!hello.gameStarted) throw new Error('Elin is not in a loaded game.');
      const out = await request(port, 'command', { cmd }, 60000);
      return { text: typeof out === 'string' ? out : JSON.stringify(out) };
    }
    case 'gm_screenshot': {
      const scale = Math.max(0.1, Math.min(1, Number(args.scale) || 0.5));
      const { port } = await findPort();
      const result = await request(port, 'screenshot', { scale }, 30000);
      // The mod replies with { png: <base64>, width, height }.
      let data = typeof result === 'string' ? null : (result && result.png);
      let note = '';
      if (!data && typeof result === 'string' && fs.existsSync(result)) {
        data = fs.readFileSync(result).toString('base64');
        note = result;
      }
      if (!data) return { text: 'screenshot reply had no image data: ' + JSON.stringify(result).slice(0, 300) };
      const size = result && result.width ? `${result.width}x${result.height}` : '';
      return {
        content: [
          { type: 'text', text: `screenshot ${size}${note ? ' ' + note : ''}`.trim() },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      };
    }
    case 'gm_save': {
      const name = args.name ? `Game.id = ${cs(args.name)};` : '';
      const code = `${name}
var ok = EClass.game.Save(false, false);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "saved", ok }, { "id", Game.id } });`;
      return { text: await withGame((port) => ev(port, code, 120000)) };
    }
    case 'gm_new_game': {
      const { port, hello } = await findPort();
      if (hello.gameStarted) throw new Error('a game is already loaded; kill and relaunch Elin (elin_kill + elin_launch), then call gm_new_game at the title screen');
      await ev(port, 'EClass.debug.QuickStart(); return "ok";', 60000);
      const deadline = Date.now() + 120000;
      let started = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const v = await ev(port, 'return EClass.core.IsGameStarted;', 5000);
          if (v === true) { started = true; break; }
        } catch { /* still loading */ }
      }
      if (!started) throw new Error('new game did not reach the loaded state');
      if (args.name) await ev(port, `Game.id = ${cs(args.name)}; EClass.game.Save(false, false); return Game.id;`, 120000);
      const code = `
var p = EClass.pc;
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "id", Game.id }, { "name", p.Name }, { "zone", EClass._zone == null ? null : EClass._zone.Name }, { "x", p.pos.x }, { "z", p.pos.z } });`;
      return { text: await ev(port, code, 15000) };
    }
    case 'gm_take': {
      const want = args.name ? cs(args.name) : 'null';
      const hasCell = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.z));
      const cx = hasCell ? Math.trunc(Number(args.x)) : 0;
      const cz = hasCell ? Math.trunc(Number(args.z)) : 0;
      const r = Math.max(0, Math.min(10, Number(args.radius) || 1));
      const code = `
var p = EClass.pc;
string want = ${want};
bool hasCell = ${hasCell ? 'true' : 'false'};
int cx = ${cx}, cz = ${cz}, r = ${r};
var pool = EClass._map.things.Where(t => t != null && t.pos != null);
if (hasCell) pool = pool.Where(t => t.pos.x == cx && t.pos.z == cz);
else pool = pool.Where(t => p.pos.Distance(t.pos) <= r);
if (!string.IsNullOrEmpty(want)) pool = pool.Where(t => (t.Name ?? "").Contains(want) || t.id == want);
var found = pool.OrderBy(t => p.pos.Distance(t.pos)).FirstOrDefault();
if (found == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "taken", null }, { "reason", "no matching item in range" } });
var got = p.Pick(found, true, true);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "taken", got != null ? got.Name : null }, { "id", got != null ? got.id : null } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_use': {
      const want = cs(args.name || '');
      const code = `
var p = EClass.pc;
string want = ${want};
var t = p.things.FirstOrDefault(x => x != null && ((x.Name ?? "").Contains(want) || x.id == want));
if (t == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "used", null }, { "reason", "not carried" } });
var ok = p.TryUse(t);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "used", t.Name }, { "ok", ok }, { "remaining", p.things.Count } });`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_stairs': {
      const up = String(args.direction || 'down').toLowerCase() === 'up';
      const code = `
var p = EClass.pc;
bool up = ${up ? 'true' : 'false'};
var map = EClass._map;
var all = map.things.Where(t => t != null && t.trait is TraitNewZone).ToList();
Func<Thing, bool> dirOk = (t) => { var nz = t.trait as TraitNewZone; return up ? nz.IsUpstairs : nz.IsDownstairs; };
var stair = all.FirstOrDefault(dirOk);
if (stair == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", false }, { "reason", "no stairs in that direction" }, { "found", all.Select(t => t.Name).ToList() } });
var nz2 = stair.trait as TraitNewZone;
var ok = nz2.MoveZone(true);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", ok }, { "stairs", stair.Name }, { "zone", EClass._zone == null ? null : EClass._zone.Name } });`;
      return { text: await withGame((port) => ev(port, code, 120000)) };
    }
    case 'gm_attack': {
      const want = args.name ? cs(args.name) : 'null';
      const r = Math.max(1, Math.min(30, Number(args.radius) || 12));
      const code = `
var p = EClass.pc;
string want = ${want};
int r = ${r};
var others = EClass._map.charas.Where(c => c != null && c != p && !p.party.members.Contains(c) && c.pos.Distance(p.pos) <= r);
Chara target = null;
if (!string.IsNullOrEmpty(want)) target = others.Where(c => (c.Name ?? "").Contains(want) || c.id == want).OrderBy(c => c.pos.Distance(p.pos)).FirstOrDefault();
else target = others.OrderBy(c => c.pos.Distance(p.pos)).FirstOrDefault();
if (target == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "attacking", null }, { "reason", "no target in range" } });
p.SetEnemy(target);
p.SetAI(new GoalCombat());
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "attacking", target.Name }, { "id", target.id }, { "dist", target.pos.Distance(p.pos) }, { "hp", target.hp }, { "ai", p.ai == null ? null : p.ai.GetType().Name } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_hunt': {
      const count = Math.max(1, Math.min(50, Number(args.count) || 5));
      const radius = Math.max(1, Math.min(30, Number(args.radius) || 15));
      const budgetMs = Math.max(5000, Math.min(600000, (Number(args.timeoutSec) || 180) * 1000));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const kills = [];
      const failed = [];
      const deadline = Date.now() + budgetMs;
      let autopauseBefore = true;
      try {
        autopauseBefore = JSON.parse(await withGame((port) => ev(port, 'var c = EClass.core.config.game.autopause; EClass.core.config.game.autopause = false; return JsonConvert.SerializeObject(new Dictionary<string, object> { { "was", c } });', 15000))).was;
      } catch (e) { /* keep going */ }
      const pickCode = `
var p = EClass.pc;
p.RecalculateFOV();
var skip = new HashSet<int>(new int[] { __SKIP__ });
var t = EClass._map.charas.Where(c => c != null && c != p && !c.IsPCFaction && !p.party.members.Contains(c) && c.hostility == Hostility.Enemy && !c.isDead && !skip.Contains(c.uid) && c.pos.Distance(p.pos) <= ${radius})
  .OrderBy(c => c.hp <= 60 ? 0 : 1).ThenBy(c => c.pos.Distance(p.pos)).FirstOrDefault();
if (t == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "none", true } });
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "uid", t.uid }, { "name", t.Name }, { "hp", t.hp }, { "dist", t.pos.Distance(p.pos) } });`;
      const skip = new Set();
      let hops = 0;
      let misses = 0;
      while (kills.length < count && Date.now() < deadline) {
        let pick = null;
        try {
          const skipList = Array.from(skip).join(',') || '0';
          pick = JSON.parse(await withGame((port) => ev(port, pickCode.replace('__SKIP__', skipList), 30000)));
        } catch (e) {
          failed.push({ reason: 'pick failed: ' + e.message });
          break;
        }
        if (!pick || pick.none) break;
        /* approach: walk with TryMoveTowards until the enemy is in sight */
        let ready = false;
        let pr = null;
        let fails = 0;
        for (let step = 0; step < 40 && Date.now() < deadline; step++) {
          const walkCode = `
var p = EClass.pc;
p.RecalculateFOV();
var t = EClass._map.charas.FirstOrDefault(c => c != null && c.uid == ${pick.uid});
if (t == null || t.isDead) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "gone", true } });
var res = p.TryMoveTowards(t.pos);
p.RecalculateFOV();
if (res.ToString() == "Fail") { var alt = p.pos.GetNearestPoint(allowBlock: false, allowChara: false); if (alt != null && !alt.Equals(p.pos)) p.Teleport(alt, true, true); }
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "move", res.ToString() }, { "dist", t.pos.Distance(p.pos) }, { "canSee", p.CanSee(t) }, { "alive", !t.isDead } });`;
          try {
            pr = JSON.parse(await withGame((port) => ev(port, walkCode, 15000)));
          } catch (e) { pr = null; }
          if (!pr || pr.gone) break;
          if (!pr.alive) { ready = false; break; }
          if (pr.canSee && pr.dist <= 3) { ready = true; break; }
          if (pr.move === 'Fail') { fails++; if (fails >= 3) break; } else { fails = 0; }
          await sleep(250);
        }
        if (!pr || pr.gone) { kills.push({ name: pick.name, uid: pick.uid, note: 'vanished' }); continue; }
        if (!ready) {
          skip.add(pick.uid);
          failed.push({ name: pick.name, uid: pick.uid, reason: 'cannot reach/see' });
          misses++;
          if (misses >= 2 && hops < 3 && Date.now() < deadline) {
            try {
              await withGame((port) => ev(port, 'var p = EClass.pc; var pt = EClass._map.GetRandomSurface(); if (pt != null) { p.Teleport(pt, false, true); p.RecalculateFOV(); } return "hopped";', 15000));
            } catch (e) { /* ignore */ }
            skip.clear();
            misses = 0;
            hops++;
            await sleep(400);
          }
          continue;
        }
        /* fight with the game's PC auto-combat goal */
        const atkCode = `
var p = EClass.pc;
p.RecalculateFOV();
var t = EClass._map.charas.FirstOrDefault(c => c != null && c.uid == ${pick.uid});
if (t == null || t.isDead) return "gone";
p.SetEnemy(t);
p.SetAI(new GoalAutoCombat(t));
return "ok";`;
        try {
          await withGame((port) => ev(port, atkCode, 15000));
        } catch (e) {
          failed.push({ name: pick.name, reason: 'attack failed: ' + e.message });
          break;
        }
        const oneStart = Date.now();
        let dead = false;
        while (Date.now() - oneStart < 30000 && Date.now() < deadline) {
          await sleep(600);
          let st = null;
          try {
            st = JSON.parse(await withGame((port) => ev(port, `var t = EClass._map.charas.FirstOrDefault(c => c != null && c.uid == ${pick.uid}); return JsonConvert.SerializeObject(new Dictionary<string, object> { { "alive", t != null && !t.isDead }, { "hp", t == null ? 0 : t.hp } });`, 15000)));
          } catch (e) { /* keep polling */ }
          if (st && (!st.alive || st.hp <= 0)) { dead = true; break; }
        }
        if (dead) kills.push({ name: pick.name, uid: pick.uid });
        else { skip.add(pick.uid); failed.push({ name: pick.name, uid: pick.uid, reason: 'fight timeout' }); }
      }
      try {
        await withGame((port) => ev(port, `EClass.core.config.game.autopause = ${autopauseBefore ? 'true' : 'false'}; return "restored";`, 15000));
      } catch (e) { /* best effort */ }
      const summary = `kills=${kills.length}/${count}, failed=${failed.length}`;
      return { text: JSON.stringify({ ok: kills.length > 0, summary, kills, failed }) };
    }
    case 'gm_sleep': {
      const code = `
var p = EClass.pc;
p.Sleep();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "sleeping", true }, { "ai", p.ai == null ? null : p.ai.GetType().Name } });`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_travel': {
      const action = String(args.action || (args.zone ? 'go' : 'list'));
      const kind = String(args.kind || 'all');
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
      const zone = args.zone ? cs(args.zone) : 'null';
      if (action === 'list') {
        const code = `
var reg = EClass.world.region;
var towns = reg.ListTowns().Select(z => new Dictionary<string, object> { { "id", z.id }, { "name", z.Name }, { "lv", z.lv }, { "x", z.RegionPos.x }, { "z", z.RegionPos.z }, { "kind", "town" } }).ToList();
var sites = reg.ListRandomSites().Take(${limit}).Select(z => new Dictionary<string, object> { { "id", z.id }, { "name", z.Name }, { "lv", z.lv }, { "x", z.RegionPos.x }, { "z", z.RegionPos.z }, { "kind", "site" } }).ToList();
var outDict = new Dictionary<string, object>();
if (${cs(kind)} == "town" || ${cs(kind)} == "all") outDict["towns"] = towns;
if (${cs(kind)} == "site" || ${cs(kind)} == "all") outDict["sites"] = sites;
outDict["current"] = EClass._zone == null ? null : EClass._zone.id;
return JsonConvert.SerializeObject(outDict);`;
        return { text: await withGame((port) => ev(port, code, 30000)) };
      }
      if (action === 'region') {
        const regionCode = `
try { EClass.player.MoveZone(EClass.world.region); } catch (Exception ex) {
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", false }, { "reason", ex.GetType().Name + ": " + ex.Message } });
}
EClass.pc.currentZone = EClass.world.region;
var em = EClass.scene.elomapActor;
bool emActive = em != null && em.IsActive;
if (em != null && !emActive) {
  try { em.gameObject.SetActive(true); em.Initialize(EClass.world.region.elomap); emActive = em.IsActive; } catch (Exception ex) { }
}
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", true }, { "zone", EClass._zone == null ? null : EClass._zone.id }, { "isRegion", EClass._zone == null ? false : EClass._zone.IsRegion }, { "elomapActive", emActive } });`;
        return { text: await withGame((port) => ev(port, regionCode, 60000)) };
      }
      const code = `
string want = ${zone};
if (string.IsNullOrEmpty(want)) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", false }, { "reason", "zone is required for action=go" } });
var reg = EClass.world.region;
Zone z = null;
if (${cs(kind)} != "site") z = reg.ListTowns().FirstOrDefault(t => t.id == want || (t.Name ?? "").Contains(want));
if (z == null) z = reg.ListRandomSites().FirstOrDefault(t => t.id == want || (t.Name ?? "").Contains(want));
if (z == null) z = reg.ListTravelZones().FirstOrDefault(t => t.id == want || (t.Name ?? "").Contains(want));
if (z == null) z = reg.FindZone(want);
if (z == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", false }, { "reason", "zone not found: " + want }, { "towns", reg.ListTowns().Select(t => t.id).ToList() } });
var p0 = EClass.pc;
var lz = reg.ListTravelZones().FirstOrDefault(t => t != null && t.uid == z.uid);
int dist = lz != null ? lz.tempDist : z.tempDist;
if (!EClass._zone.IsRegion || dist <= 0) {
  var from = EClass._zone != null ? EClass._zone.RegionPos : z.RegionPos;
  int dx = Mathf.Abs(from.x - z.RegionPos.x);
  int dz = Mathf.Abs(from.z - z.RegionPos.z);
  dist = Mathf.Max(1, dx + dz);
}
int hours = dist * 3 * 100 / (100 + p0.Evalue(407) * 2);
int food = dist == 0 ? 0 : 1 + hours / 24;
int ration = p0.GetCurrency("ration");
if (p0.burden.GetPhase() >= 3) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", false }, { "id", z.id }, { "target", z.Name }, { "reason", "overweight (burden phase >= 3)" }, { "burden", p0.burden.GetPhase() } });
if (food > 0 && !p0.TryPay(food, "ration")) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", false }, { "id", z.id }, { "target", z.Name }, { "reason", "not enough ration" }, { "need", food }, { "have", ration } });
EClass.player.distanceTravel = dist;
EClass.player.dateTravel = EClass.world.date.GetRaw();
if (!EClass._zone.IsRegion) { try { EClass.player.MoveZone(reg); } catch (Exception ex) { } EClass.pc.currentZone = reg; }
string travelInfo = "dist=" + dist + ", hours=" + hours + ", ration=" + food;
bool isSite = false;
try { isSite = z.isRandomSite && !z.IsRegion; } catch (Exception ex) { }
if (isSite) {
  var p = EClass.pc;
  if (!EClass._zone.IsRegion) { try { EClass.player.MoveZone(reg); } catch (Exception ex) { } }
  p.currentZone = reg;
  p.global.transition = null;
  try { EClass.ui.CloseLayers(); } catch (Exception ex) { }
  p.MoveImmediate(z.RegionPos);
  EClass.player.lastZonePos = null;
  var state = z.RegionEnterState;
  if (state == ZoneTransition.EnterState.Dir) state = ZoneTransition.DirToState(p.GetCurrentDir());
  p.MoveZone(z, state);
  return JsonConvert.SerializeObject(new Dictionary<string, object> {
    { "moved", true }, { "pending", true }, { "kind", "site" },
    { "target", z.Name }, { "id", z.id }, { "travel", travelInfo }, { "hours", hours }, { "food", food },
    { "pcZone", p.currentZone == null ? null : p.currentZone.id }
  });
}
bool moveOk = true;
string moveErr = null;
try { EClass.player.MoveZone(z); } catch (Exception ex) { moveOk = false; moveErr = ex.GetType().Name; }
EClass.pc.currentZone = z;
var __p = EClass.pc; var __follows = new List<Chara>(); if (__p.parasite != null) __follows.Add(__p.parasite); if (__p.ride != null) __follows.Add(__p.ride); foreach (var __m in __p.party.members) { if (__m != null && !__m.IsPC) __follows.Add(__m); } foreach (var __f in __follows) { if (__f.currentZone != z || !__f.pos.IsInBounds) { try { z.AddCard(__f, __p.pos.Copy()); __f.currentZone = z; } catch (Exception ex) { } } }
try {
  var sp = z.GetSpawnPos(EClass.pc);
  if (sp != null) { EClass.pc.Teleport(sp, false, true); EClass.pc.RecalculateFOV(); }
} catch (Exception ex) { }
for (int hi2 = 0; hi2 < hours; hi2++) { try { EClass.world.date.AdvanceHour(); } catch (Exception ex) { } }
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "moved", true }, { "kind", "town" }, { "target", z.Name }, { "id", z.id }, { "lv", z.lv }, { "travel", travelInfo }, { "sceneInitError", moveErr }, { "zoneNow", EClass._zone == null ? null : EClass._zone.id }, { "pcPos", EClass.pc.pos.ToString() } });`;
      const text = await withGame((port) => ev(port, code, 60000));
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { return { text }; }
      if (!parsed || !parsed.pending) return { text };
      const deadline = Date.now() + 12000;
      const startAt = Date.now();
      let after = null;
      let retried = false;
      const retryCode = `
var p = EClass.pc;
if (!EClass._zone.IsRegion) { try { EClass.player.MoveZone(EClass.world.region); } catch (Exception ex) { } p.currentZone = EClass.world.region; }
var z = EClass.world.region.ListRandomSites().FirstOrDefault(t => t != null && t.Name == ${cs(parsed.target)});
if (z == null) return "no-zone";
p.global.transition = null;
try { EClass.ui.CloseLayers(); } catch (Exception ex) { }
p.MoveImmediate(z.RegionPos);
EClass.player.lastZonePos = null;
var st = z.RegionEnterState;
if (st == ZoneTransition.EnterState.Dir) st = ZoneTransition.DirToState(p.GetCurrentDir());
p.MoveZone(z, st);
return "retried";`;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const s = await withGame((p2) => ev(p2, 'return JsonConvert.SerializeObject(new Dictionary<string, object> { { "zone", EClass._zone == null ? null : EClass._zone.id }, { "name", EClass._zone == null ? null : EClass._zone.Name }, { "lv", EClass._zone == null ? 0 : EClass._zone.lv }, { "hasMap", EClass._zone == null ? false : EClass._zone.map != null } });', 15000));
          after = JSON.parse(s);
          if (after && after.zone === parsed.id) {
            try {
              const hrs = Math.max(0, Math.min(2000, Number(parsed.hours) || 0));
              if (hrs > 0) {
                await withGame((p2) => ev(p2, `for (int i = 0; i < ${hrs}; i++) { try { EClass.world.date.AdvanceHour(); } catch (Exception ex) { } } return "hours advanced";`, 30000));
              }
            } catch { /* best effort */ }
            try {
              await withGame((p2) => ev(p2, 'var p = EClass.pc; var __follows = new List<Chara>(); if (p.parasite != null) __follows.Add(p.parasite); if (p.ride != null) __follows.Add(p.ride); foreach (var __m in p.party.members) { if (__m != null && !__m.IsPC) __follows.Add(__m); } foreach (var __f in __follows) { if (__f.currentZone != EClass._zone || !__f.pos.IsInBounds) { try { EClass._zone.AddCard(__f, p.pos.Copy()); __f.currentZone = EClass._zone; } catch (Exception ex) { } } } return "party synced";', 15000));
            } catch { /* best effort */ }
            break;
          }
          if (!retried && Date.now() - startAt > 4000) {
            retried = true;
            try { await withGame((p2) => ev(p2, retryCode, 30000)); } catch { /* best effort */ }
          }
        } catch { /* keep polling */ }
      }
      const entered = !!(after && after.zone === parsed.id);
      if (!entered) {
        const paid = Math.max(0, Number(parsed.food) || 0);
        let refunded = 0;
        if (paid > 0) {
          try {
            await withGame((p2) => ev(p2, `EClass.pc.ModCurrency(${paid}, "ration"); return "refunded";`, 15000));
            refunded = paid;
          } catch { /* best effort */ }
        }
        return { text: JSON.stringify({ ...parsed, after, entryFailed: true, refunded, note: 'zone did not load; ration refunded' }) };
      }
      return { text: JSON.stringify({ ...parsed, after }) };
    }
    case 'gm_recipes': {
      const limit = Math.max(1, Math.min(300, Number(args.limit) || 60));
      const code = `
var known = EClass.player.recipes.knownRecipes;
var list = known.Keys.Take(${limit}).Select(id => {
  var rs = RecipeManager.Get(id);
  return new Dictionary<string, object> { { "id", id }, { "name", rs == null ? null : rs.Name }, { "factory", rs == null ? null : rs.NameFactory } };
}).ToList();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "count", known.Count }, { "recipes", list } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_craft': {
      const want = cs(args.recipe || '');
      const times = Math.max(1, Math.min(20, Number(args.times) || 1));
      const code = `
var p = EClass.pc;
string want = ${want};
int times = ${times};
var rs = RecipeManager.Get(want);
if (rs == null) {
  var matches = EClass.player.recipes.knownRecipes.Keys
    .Select(k => RecipeManager.Get(k)).Where(s => s != null && ((s.Name ?? "").Contains(want) || s.id.Contains(want)))
    .Take(8).Select(s => new Dictionary<string, object> { { "id", s.id }, { "name", s.Name } }).ToList();
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "crafted", false }, { "reason", "recipe not found: " + want }, { "matches", matches } });
}
Thing factoryThing = null;
if (rs.NeedFactory) {
  var nearAll = EClass._map.things.Where(t => t != null && t.trait is TraitCrafter && p.pos.Distance(t.pos) <= 3).ToList();
  factoryThing = nearAll.FirstOrDefault(t => (t.id ?? "").Contains(rs.idFactory ?? "###") || (rs.idFactory ?? "").Contains(t.id ?? "###")) ?? nearAll.FirstOrDefault();
}
bool allowed = EClass.player.recipes.IsKnown(rs.id);
if (!allowed) {
  try { var srcList = EClass.player.recipes.ListSources(factoryThing); allowed = srcList != null && srcList.Any(s => s != null && s.id == rs.id); } catch (Exception ex) { }
}
if (!allowed) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "crafted", false }, { "reason", "recipe not learned" }, { "id", rs.id }, { "name", rs.Name } });
var crafted = new List<object>();
for (int round = 0; round < times; round++) {
  var ings = rs.GetIngredients();
  var used = new List<Thing>();
  var missing = new List<string>();
  var boxes = EClass._map.things.Where(t => t != null && t.IsContainer && p.pos.Distance(t.pos) <= 5).ToList();
  var pool = new List<Thing>(p.things);
  foreach (var b in boxes) { foreach (var bt in b.things) { if (bt != null) pool.Add(bt); } }
  foreach (var ing in ings) {
    if (ing == null || ing.optional) continue;
    Thing pick = null;
    foreach (var t in pool) { if (t != null && !used.Contains(t) && ing.IsValidIngredient(t)) { pick = t; break; } }
    if (pick == null) missing.Add(ing.GetName()); else used.Add(pick);
  }
  if (missing.Count > 0) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "crafted", crafted }, { "reason", "missing ingredients" }, { "missing", missing }, { "id", rs.id }, { "name", rs.Name } });
  TraitCrafter crafter = null;
  if (rs.NeedFactory) {
    var near = EClass._map.things.Where(t => t != null && t.trait is TraitCrafter && p.pos.Distance(t.pos) <= 3).ToList();
    var fit = near.FirstOrDefault(t => (t.id ?? "").Contains(rs.idFactory ?? "###") || (rs.idFactory ?? "").Contains(t.id ?? "###"));
    if (fit == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "crafted", crafted }, { "reason", "no crafter station in range" }, { "need", rs.idFactory }, { "nearby", near.Select(t => t.Name).ToList() } });
    crafter = fit.trait as TraitCrafter;
  }
  foreach (var t in used) { t.SetNum(t.Num - 1); if (t.Num <= 0) t.Destroy(); }
  var recipe = Recipe.Create(rs);
  var made = recipe.Craft(BlessedState.Normal, true, used, crafter, false);
  crafted.Add(new Dictionary<string, object> { { "name", made == null ? null : made.Name }, { "id", made == null ? null : made.id }, { "num", made == null ? (object)null : made.Num } });
}
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "crafted", crafted }, { "recipe", rs.id } });`;
      return { text: await withGame((port) => ev(port, code, 120000)) };
    }
    case 'gm_place': {
      const want = cs(args.name || '');
      const hasCell = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.z));
      const cx = hasCell ? Math.trunc(Number(args.x)) : 0;
      const cz = hasCell ? Math.trunc(Number(args.z)) : 0;
      const code = `
var p = EClass.pc;
string want = ${want};
bool hasCell = ${hasCell ? 'true' : 'false'};
int cx = ${cx}, cz = ${cz};
var t = p.things.FirstOrDefault(x => x != null && ((x.Name ?? "").Contains(want) || x.id == want));
if (t == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "placed", false }, { "reason", "not carried: " + want } });
var cell = hasCell ? new Point(cx, cz) : p.pos;
if (!cell.IsInBounds) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "placed", false }, { "reason", "cell out of bounds" } });
if (cell.HasChara) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "placed", false }, { "reason", "cell occupied by a character" } });
EClass._zone.AddCard(t, cell);
t.SetPlaceState(PlaceState.installed, true);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "placed", true }, { "name", t.Name }, { "id", t.id }, { "x", t.pos.x }, { "z", t.pos.z }, { "state", t.placeState.ToString() } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_gather': {
      const hasCell = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.z));
      const cx = hasCell ? Math.trunc(Number(args.x)) : 0;
      const cz = hasCell ? Math.trunc(Number(args.z)) : 0;
      const r = Math.max(1, Math.min(10, Number(args.radius) || 1));
      const code = `
var p = EClass.pc;
bool hasCell = ${hasCell ? 'true' : 'false'};
int cx = ${cx}, cz = ${cz}, r = ${r};
Point best = null; string kind = null;
if (hasCell) {
  var pt = new Point(cx, cz);
  if (pt.IsInBounds) { if (pt.HasMinableBlock) { best = pt; kind = "block"; } else if (pt.HasObj) { best = pt; kind = "obj"; } }
} else {
  for (int dx = -r; dx <= r && best == null; dx++) {
    for (int dz = -r; dz <= r && best == null; dz++) {
      var pt = new Point(p.pos.x + dx, p.pos.z + dz);
      if (!pt.IsInBounds) continue;
      if (pt.HasMinableBlock) { best = pt; kind = "block"; }
      else if (pt.HasObj) { best = pt; kind = "obj"; }
    }
  }
}
if (best == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "gathered", false }, { "reason", "no harvestable cell in range" } });
var bx = best.x; var bz = best.z;
try {
  if (kind == "block") EClass._map.MineBlock(best, false, p, true);
  else EClass._map.MineObj(best, null, p);
} catch (Exception ex) {
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "gathered", false }, { "reason", ex.Message } });
}
var after = new Point(bx, bz);
var picked = new List<object>();
foreach (var drop in EClass._map.things.Where(t => t != null && t.pos != null && t.pos.x == bx && t.pos.z == bz).ToList()) {
  var nm = drop.Name; var n = drop.Num;
  var got = p.Pick(drop, true, true);
  if (got != null) picked.Add(new Dictionary<string, object> { { "name", nm }, { "num", n } });
}
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "gathered", true }, { "kind", kind }, { "x", bx }, { "z", bz }, { "stillObj", after.HasObj }, { "stillBlock", after.HasMinableBlock }, { "picked", picked }, { "inventory", p.things.Count } });`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_container': {
      const action = String(args.action || 'list');
      const item = args.name ? cs(args.name) : 'null';
      const box = args.container ? cs(args.container) : 'null';
      const hasCell = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.z));
      const cx = hasCell ? Math.trunc(Number(args.x)) : 0;
      const cz = hasCell ? Math.trunc(Number(args.z)) : 0;
      const code = `
var p = EClass.pc;
string act = ${cs(action)};
string wantItem = ${item};
string wantBox = ${box};
bool hasCell = ${hasCell ? 'true' : 'false'};
int cx = ${cx}, cz = ${cz};
Thing box = null;
if (hasCell) {
  var pt = new Point(cx, cz);
  box = pt.HasObj ? pt.Installed : null;
  if (box != null && !box.IsContainer) box = null;
} else {
  var near = EClass._map.things.Where(t => t != null && t.IsContainer && p.pos.Distance(t.pos) <= 5)
    .OrderBy(t => p.pos.Distance(t.pos)).ToList();
  if (!string.IsNullOrEmpty(wantBox)) near = near.Where(t => (t.Name ?? "").Contains(wantBox)).ToList();
  box = near.FirstOrDefault();
}
if (box == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "no container found nearby" } });
Func<Thing, bool> matchItem = (t) => string.IsNullOrEmpty(wantItem) || ((t.Name ?? "").Contains(wantItem) || t.id == wantItem);
if (act == "list") {
  var items = box.things.Where(t => t != null).Select(t => new Dictionary<string, object> { { "name", t.Name }, { "num", t.Num }, { "id", t.id } }).Take(80).ToList();
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "container", box.Name }, { "count", box.things.Count }, { "items", items } });
}
if (act == "take") {
  var moved = new List<object>();
  foreach (var t in box.things.Where(t => t != null && matchItem(t)).ToList()) {
    var name = t.Name; var num = t.Num;
    p.AddThing(t);
    moved.Add(new Dictionary<string, object> { { "name", name }, { "num", num } });
  }
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "container", box.Name }, { "moved", moved }, { "inventory", p.things.Count }, { "left", box.things.Count } });
}
if (act == "put") {
  var moved = new List<object>();
  foreach (var t in p.things.Where(t => t != null && matchItem(t)).ToList()) {
    var name = t.Name; var num = t.Num;
    box.AddThing(t);
    moved.Add(new Dictionary<string, object> { { "name", name }, { "num", num } });
  }
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "container", box.Name }, { "moved", moved }, { "inventory", p.things.Count }, { "left", box.things.Count } });
}
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "unknown action: " + act } });`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_quests': {
      const action = String(args.action || 'active');
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 30));
      const code = `
string act = ${cs(action)};
int limit = ${limit};
if (act == "available") {
  var rows = EClass.sources.quests.map.Values
    .Where(r => r != null && (r.minFame <= 0 || EClass.player.fame >= r.minFame))
    .Take(limit)
    .Select(r => new Dictionary<string, object> { { "id", r.id }, { "name", r.name }, { "type", r.type }, { "group", r.group }, { "minFame", r.minFame }, { "money", r.money } })
    .ToList();
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "available", rows } });
}
if (act == "detail") {
  var det = EClass.game.quests.list.Take(limit).Select(q => new Dictionary<string, object> {
    { "id", q.id }, { "title", q.GetTitle() }, { "phase", q.phase }, { "lv", q.lv },
    { "reward", q.rewardMoney }, { "deadline", q.TextDeadline },
    { "progress", q.GetTextProgress() },
    { "taskDone", q.task == null ? (object)null : q.task.IsComplete() },
    { "taskType", q.task == null ? null : q.task.GetType().Name },
    { "client", q.chara == null ? null : q.chara.Name },
    { "type", q.GetType().Name }
  }).ToList();
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "detail", det } });
}
var list = EClass.game.quests.list.Take(limit).Select(q => new Dictionary<string, object> {
  { "id", q.id }, { "title", q.GetTitle() }, { "phase", q.phase }, { "lv", q.lv },
  { "reward", q.rewardMoney }, { "deadline", q.TextDeadline }, { "type", q.GetType().Name }
}).ToList();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", list }, { "fame", EClass.player.fame } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_quest_start': {
      const id = cs(args.id || '');
      const code = `
string id = ${id};
var q = EClass.game.quests.Start(id, null, true);
if (q == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "started", false }, { "reason", "Start returned null (unknown id or not allowed)" } });
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "started", true }, { "id", q.id }, { "title", q.GetTitle() }, { "phase", q.phase }, { "reward", q.rewardMoney } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_quest_deliver': {
      const id = cs(args.id || '');
      const item = cs(args.item || '');
      const code = `
string id = ${id};
string want = ${item};
var q = EClass.game.quests.Get(id);
if (q == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "quest not active: " + id } });
var p = EClass.pc;
var t = p.things.FirstOrDefault(x => x != null && ((x.Name ?? "").Contains(want) || x.id == want));
if (t == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "not carried: " + want } });
var before = q.phase;
var name = t.Name;
q.OnGiveItem(p, t);
var stillHeld = p.things.Contains(t);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "quest", q.id }, { "item", name }, { "phase", q.phase }, { "phaseChanged", q.phase != before }, { "progress", q.GetTextProgress() }, { "taskDone", q.task == null ? (object)null : q.task.IsComplete() }, { "stillHeld", stillHeld } });`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_quest_advance': {
      const id = cs(args.id || '');
      const code = `
string id = ${id};
var q = EClass.game.quests.Get(id);
if (q == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "quest not active: " + id } });
var before = q.phase;
q.ChangePhase(q.phase + 1);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "quest", q.id }, { "phaseBefore", before }, { "phaseAfter", q.phase }, { "progress", q.GetTextProgress() } });`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_quest_complete': {
      const id = cs(args.id || '');
      const code = `
string id = ${id};
var q = EClass.game.quests.Get(id);
if (q == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "quest not active: " + id } });
var title = q.GetTitle();
var hadTask = q.task != null;
try {
  if (q.task != null) q.CompleteTask();
  q.Complete();
} catch (Exception ex) {
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "quest", q.id }, { "title", title }, { "hadTask", hadTask }, { "stillActive", EClass.game.quests.Get(q.id) != null }, { "error", ex.GetType().Name + ": " + ex.Message } });
}
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "quest", q.id }, { "title", title }, { "isComplete", q.isComplete } });`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_move_to': {
      const x = Math.trunc(Number(args.x));
      const z = Math.trunc(Number(args.z));
      const steps = Math.max(1, Math.min(100, Number(args.steps) || 20));
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('x and z must be numbers');
      const code = `
var p = EClass.pc;
var __follows = new List<Chara>(); if (p.parasite != null) __follows.Add(p.parasite); if (p.ride != null) __follows.Add(p.ride); foreach (var __m in p.party.members) { if (__m != null && !__m.IsPC) __follows.Add(__m); } foreach (var __f in __follows) { if (__f.currentZone != EClass._zone || !__f.pos.IsInBounds) { try { EClass._zone.AddCard(__f, p.pos.Copy()); __f.currentZone = EClass._zone; } catch (Exception ex) { } } }
var dest = new Point(${x}, ${z});
int maxSteps = ${steps};
int moved = 0;
bool unstuck = false;
if (p.pos.IsBlocked) {
  var free = p.pos.GetNearestPoint(allowBlock: false, allowChara: false);
  if (free != null) { p.Teleport(free, false, true); unstuck = true; }
}
var trail = new List<object>();
for (int i = 0; i < maxSteps; i++) {
  if (p.pos.Equals(dest)) break;
  int bx = p.pos.x, bz = p.pos.z;
  p.TryMoveTowards(dest);
  bool stepped = p.pos.x != bx || p.pos.z != bz;
  if (trail.Count < 12) trail.Add(new Dictionary<string, object> { { "x", p.pos.x }, { "z", p.pos.z }, { "stepped", stepped } });
  if (!stepped) break;
  moved++;
}
int teleports = 0;
if (!p.pos.Equals(dest)) {
  Point target = null;
  if (dest.IsInBounds && !dest.IsBlocked && !dest.HasChara) {
    target = dest;
  } else {
    try { target = dest.GetNearestPoint(allowBlock: false, allowChara: false, allowInstalled: true, ignoreCenter: true, 6); } catch (Exception ex) { }
  }
  if (target != null && !target.Equals(p.pos)) {
    try { p.Teleport(target, true, true); teleports = 1; p.RecalculateFOV(); } catch (Exception ex) { }
  }
}
return JsonConvert.SerializeObject(new Dictionary<string, object> {
  { "reached", p.pos.Equals(dest) },
  { "moved", moved },
  { "teleports", teleports },
  { "unstuck", unstuck },
  { "pos", new Dictionary<string, object> { { "x", p.pos.x }, { "z", p.pos.z } } },
  { "target", new Dictionary<string, object> { { "x", ${x} }, { "z", ${z} } } },
  { "trail", trail }
});`;
      return { text: await withGame((port) => ev(port, code, 60000)) };
    }
    case 'gm_cycle': {
      const action = ['status', 'run', 'settle'].includes(String(args.action)) ? String(args.action) : 'run';
      const code = `
var p = EClass.pc;
string act = ${cs(action)};
var plot = new List<Point>();
foreach (var t in EClass._map.things) {
  if (t == null) continue;
  if (t.trait is TraitSpotFarm farm) { foreach (var pt in farm.ListPoints(null, false)) plot.Add(pt); }
}
var seen = new HashSet<string>();
var cells = new List<Point>();
foreach (var pt in plot) { if (seen.Add(pt.ToString())) cells.Add(pt); }
int plants = 0, mature = 0, empty = 0;
foreach (var pt in cells) {
  if (pt.cell.growth != null) {
    plants++;
    int st = -1, hs = -1;
    try { st = pt.cell.growth.stage.idx; hs = pt.cell.growth.HarvestStage; } catch (Exception ex) { }
    if (hs > 0 && st >= hs) mature++;
  } else if (!pt.HasObj && !pt.HasChara) empty++;
}
var ship = EClass.game.cards.container_shipping;
if (ship == null) { foreach (var t in EClass._map.things) { if (t != null && t.trait is TraitShippingChest) { ship = t; break; } } }
var result = new Dictionary<string, object>();
result["act"] = act;
result["plotCells"] = cells.Count;
result["plants"] = plants;
result["mature"] = mature;
result["empty"] = empty;
result["shipPos"] = ship == null ? null : ship.pos.ToString();
result["shipStacks"] = ship == null ? 0 : ship.things.Count;
result["money"] = p.GetCurrency("money");
if (act == "settle") {
  long settleMoney0 = p.GetCurrency("money");
  if (EClass.world.date.hour == 5) EClass.world.date.AdvanceHour();
  int settleSteps = 1;
  while (EClass.world.date.hour != 5 && settleSteps < 30) { EClass.world.date.AdvanceHour(); settleSteps++; }
  long settleMoney1 = p.GetCurrency("money");
  result["gain"] = settleMoney1 - settleMoney0;
  result["moneyAfter"] = settleMoney1;
  result["steps"] = settleSteps;
  result["date"] = EClass.world.date.day + "/" + EClass.world.date.month;
  result["shipStacks"] = ship == null ? 0 : ship.things.Count;
  return JsonConvert.SerializeObject(result);
}
if (act == "run") {
  if (ship != null && EClass.game.cards.container_shipping != ship) EClass.game.cards.container_shipping = ship;
  var pickedGround = new List<string>();
  foreach (var pt in cells) {
    foreach (var t in pt.Things.ToList()) {
      if (t == null || t.IsInstalled) continue;
      var nm = t.Name + " x" + t.Num;
      try {
        if (p.Pick(t, true, true) != null) pickedGround.Add(nm);
        else if (ship != null) { ship.AddThing(t); pickedGround.Add(nm + "[ship]"); }
      } catch (Exception ex) { }
    }
  }
  result["pickedGround"] = pickedGround;
  int planted = 0;
  var plantErrors = new List<string>();
  foreach (var pt in cells) {
    if (pt.cell.growth != null || pt.HasObj || pt.HasChara) continue;
    Thing seed = null;
    foreach (var t in p.things) { if (t != null && t.trait is TraitSeed && t.Num > 0) { seed = t; break; } }
    if (seed == null) break;
    try {
      var ts = seed.trait as TraitSeed;
      var row = ts.row;
      var card = TraitSeed.MakeSeed(row);
      EClass._zone.AddCard(card, pt);
      (card.trait as TraitSeed).TrySprout(true);
      if (seed.Num > 1) seed.SetNum(seed.Num - 1); else seed.Destroy();
      planted++;
    } catch (Exception ex) { plantErrors.Add(ex.GetType().Name + ":" + ex.Message); break; }
  }
  result["plantErrors"] = plantErrors;
  int grownSteps = 0;
  for (int k = 0; k < 12; k++) {
    int changed = 0;
    foreach (var pt in cells) {
      if (pt.cell.growth == null) continue;
      int st = -1, hs = -1;
      try { st = pt.cell.growth.stage.idx; hs = pt.cell.growth.HarvestStage; } catch (Exception ex) { continue; }
      if (hs <= 0 || st >= hs) continue;
      try { pt.cell.growth.Grow(60); changed++; } catch (Exception ex) { }
    }
    grownSteps += changed;
    if (changed == 0) break;
  }
  var produce = new List<string>();
  int harvested = 0;
  foreach (var pt in cells) {
    if (pt.cell.growth == null) continue;
    int st = -1, hs = -1;
    try { st = pt.cell.growth.stage.idx; hs = pt.cell.growth.HarvestStage; } catch (Exception ex) { continue; }
    if (hs <= 0 || st < hs) continue;
    try { pt.cell.growth.PopHarvest(p); harvested++; } catch (Exception ex) { continue; }
    try { pt.cell.growth.TryPopSeed(p); } catch (Exception ex) { }
    foreach (var t in pt.Things.ToList()) {
      if (t == null || t.IsInstalled) continue;
      var nm = t.Name + " x" + t.Num;
      try {
        if (p.Pick(t, true, true) != null) produce.Add(nm);
        else if (ship != null) { ship.AddThing(t); produce.Add(nm + "[ship]"); }
      } catch (Exception ex) { }
    }
  }
  var sellIds = new HashSet<string> { "tomato", "cabbage", "wheat", "rice", "potato", "potato2", "grass", "leaf", "vine", "fiber", "scrap", "ore", "log", "branch", "resin", "straw", "grape" };
  int shippedStacks = 0;
  if (ship != null) {
    foreach (var t in p.things.ToList()) {
      if (t == null) continue;
      if (t.trait is TraitSeed) continue;
      bool match = t.id != null && sellIds.Contains(t.id);
      if (!match) {
        var nm = t.Name ?? "";
        var cid = t.category == null ? null : t.category.id;
        if (cid == "food" || nm.Contains("腐烂") || nm.Contains("原木") || nm.Contains("树脂") || nm.Contains("树皮")) match = true;
        if (!match && (nm.Contains("番茄") || nm.Contains("卷心菜") || nm.Contains("土薯") || nm.Contains("香蕉") || nm.Contains("橙子") || nm.Contains("阿比") || nm.Contains("葡萄") || nm.Contains("小麦") || nm.Contains("米"))) match = true;
      }
      if (!match) continue;
      try { ship.AddThing(t); shippedStacks++; } catch (Exception ex) { }
    }
  }
  result["planted"] = planted;
  result["grownSteps"] = grownSteps;
  result["harvested"] = harvested;
  result["produce"] = produce;
  result["shippedStacks"] = shippedStacks;
  result["shipStacksAfter"] = ship == null ? 0 : ship.things.Count;
}
try { EClass._map.RefreshAllTiles(); } catch (Exception ex) { }
return JsonConvert.SerializeObject(result);`;
      const raw = await withGame((port) => ev(port, code, 90000));
      if (args.verbose || action !== 'run') return { text: raw };
      const parsed = tryParse(raw);
      if (!parsed) return { text: raw };
      return { text: JSON.stringify(compactCycle(parsed)) };
    }
    case 'gm_npcs': {
      const r = Math.max(1, Math.min(30, Number(args.radius) || 10));
      const code = `
var p = EClass.pc;
var list = EClass._map.charas.Where(c => c != null && c != p && c.pos.Distance(p.pos) <= ${r})
  .OrderBy(c => c.pos.Distance(p.pos))
  .Take(30)
  .Select(c => new Dictionary<string, object> {
    { "name", c.Name }, { "id", c.id }, { "hp", c.hp }, { "dist", c.pos.Distance(p.pos) },
    { "hostility", c.hostility.ToString() },
    { "pcFaction", c.IsPCFaction },
    { "merchant", c.trait is TraitMerchant },
    { "quest", c.quest == null ? null : c.quest.id }
  }).ToList();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "radius", ${r} }, { "npcs", list } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_talk_to': {
      const want = args.name ? cs(args.name) : 'null';
      const r = Math.max(1, Math.min(20, Number(args.radius) || 6));
      const code = `
var p = EClass.pc;
string want = ${want};
int r = ${r};
var near = EClass._map.charas.Where(c => c != null && c != p && c.pos.Distance(p.pos) <= r).OrderBy(c => c.pos.Distance(p.pos)).ToList();
Chara target = null;
if (!string.IsNullOrEmpty(want)) target = near.FirstOrDefault(c => (c.Name ?? "").Contains(want) || c.id == want);
else target = near.FirstOrDefault();
if (target == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "no character in range" } });
var before = new Dictionary<string, int>();
foreach (var q in EClass.game.quests.list) before[q.id] = q.phase;
bool questUpdated = false;
try { questUpdated = EClass.game.quests.OnShowDialog(target); } catch (Exception ex) { /* dialogue UI may be unavailable */ }
int ownPhaseBefore = target.quest == null ? -1 : target.quest.phase;
if (!questUpdated && target.quest != null) {
  try { target.quest.UpdateOnTalk(); questUpdated = true; } catch (Exception ex) { }
}
var changed = new List<object>();
foreach (var q in EClass.game.quests.list) {
  int b;
  if (!before.TryGetValue(q.id, out b) || b != q.phase) changed.Add(new Dictionary<string, object> { { "id", q.id }, { "title", q.GetTitle() }, { "phase", q.phase } });
}
if (target.quest != null && ownPhaseBefore != target.quest.phase) {
  changed.Add(new Dictionary<string, object> { { "id", target.quest.id }, { "title", target.quest.GetTitle() }, { "phase", target.quest.phase }, { "own", true } });
}
bool dialogOpened = false;
if (!questUpdated && changed.Count == 0) {
  try { target.ShowDialog(); dialogOpened = LayerDrama.IsActive() || EClass.ui.GetLayer<Dialog>() != null; } catch (Exception ex) {
    try { var topic = target.TalkTopic("calm"); target.Talk(topic); } catch (Exception ex2) { target.TalkRaw("……"); }
  }
}
return JsonConvert.SerializeObject(new Dictionary<string, object> {
  { "ok", true }, { "target", target.Name }, { "id", target.id },
  { "questUpdated", questUpdated }, { "changed", changed }, { "dialogOpened", dialogOpened },
  { "merchant", target.trait is TraitMerchant }, { "client", target.quest == null ? null : target.quest.id }
});`;
      return { text: await withGame((port) => ev(port, code, 45000)) };
    }
    case 'gm_shop': {
      const want = args.merchant ? cs(args.merchant) : 'null';
      const r = Math.max(1, Math.min(20, Number(args.radius) || 8));
      const code = `
var p = EClass.pc;
string want = ${want};
var m = EClass._map.charas.Where(c => c != null && c != p && c.trait is TraitMerchant && p.pos.Distance(c.pos) <= ${r})
  .Where(c => string.IsNullOrEmpty(want) || (c.Name ?? "").Contains(want))
  .OrderBy(c => p.pos.Distance(c.pos)).FirstOrDefault();
if (m == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "no merchant in range" } });
Thing chest = m.things.Find("chest_merchant");
if (chest == null) { try { m.trait.OnBarter(false); } catch (Exception ex) { } chest = m.things.Find("chest_merchant"); }
var shelf = (chest != null && chest.things.Count > 0) ? chest.things.Where(t => t != null).ToList() : m.things.Where(t => t != null).ToList();
var goods = shelf.Take(60).Select(t => {
  int price = 0;
  try { price = t.GetPrice(CurrencyType.Money, false, PriceType.Default, p); } catch (Exception ex) { }
  return new Dictionary<string, object> { { "name", t.Name }, { "num", t.Num }, { "id", t.id }, { "price", price } };
}).ToList();
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "merchant", m.Name }, { "dist", p.pos.Distance(m.pos) }, { "money", p.GetCurrency("money") }, { "shelfFromChest", chest != null }, { "goods", goods } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_buy': {
      const item = cs(args.item || '');
      const count = Math.max(1, Math.min(999, Number(args.count) || 1));
      const want = args.merchant ? cs(args.merchant) : 'null';
      const code = `
var p = EClass.pc;
string item = ${item};
string want = ${want};
int count = ${count};
var m = EClass._map.charas.Where(c => c != null && c != p && c.trait is TraitMerchant && p.pos.Distance(c.pos) <= 12)
  .Where(c => string.IsNullOrEmpty(want) || (c.Name ?? "").Contains(want))
  .OrderBy(c => p.pos.Distance(c.pos)).FirstOrDefault();
if (m == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "no merchant in range" } });
Thing chest = m.things.Find("chest_merchant");
if (chest == null) { try { m.trait.OnBarter(false); } catch (Exception ex) { } chest = m.things.Find("chest_merchant"); }
var pool = (chest != null && chest.things.Count > 0) ? chest.things.Where(x => x != null).ToList() : m.things.Where(x => x != null).ToList();
var t = pool.FirstOrDefault(x => x.id == item || (x.Name ?? "") == item) ?? pool.FirstOrDefault(x => (x.Name ?? "").Contains(item));
if (t == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "not sold here: " + item }, { "merchant", m.Name }, { "stock", pool.Take(20).Select(x => x.Name).ToList() } });
int n = Math.Min(count, t.Num);
int unit = t.GetPrice(CurrencyType.Money, false, PriceType.Default, p);
int total = unit * n;
int money = p.GetCurrency("money");
if (money < total) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "not enough money" }, { "need", total }, { "money", money }, { "unitPrice", unit } });
p.ModCurrency(-total, "money");
Thing got;
if (n < t.Num) got = t.Split(n); else got = t;
p.AddThing(got);
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "item", got.Name }, { "num", n }, { "unitPrice", unit }, { "paid", total }, { "money", p.GetCurrency("money") }, { "inventory", p.things.Count } });`;
      return { text: await withGame((port) => ev(port, code, 45000)) };
    }
    case 'gm_sell': {
      const item = cs(args.item || '');
      const count = Math.max(1, Math.min(999, Number(args.count) || 1));
      const want = args.merchant ? cs(args.merchant) : 'null';
      const code = `
var p = EClass.pc;
string item = ${item};
string want = ${want};
int count = ${count};
var m = EClass._map.charas.Where(c => c != null && c != p && c.trait is TraitMerchant && p.pos.Distance(c.pos) <= 12)
  .Where(c => string.IsNullOrEmpty(want) || (c.Name ?? "").Contains(want))
  .OrderBy(c => p.pos.Distance(c.pos)).FirstOrDefault();
if (m == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "no merchant in range" } });
var pool = p.things.Where(x => x != null).ToList();
var t = pool.FirstOrDefault(x => x.id == item || (x.Name ?? "") == item) ?? pool.FirstOrDefault(x => (x.Name ?? "").Contains(item));
if (t == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "not carried: " + item } });
int n = Math.Min(count, t.Num);
int unit = t.GetPrice(CurrencyType.Money, true, PriceType.Default, p);
int total = unit * n;
Thing moved;
if (n < t.Num) moved = t.Split(n); else moved = t;
Thing chest = m.things.Find("chest_merchant");
if (chest == null) { try { m.trait.OnBarter(false); } catch (Exception ex) { } chest = m.things.Find("chest_merchant"); }
bool intoChest = false;
if (chest != null) { try { chest.AddThing(moved); intoChest = true; } catch (Exception ex) { } }
if (!intoChest) m.AddThing(moved);
p.ModCurrency(total, "money");
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", true }, { "item", moved.Name }, { "num", n }, { "unitPrice", unit }, { "earned", total }, { "intoChest", intoChest }, { "money", p.GetCurrency("money") }, { "inventory", p.things.Count } });`;
      return { text: await withGame((port) => ev(port, code, 45000)) };
    }
    case 'gm_build': {
      const action = String(args.action || 'place');
      const item = args.name ? cs(args.name) : 'null';
      const bx = Number.isFinite(Number(args.x)) ? Math.trunc(Number(args.x)) : -1;
      const bz = Number.isFinite(Number(args.z)) ? Math.trunc(Number(args.z)) : -1;
      const code = `
var p = EClass.pc;
string act = ${cs(action)};
string item = ${item};
int bx = ${bx}, bz = ${bz};
var pt = (bx >= 0 && bz >= 0) ? new Point(bx, bz) : new Point(p.pos.x + 1, p.pos.z);
if (!pt.IsInBounds) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "cell out of bounds" }, { "pos", pt.ToString() } });
if (act == "remove") {
  int removed = 0;
  try {
    var cards = pt.Things.ToList();
    foreach (var c in cards) {
      if (c == null || !c.IsInstalled) continue;
      if (!string.IsNullOrEmpty(item) && c.id != item && !(c.Name ?? "").Contains(item)) continue;
      c.Destroy();
      removed++;
    }
  } catch (Exception ex) { return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", ex.GetType().Name } }); }
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", removed > 0 }, { "removed", removed }, { "pos", pt.ToString() }, { "blocked", pt.IsBlocked } });
}
if (string.IsNullOrEmpty(item)) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "name required" } });
Thing t = null;
try { t = ThingGen.Create(item); } catch (Exception ex) { return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", ex.GetType().Name + ": " + ex.Message } }); }
if (t == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "unknown item: " + item } });
try {
  EClass._zone.AddCard(t, pt);
  t.SetPlaceState(PlaceState.installed, true);
} catch (Exception ex) {
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "place failed: " + ex.GetType().Name }, { "id", t.id } });
}
return JsonConvert.SerializeObject(new Dictionary<string, object> {
  { "ok", true }, { "name", t.Name }, { "id", t.id }, { "pos", pt.ToString() },
  { "blocked", pt.IsBlocked }, { "hasObj", pt.HasObj }
});`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_supply': {
      const want = Math.max(1, Math.min(50, Number(args.count) || 10));
      const mode = ['auto', 'buy', 'craft'].includes(String(args.mode)) ? String(args.mode) : 'auto';
      const code = `
var p = EClass.pc;
int want = ${want};
string mode = ${cs(mode)};
var log = new List<object>();
var merchants = EClass._map.charas.Where(c => c != null && c != p && c.trait is TraitMerchant).ToList();
var shelves = new Dictionary<Chara, Thing>();
foreach (var mm in merchants) {
  var ch = mm.things.Find("chest_merchant");
  if (ch == null) { try { mm.trait.OnBarter(false); } catch (Exception ex) { } ch = mm.things.Find("chest_merchant"); }
  if (ch != null) shelves[mm] = ch;
}
var sellers = merchants.Where(c => shelves.ContainsKey(c) && shelves[c].things.Any(t => t != null && t.id == "ration")).OrderBy(c => p.pos.Distance(c.pos)).ToList();

if (mode != "craft" && sellers.Count > 0) {
  var m = sellers[0];
  var shelf = shelves[m];
  int before = p.pos.Distance(m.pos);
  if (before > 2) {
    var spot = m.pos.GetNearestPoint(allowBlock: false, allowChara: false, allowInstalled: true, ignoreCenter: true, 3);
    if (spot != null) { try { p.pos.Set(spot.x, spot.z); p.RecalculateFOV(); } catch (Exception ex) { } }
  }
  int bought = 0;
  int spent = 0;
  while (bought < want) {
    var t = shelf.things.FirstOrDefault(x => x != null && x.id == "ration");
    if (t == null) break;
    int unit = t.GetPrice(CurrencyType.Money, false, PriceType.Default, p);
    if (unit <= 0) break;
    int money = p.GetCurrency("money");
    int afford = money / unit;
    if (afford <= 0) break;
    int n = Math.Min(Math.Min(t.Num, afford), want - bought);
    if (n <= 0) break;
    p.ModCurrency(-(unit * n), "money");
    Thing got = (n < t.Num) ? t.Split(n) : t;
    p.AddThing(got);
    bought += n;
    spent += unit * n;
  }
  return JsonConvert.SerializeObject(new Dictionary<string, object> {
    { "ok", bought > 0 }, { "mode", "buy" }, { "merchant", m.Name }, { "merchantId", m.id },
    { "distBefore", before }, { "bought", bought }, { "spent", spent },
    { "money", p.GetCurrency("money") }, { "ration", p.GetCurrency("ration") }, { "pcPos", p.pos.ToString() }
  });
}
if (mode == "buy") {
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "mode", "buy" }, { "reason", "no resident merchant sells ration on this map" } });
}

string TryCraft(string rid) {
  var rs = RecipeManager.Get(rid);
  if (rs == null) return "recipe-missing:" + rid;
  if (!EClass.player.recipes.IsKnown(rid)) return "not-learned:" + rid;
  var ings = rs.GetIngredients();
  var used = new List<Thing>();
  var missing = new List<string>();
  var boxes = EClass._map.things.Where(t => t != null && t.IsContainer && p.pos.Distance(t.pos) <= 5).ToList();
  var pool = new List<Thing>(p.things);
  foreach (var b in boxes) { foreach (var bt in b.things) { if (bt != null) pool.Add(bt); } }
  foreach (var ing in ings) {
    if (ing == null || ing.optional) continue;
    Thing pick = null;
    foreach (var t in pool) { if (t != null && !used.Contains(t) && ing.IsValidIngredient(t)) { pick = t; break; } }
    if (pick == null) missing.Add(ing.GetName()); else used.Add(pick);
  }
  if (missing.Count > 0) return "missing:" + string.Join("/", missing.ToArray());
  TraitCrafter crafter = null;
  if (rs.NeedFactory) {
    var near = EClass._map.things.Where(t => t != null && t.trait is TraitCrafter && p.pos.Distance(t.pos) <= 3).ToList();
    var fit = near.FirstOrDefault(t => (t.id ?? "").Contains(rs.idFactory ?? "###") || (rs.idFactory ?? "").Contains(t.id ?? "###"));
    if (fit == null) return "no-station:" + (rs.idFactory ?? "?");
    crafter = fit.trait as TraitCrafter;
  }
  foreach (var t in used) { t.SetNum(t.Num - 1); if (t.Num <= 0) t.Destroy(); }
  var recipe = Recipe.Create(rs);
  var made = recipe.Craft(BlessedState.Normal, true, used, crafter, false);
  return "ok:" + (made == null ? "?" : made.Name);
}

foreach (var rid in new string[] { "millstone", "mixer", "rationmaker" }) {
  string r = TryCraft(rid);
  log.Add(new Dictionary<string, object> { { "step", rid }, { "result", r } });
  if (!r.StartsWith("ok")) {
    return JsonConvert.SerializeObject(new Dictionary<string, object> {
      { "ok", false }, { "mode", "craft" }, { "reason", "craft chain blocked" }, { "log", log },
      { "ration", p.GetCurrency("ration") },
      { "stations", new Dictionary<string, object> { { "millstone", "workbench" }, { "mixer", "factory_tinker" } } },
      { "hint", "missing: gather materials (gm_gather) or place the required station with gm_build; ration itself needs 尸体/肉" }
    });
  }
}

bool placed = false;
var machine = p.things.FirstOrDefault(t => t != null && t.id == "rationmaker");
if (machine != null) {
  var spot = p.pos.GetNearestPoint(allowBlock: false, allowChara: false, allowInstalled: true, ignoreCenter: true, 2);
  if (spot != null) {
    try { EClass._zone.AddCard(machine, spot); machine.SetPlaceState(PlaceState.installed, true); placed = true; } catch (Exception ex) { }
  }
}
int madeCount = 0;
if (EClass.player.recipes.IsKnown("ration")) {
  for (int i = 0; i < want; i++) {
    string r = TryCraft("ration");
    log.Add(new Dictionary<string, object> { { "step", "ration" }, { "result", r } });
    if (!r.StartsWith("ok")) break;
    madeCount++;
  }
}
return JsonConvert.SerializeObject(new Dictionary<string, object> {
  { "ok", madeCount > 0 || placed }, { "mode", "craft" }, { "craftedRations", madeCount },
  { "machinePlaced", placed }, { "log", log },
  { "ration", p.GetCurrency("ration") }, { "money", p.GetCurrency("money") },
  { "pcPos", p.pos.ToString() },
  { "hint", madeCount > 0 ? "rations crafted" : (placed ? "machine placed; ration recipe not learned yet - try gm_craft recipe=ration" : "machine not placed") }
});`;
      return { text: await withGame((port) => ev(port, code, 120000)) };
    }
    case 'gm_town': {
      const code = `
var p = EClass.pc;
var chars = EClass._map.charas.Where(c => c != null && c != p && !c.IsPCFaction && !p.party.members.Contains(c)).ToList();
var residents = chars.OrderBy(c => c.pos.Distance(p.pos)).Take(40).Select(c => new Dictionary<string, object> {
  { "name", c.Name }, { "id", c.id }, { "dist", c.pos.Distance(p.pos) },
  { "hostility", c.hostility.ToString() },
  { "merchant", c.trait is TraitMerchant },
  { "quest", c.quest == null ? null : c.quest.id },
  { "pos", c.pos.x + "/" + c.pos.z }
}).ToList();
var shops = chars.Where(c => c.trait is TraitMerchant).OrderBy(c => c.pos.Distance(p.pos)).Select(m => {
  Thing chest = m.things.Find("chest_merchant");
  if (chest == null) { try { m.trait.OnBarter(false); } catch (Exception ex) { } chest = m.things.Find("chest_merchant"); }
  var shelf = (chest != null && chest.things.Count > 0) ? chest.things.Where(t => t != null).ToList() : m.things.Where(t => t != null).ToList();
  return new Dictionary<string, object> {
    { "name", m.Name }, { "id", m.id }, { "dist", m.pos.Distance(p.pos) },
    { "ration", shelf.Any(t => t != null && t.id == "ration") },
    { "goods", shelf.Take(6).Select(t => new Dictionary<string, object> {
        { "name", t.Name }, { "id", t.id }, { "price", t.GetPrice(CurrencyType.Money, false, PriceType.Default, p) }
      }).ToList() }
  };
}).ToList();
int rationSellers = shops.Count(s => (bool)s["ration"]);
return JsonConvert.SerializeObject(new Dictionary<string, object> {
  { "zone", EClass._zone == null ? null : EClass._zone.id },
  { "zoneName", EClass._zone == null ? null : EClass._zone.Name },
  { "isTown", EClass._zone != null && EClass._zone.IsTown },
  { "mapSize", EClass._map.Size },
  { "residentCount", chars.Count },
  { "shopCount", shops.Count },
  { "rationSellers", rationSellers },
  { "shops", shops },
  { "residents", residents }
});`;
      const raw = await withGame((port) => ev(port, code, 30000));
      if (args.verbose) return { text: raw };
      const parsed = tryParse(raw);
      if (!parsed) return { text: raw };
      return { text: JSON.stringify(compactTown(parsed)) };
    }
    case 'gm_walk_map': {
      const action = ['go', 'enter', 'where'].includes(String(args.action)) ? String(args.action) : 'go';
      const zoneName = args.zone ? cs(args.zone) : 'null';
      const wx = Number.isFinite(Number(args.x)) ? Math.trunc(Number(args.x)) : -9999;
      const wz = Number.isFinite(Number(args.z)) ? Math.trunc(Number(args.z)) : -9999;
      const code = `
var p = EClass.pc;
string act = ${cs(action)};
string want = ${zoneName};
int wx = ${wx}, wz = ${wz};
var log = new List<string>();
bool isRegion = EClass._zone != null && EClass._zone.IsRegion;
if (!isRegion) {
  try { EClass.player.MoveZone(EClass.world.region); p.currentZone = EClass.world.region; log.Add("entered region"); } catch (Exception ex) { log.Add("region fail:" + ex.GetType().Name); }
}
var em = EClass.scene.elomapActor;
bool emActive = em != null && em.IsActive;
if (em != null && !emActive) {
  try { em.gameObject.SetActive(true); em.Initialize(EClass.world.region.elomap); emActive = em.IsActive; log.Add("elomap initialized"); } catch (Exception ex) { log.Add("elomap fail:" + ex.GetType().Name); }
}
if (act == "go") {
  Point pt = null;
  if (!string.IsNullOrEmpty(want)) {
    var reg = EClass.world.region;
    var z = reg.ListTowns().FirstOrDefault(t => t.id == want || (t.Name ?? "").Contains(want))
         ?? reg.ListRandomSites().FirstOrDefault(t => t.id == want || (t.Name ?? "").Contains(want))
         ?? reg.ListTravelZones().FirstOrDefault(t => t.id == want || (t.Name ?? "").Contains(want));
    if (z == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "zone not found: " + want }, { "log", log } });
    pt = z.RegionPos;
  } else if (wx > -9999 && wz > -9999) {
    pt = new Point(wx, wz);
  }
  if (pt == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "provide zone or x/z" }, { "log", log } });
  if (!pt.IsInBounds) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "out of bounds" }, { "pos", pt.ToString() }, { "log", log } });
  try { p.MoveImmediate(pt); } catch (Exception ex) { return JsonConvert.SerializeObject(new Dictionary<string, object> { { "ok", false }, { "reason", "move fail:" + ex.GetType().Name }, { "log", log } }); }
  p.RecalculateFOV();
  var at = EClass.world.region.GetZoneAt(pt.x, pt.z);
  log.Add("moved");
  return JsonConvert.SerializeObject(new Dictionary<string, object> {
    { "ok", true }, { "pos", p.pos.ToString() }, { "zoneAt", at == null ? null : at.id }, { "elomapActive", emActive }, { "log", log }
  });
}
if (act == "enter") {
  string err = null;
  try { EClass.player.EnterLocalZone(); } catch (Exception ex) { err = ex.GetType().Name + ": " + ex.Message; }
  return JsonConvert.SerializeObject(new Dictionary<string, object> {
    { "ok", err == null }, { "err", err }, { "zone", EClass._zone == null ? null : EClass._zone.id },
    { "isRegion", EClass._zone != null && EClass._zone.IsRegion }, { "pos", p.pos.ToString() }, { "log", log }
  });
}
return JsonConvert.SerializeObject(new Dictionary<string, object> {
  { "ok", true }, { "zone", EClass._zone == null ? null : EClass._zone.id }, { "isRegion", isRegion },
  { "pos", p.pos.ToString() }, { "elomapActive", emActive }, { "log", log }
});`;
      const first = await withGame((port) => ev(port, code, 30000));
      let parsed = null;
      try { parsed = JSON.parse(first); } catch { return { text: first }; }
      if (action === 'enter' && parsed && parsed.isRegion) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const st = JSON.parse(await withGame((p2) => ev(p2, 'return JsonConvert.SerializeObject(new Dictionary<string, object> { { "zone", EClass._zone == null ? null : EClass._zone.id }, { "isRegion", EClass._zone != null && EClass._zone.IsRegion }, { "pos", EClass.pc.pos.ToString() } });', 15000)));
          if (st && !st.isRegion) {
            try {
              await withGame((p2) => ev(p2, 'var p = EClass.pc; var z = EClass._zone; var sp = z == null ? null : z.GetSpawnPos(p); if (sp != null) p.pos.Set(sp.x, sp.z); p.RecalculateFOV(); try { EClass.ui.CloseLayers(); } catch (Exception ex) { } try { EClass.screen.FocusPC(); } catch (Exception ex) { } return "spawned";', 15000));
              st.pos = JSON.parse(await withGame((p2) => ev(p2, 'return JsonConvert.SerializeObject(new Dictionary<string, object> { { "pos", EClass.pc.pos.ToString() } });', 15000))).pos;
            } catch { /* best effort */ }
          }
          return { text: JSON.stringify({ ...parsed, after: st }) };
        } catch { /* ignore */ }
      }
      return { text: first };
    }
    case 'gm_repair': {
      const code = `
var p = EClass.pc;
var log = new List<string>();
try { p.global.transition = null; log.Add("transition cleared"); } catch (Exception ex) { }
try { EClass.ui.CloseLayers(); log.Add("layers closed"); } catch (Exception ex) { }
try { EClass.core.config.game.autopause = false; EClass.scene.paused = false; log.Add("unpaused"); } catch (Exception ex) { }
var em = EClass.scene.elomapActor;
bool isRegion = EClass._zone != null && EClass._zone.IsRegion;
if (isRegion && (em == null || !em.IsActive)) {
  try {
    if (em != null) { em.gameObject.SetActive(true); em.Initialize(EClass.world.region.elomap); log.Add("elomap reinitialized"); }
  } catch (Exception ex) { log.Add("elomap fail:" + ex.GetType().Name); }
}
bool mapBroken = EClass._map == null || EClass._map.zone == null || EClass._map.zone != EClass._zone;
if (mapBroken) {
  Zone target = null;
  try { target = p.homeZone; } catch (Exception ex) { }
  if (target == null) target = EClass.world.region.ListTowns().FirstOrDefault();
  if (target != null) {
    try {
      EClass.player.MoveZone(target);
      p.currentZone = target;
      var sp = target.GetSpawnPos(p);
      if (sp != null) p.pos.Set(sp.x, sp.z);
      log.Add("moved to " + target.id);
    } catch (Exception ex) { log.Add("move fail:" + ex.GetType().Name); }
  }
}
try { p.RecalculateFOV(); EClass.screen.FocusPC(); log.Add("fov+camera"); } catch (Exception ex) { log.Add("focus fail:" + ex.GetType().Name); }
try {
  var followers = new List<Chara>();
  if (p.parasite != null) followers.Add(p.parasite);
  if (p.ride != null) followers.Add(p.ride);
  foreach (var m in p.party.members) { if (m != null && m != p) followers.Add(m); }
  foreach (var f in followers) {
    if (f.currentZone != EClass._zone || !f.pos.IsInBounds) {
      try { EClass._zone.AddCard(f, p.pos.Copy()); f.currentZone = EClass._zone; log.Add("synced companion " + f.Name); } catch (Exception ex) { log.Add("sync fail " + f.Name + ":" + ex.GetType().Name); }
    }
  }
} catch (Exception ex) { log.Add("companions fail:" + ex.GetType().Name); }
return JsonConvert.SerializeObject(new Dictionary<string, object> {
  { "ok", true }, { "log", log },
  { "zone", EClass._zone == null ? null : EClass._zone.id },
  { "isRegion", isRegion },
  { "mapZone", EClass._map == null || EClass._map.zone == null ? null : EClass._map.zone.id },
  { "mapSize", EClass._map == null ? 0 : EClass._map.Size },
  { "pcPos", p.pos.ToString() },
  { "paused", EClass.scene.paused },
  { "elomapActive", EClass.scene.elomapActor == null ? false : EClass.scene.elomapActor.IsActive }
});`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    case 'gm_drama': {
      const action = String(args.action || 'read');
      const idx = Number.isFinite(Number(args.index)) ? Math.trunc(Number(args.index)) : -1;
      const want = args.text ? cs(args.text) : 'null';
      const code = `
var act = ${cs(action)};
int idx = ${idx};
string want = ${want};

var layer = EClass.ui.GetLayer<LayerDrama>();
if (layer != null && layer.drama != null) {
  var dm = layer.drama;
  string textMain = (dm.dialog == null || dm.dialog.textMain == null) ? null : dm.dialog.textMain.text;
  var uiButtons = new List<UIButton>();
  if (dm.dialog != null && dm.dialog.transChoices != null) {
    for (int i = 0; i < dm.dialog.transChoices.childCount; i++) {
      var tr = dm.dialog.transChoices.GetChild(i);
      if (tr == null || !tr.gameObject.activeSelf) continue;
      var ub = tr.GetComponent<UIButton>();
      if (ub != null) uiButtons.Add(ub);
    }
  }
  var choices = new List<object>();
  var seenChoices = new HashSet<string>();
  if (uiButtons.Count > 0) {
    for (int i = 0; i < uiButtons.Count; i++) {
      string raw = (uiButtons[i].mainText == null) ? "" : uiButtons[i].mainText.text;
      string clean = System.Text.RegularExpressions.Regex.Replace(raw ?? "", "<[^>]*>", "");
      if (!seenChoices.Add(clean)) continue;
      choices.Add(new Dictionary<string, object> { { "index", i }, { "text", raw }, { "label", clean } });
    }
  } else {
    for (int i = 0; i < dm._choices.Count; i++) {
      var c = dm._choices[i];
      if (c == null) continue;
      string key = (c.text ?? "") + "|" + (c.idJump ?? "");
      if (!seenChoices.Add(key)) continue;
      bool enabled = true;
      try { enabled = c.activeCondition == null || c.activeCondition(); } catch (Exception ex) { }
      choices.Add(new Dictionary<string, object> { { "index", i }, { "text", c.text }, { "enabled", enabled }, { "jump", c.idJump } });
    }
  }
  if (act == "close") { try { EClass.ui.CloseLayers(); } catch (Exception ex) { } return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", false }, { "closed", true } }); }
  if (act == "next") {
    bool okNext = false; string nextErr = null;
    try { dm.sequence.PlayNext(); okNext = true; } catch (Exception ex) { nextErr = ex.GetType().Name + ": " + ex.Message; }
    return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "advanced", okNext }, { "error", nextErr } });
  }
  if (act == "choose") {
    if (uiButtons.Count > 0) {
      int pick = idx;
      if (pick < 0 && !string.IsNullOrEmpty(want)) {
        for (int i = 0; i < uiButtons.Count; i++) {
          string raw = (uiButtons[i].mainText == null) ? "" : uiButtons[i].mainText.text;
          string label = System.Text.RegularExpressions.Regex.Replace(raw ?? "", "<[^>]*>", "");
          if (label.Contains(want)) { pick = i; break; }
        }
      }
      if (pick < 0 || pick >= uiButtons.Count) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "chosen", false }, { "reason", "choice not found" }, { "choices", choices } });
      var bt = uiButtons[pick];
      string btText = (bt.mainText == null) ? "" : bt.mainText.text;
      string btLabel = System.Text.RegularExpressions.Regex.Replace(btText ?? "", "<[^>]*>", "");
      try { bt.onClick.Invoke(); } catch (Exception ex) {
        return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "chosen", false }, { "error", ex.GetType().Name + ": " + ex.Message }, { "text", btLabel } });
      }
      return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "chosen", true }, { "text", btLabel } });
    }
    DramaChoice target = null;
    if (idx >= 0 && idx < dm._choices.Count) target = dm._choices[idx];
    if (target == null && !string.IsNullOrEmpty(want)) target = dm._choices.FirstOrDefault(c => c != null && (c.text ?? "").Contains(want));
    if (target == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "chosen", false }, { "reason", "choice not found" }, { "choices", choices } });
    var chosenText = target.text;
    try {
      if (target.button != null) target.button.onClick.Invoke();
      else if (target.onClick != null) target.onClick();
      else if (target.onJump != null) target.onJump();
      else if (!string.IsNullOrEmpty(target.idJump) && dm.setup != null) { dm.setup.step = target.idJump; dm.Play(dm.setup); }
      else return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "chosen", false }, { "reason", "choice has no handler" }, { "text", chosenText } });
    } catch (Exception ex) {
      return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "chosen", false }, { "error", ex.GetType().Name + ": " + ex.Message }, { "text", chosenText } });
    }
    return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "chosen", true }, { "text", chosenText } });
  }
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "drama" }, { "text", textMain }, { "choices", choices } });
}

var dlg = EClass.ui.GetLayer<Dialog>();
if (dlg != null) {
  var buttons = new List<UIButton>();
  if (dlg.list != null) {
    for (int i = 0; i < dlg.list.buttons.Count; i++) {
      var bp = dlg.list.buttons[i];
      var comp = bp.component as UIButton;
      buttons.Add(comp);
    }
  }
  var items = new List<object>();
  for (int i = 0; i < buttons.Count; i++) {
    var b = buttons[i];
    string t = (b == null || b.mainText == null) ? "" : b.mainText.text;
    items.Add(new Dictionary<string, object> { { "index", i }, { "text", t } });
  }
  string mainText = (dlg.textDetail == null) ? null : dlg.textDetail.text;
  if (act == "close") { try { dlg.Close(); } catch (Exception ex) { } return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", false }, { "closed", true } }); }
  if (act == "choose") {
    int pick = idx;
    if (pick < 0 && !string.IsNullOrEmpty(want)) {
      for (int i = 0; i < buttons.Count; i++) { var b = buttons[i]; if (b != null && b.mainText != null && (b.mainText.text ?? "").Contains(want)) { pick = i; break; } }
    }
    if (pick < 0 || pick >= buttons.Count || buttons[pick] == null) return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "dialog" }, { "chosen", false }, { "reason", "choice not found" }, { "choices", items } });
    var chosenText = buttons[pick].mainText == null ? "" : buttons[pick].mainText.text;
    try { buttons[pick].onClick.Invoke(); } catch (Exception ex) {
      return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "dialog" }, { "chosen", false }, { "error", ex.GetType().Name + ": " + ex.Message }, { "text", chosenText } });
    }
    return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "dialog" }, { "chosen", true }, { "text", chosenText } });
  }
  return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", true }, { "kind", "dialog" }, { "text", mainText }, { "choices", items } });
}
return JsonConvert.SerializeObject(new Dictionary<string, object> { { "active", false } });`;
      return { text: await withGame((port) => ev(port, code, 30000)) };
    }
    default:
      throw new Error('unknown tool: ' + name);
  }
}

// ---- minimal MCP stdio server ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const out = await callTool(name, args);
      const content = out.content || [{ type: 'text', text: String(out.text ?? '') }];
      send({ jsonrpc: '2.0', id, result: { content, isError: false } });
    } catch (error) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error?.message || error) }], isError: true } });
    }
    return;
  }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message || e) } }); });
  }
});
process.stdin.on('end', () => process.exit(0));
