// Pure helpers first. No Foundry globals at module level, so node can import this file.
import {MODULE_ID} from "./settings.js";
import {powerCheck} from "./power.js";

export function band(d, {short, medium, long}) {
  if (d <= short) return "SHORT";
  if (d <= medium) return "MEDIUM";
  if (d <= long) return "LONG";
  return "EXTREME";
}

export function isMoving(mode, lastMovedMs, nowMs, windowMs) {
  if (mode === "always") return true;
  if (mode === "dormant") return false;
  return lastMovedMs != null && nowMs - lastMovedMs <= windowMs;
}

export function floorOffset(point, floors) {
  for (const f of floors) {
    if (point.x >= f.x && point.x <= f.x + f.w && point.y >= f.y && point.y <= f.y + f.h) {
      return {x: point.x - f.x, y: point.y - f.y, level: f.level};
    }
  }
  return {x: point.x, y: point.y, level: null};
}

export function toContact(origin, target, {gridSize, gridDistance, floorHeight}) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const horizontal = (Math.hypot(dx, dy) / gridSize) * gridDistance;
  const levelDiff = origin.level != null && target.level != null ? target.level - origin.level : 0;
  const vertical = levelDiff * floorHeight + ((target.elevation ?? 0) - (origin.elevation ?? 0));
  return {d: Math.hypot(horizontal, vertical), b: Math.atan2(dy, dx), elev: Math.sign(vertical)};
}

export function jitter(d, rand = Math.random) {
  return Math.max(0, Math.round(d + rand() * 2 - 1));
}

/* -------------------------------------------- */
/*  GM runtime (Foundry globals used only inside functions)  */
/* -------------------------------------------- */

export const CHANNEL = `module.${MODULE_ID}`;
const MAX_CONTACTS = 20;
const lastMoved = new Map(); // tokenId -> ms
const bursts = new Map(); // carrier uuid -> {left, glitch, timer}
const pending = new Set(); // carriers awaiting a power roll
let deliverLocal = () => {};

const setting = (key) => game.settings.get(MODULE_ID, key);
const trackers = () => setting("trackers");
const isActiveGM = () => game.users.activeGM?.isSelf === true;

// game.socket.emit does not echo to the sender, so the GM's own window gets it directly.
function send(packet) {
  game.socket.emit(CHANNEL, packet);
  deliverLocal(packet);
}

export function startEngine(deliver) {
  deliverLocal = deliver;
  Hooks.on("updateToken", (doc, changes) => {
    if (game.user.isGM && ("x" in changes || "y" in changes || "elevation" in changes)) {
      lastMoved.set(doc.id, Date.now());
    }
  });
  // A deleted character must not leave an orphan tracker (and a running burst) behind.
  Hooks.on("deleteActor", async (doc) => {
    if (!isActiveGM() || !trackers()[doc.uuid]) return;
    stop(doc.uuid, "OFFLINE");
    const all = foundry.utils.deepClone(trackers());
    delete all[doc.uuid];
    await game.settings.set(MODULE_ID, "trackers", all);
  });
  onTrackersChanged({}, trackers());
}

// A tracker belongs to a character: the carrier is that actor's token on the active scene (else any scene).
// An old-style token uuid key still resolves to that token.
function carrierToken(key) {
  const doc = fromUuidSync(key);
  if (doc?.documentName === "Token") return doc;
  if (!doc) return null;
  const on = (s) => s?.tokens.find((t) => t.actorId === doc.id);
  return on(game.scenes.active) ?? game.scenes.map(on).find(Boolean) ?? null;
}

function sweep(carrierUuid, glitch) {
  const carrier = carrierToken(carrierUuid);
  const scene = carrier?.parent;
  if (!scene) return false;
  const range = setting("range");
  const floors = [];
  for (const r of scene.regions) {
    const m = /^MT Level (\d+)/i.exec(r.name);
    if (m) floors.push({level: Number(m[1]), x: r.bounds.x, y: r.bounds.y, w: r.bounds.width, h: r.bounds.height});
  }
  const at = (t) => {
    const c = t.getCenterPoint();
    return {...floorOffset(c, floors), elevation: c.elevation};
  };
  const origin = at(carrier);
  const grid = {gridSize: scene.grid.size, gridDistance: scene.grid.distance, floorHeight: setting("floorHeight")};
  const bands = {short: setting("bandShort"), medium: setting("bandMedium"), long: setting("bandLong")};
  const windowMs = setting("motionWindow") * 1000;
  const includePCs = setting("includePCs");
  const now = Date.now();

  const found = [];
  for (const t of scene.tokens) {
    if (t.id === carrier.id) continue;
    if (!includePCs && t.actor?.hasPlayerOwner) continue;
    const mode = t.getFlag(MODULE_ID, "mode") ?? "auto";
    if (!isMoving(mode, lastMoved.get(t.id), now, windowMs)) continue;
    const c = toContact(origin, at(t), grid);
    if (c.d <= range) found.push({...c, band: band(c.d, bands)});
  }
  found.sort((a, b) => a.d - b.d);
  const jit = setting("jitter");
  const contacts = found.slice(0, MAX_CONTACTS).map(({d, b, band, elev}) => ({d: jit ? jitter(d) : d, b, band, elev}));
  send({type: "contacts", carrier: carrierUuid, units: scene.grid.units, glitch, contacts});
  return true;
}

function stop(carrier, text) {
  clearTimeout(bursts.get(carrier)?.timer);
  bursts.delete(carrier);
  send({type: "status", carrier, text});
}

export function startScan(carrier, glitch = false) {
  if (bursts.has(carrier)) return;
  const burst = {left: setting("burstSweeps"), glitch, timer: null};
  bursts.set(carrier, burst);
  const tick = () => {
    const t = trackers()[carrier];
    if (!isActiveGM() || !t || t.locked) return stop(carrier, "OFFLINE");
    if (!sweep(carrier, burst.glitch)) return stop(carrier, "NO SIGNAL");
    // Wait one more sweep before STANDBY so clients can finish drawing the last ring.
    if (--burst.left <= 0 && !t.continuous) burst.timer = setTimeout(() => stop(carrier, "STANDBY"), setting("sweepSeconds") * 1000);
    else burst.timer = setTimeout(tick, setting("sweepSeconds") * 1000);
  };
  tick();
}

async function handleScan(carrier, userId) {
  const t = trackers()[carrier];
  const user = game.users.get(userId);
  const token = carrierToken(carrier);
  if (!t || t.locked || !user || bursts.has(carrier) || pending.has(carrier)) return;
  if (!token) return send({type: "status", carrier, text: "NO SIGNAL"});
  if (!t.viewers.includes(userId) && !token.actor?.testUserPermission(user, "OWNER")) return;
  pending.add(carrier);
  try {
    const p = await powerCheck(token);
    if (p.dead) send({type: "status", carrier, text: "NO POWER"});
    else startScan(carrier, !!p.glitch);
  } finally {
    pending.delete(carrier);
  }
}

// Called on every client for every socket message; only the active GM acts on scan requests.
export function handleSocket(data, senderId) {
  // Foundry's module socket relays args as-is (the 2nd arg is not a user id), so trust the packet.
  // shortcut: a player could spoof another viewer's id; fine for a trusted table.
  if (data?.type === "scan" && isActiveGM()) handleScan(data.carrier, data.userId);
}

// Any client may press SCAN: the active GM runs it directly, everyone else asks over the socket.
export function requestScan(carrier) {
  if (isActiveGM()) handleScan(carrier, game.userId);
  else game.socket.emit(CHANNEL, {type: "scan", carrier, userId: game.userId});
}

export function onTrackersChanged(prev, next) {
  if (!isActiveGM()) return;
  for (const [carrier, t] of Object.entries(next)) {
    if (t.locked && !prev[carrier]?.locked) stop(carrier, "OFFLINE");
    else if (t.continuous && !t.locked) startScan(carrier);
  }
}
