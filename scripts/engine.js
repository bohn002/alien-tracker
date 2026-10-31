// Pure helpers first. No Foundry globals at module level, so node can import this file.
import {MODULE_ID} from "./settings.js";
import {powerCheck, rollPower, powerOf} from "./power.js";
import {facingAngle, inArc, jamNoise, mergeSwarms} from "./geometry.js";

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
const phantoms = new Map(); // carrier uuid -> [{d, b, left, until}] fake contacts the GM placed
let deliverLocal = () => {};

const setting = (key) => game.settings.get(MODULE_ID, key);
const trackers = () => setting("trackers");
const isActiveGM = () => game.users.activeGM?.isSelf === true;

// Only the GMs and the players the tracker is shown to receive its packets, so nobody else hears or sees it.
function audience(key) {
  const viewers = trackers()[key]?.viewers ?? [];
  return [...new Set([...game.users.filter((u) => u.isGM).map((u) => u.id), ...viewers])];
}

// game.socket.emit does not echo to the sender, so the GM's own window gets it directly.
function send(packet) {
  game.socket.emit(CHANNEL, packet, {recipients: audience(packet.carrier)});
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

const inRegion = (r, p) => (typeof r.testPoint === "function" ? r.testPoint(p) : r.bounds.contains(p.x, p.y));

function sweep(carrierUuid, glitch, mode = "omni") {
  const carrier = carrierToken(carrierUuid);
  const scene = carrier?.parent;
  if (!scene) return false;
  const dir = mode === "dir" && setting("directional");
  const range = setting("range") * (dir ? setting("arcRange") : 1);
  const facing = facingAngle(carrier.rotation ?? 0);
  const arc = dir ? (setting("arcWidth") * Math.PI) / 180 : null;
  const floors = [];
  for (const r of scene.regions) {
    const m = /^MT Level (\d+)/i.exec(r.name);
    if (m) floors.push({level: Number(m[1]), x: r.bounds.x, y: r.bounds.y, w: r.bounds.width, h: r.bounds.height});
  }
  const jams = setting("jamZones") ? scene.regions.filter((r) => /^MT Jam/i.test(r.name)) : [];
  const jammed = (t) => jams.some((r) => inRegion(r, t.getCenterPoint()));
  const at = (t) => {
    const c = t.getCenterPoint();
    return {...floorOffset(c, floors), elevation: c.elevation};
  };
  const origin = at(carrier);
  const carrierJammed = jammed(carrier);
  const grid = {gridSize: scene.grid.size, gridDistance: scene.grid.distance, floorHeight: setting("floorHeight")};
  const bands = {short: setting("bandShort"), medium: setting("bandMedium"), long: setting("bandLong")};
  const windowMs = setting("motionWindow") * 1000;
  const includePCs = setting("includePCs");
  const swarms = setting("swarms");
  const now = Date.now();

  let found = [];
  for (const t of scene.tokens) {
    if (t.id === carrier.id) continue;
    if (!includePCs && t.actor?.hasPlayerOwner) continue;
    const mode = t.getFlag(MODULE_ID, "mode") ?? "auto";
    if (!isMoving(mode, lastMoved.get(t.id), now, windowMs)) continue;
    let c = toContact(origin, at(t), grid);
    if (c.d > range || (dir && !inArc(c.b, facing, arc))) continue;
    if (carrierJammed || jammed(t)) c = {...c, ...jamNoise(c)}; // static scrambles the reading
    found.push({...c, band: band(c.d, bands), swarm: swarms ? t.getFlag(MODULE_ID, "swarm") || null : null});
  }
  if (swarms) found = mergeSwarms(found, bands.medium);
  // GM-placed phantoms count as contacts for a couple of sweeps.
  const fakes = (phantoms.get(carrierUuid) ?? []).filter((p) => p.left > 0 && p.until > now);
  for (const p of fakes) {
    p.left--;
    if (p.d <= range && (!dir || inArc(p.b, facing, arc))) found.push({d: p.d, b: p.b, elev: 0, band: band(p.d, bands)});
  }
  phantoms.set(carrierUuid, fakes.filter((p) => p.left > 0));
  found.sort((a, b) => a.d - b.d);
  const jit = setting("jitter");
  const contacts = found.slice(0, MAX_CONTACTS).map(({d, b, band, elev, n}) => ({d: jit ? jitter(d) : d, b, band, elev, ...(n ? {n} : {})}));
  send({type: "contacts", carrier: carrierUuid, units: scene.grid.units, glitch: glitch || carrierJammed, contacts, range, facing, arc});
  return true;
}

function stop(carrier, text) {
  clearTimeout(bursts.get(carrier)?.timer);
  bursts.delete(carrier);
  send({type: "status", carrier, text});
}

export function startScan(carrier, glitch = false, mode = "omni") {
  if (bursts.has(carrier)) return;
  const burst = {left: setting("burstSweeps"), glitch, mode, timer: null};
  bursts.set(carrier, burst);
  const tick = () => {
    const t = trackers()[carrier];
    if (!isActiveGM() || !t || t.locked) return stop(carrier, "OFFLINE");
    if (!sweep(carrier, burst.glitch, burst.mode)) return stop(carrier, "NO SIGNAL");
    // Wait one more sweep before STANDBY so clients can finish drawing the last ring.
    if (--burst.left <= 0 && !t.continuous) burst.timer = setTimeout(() => stop(carrier, "STANDBY"), setting("sweepSeconds") * 1000);
    else burst.timer = setTimeout(tick, setting("sweepSeconds") * 1000);
  };
  tick();
}

async function handleScan(carrier, userId, mode = "omni") {
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
    else startScan(carrier, !!p.glitch, mode === "dir" ? "dir" : "omni");
  } finally {
    pending.delete(carrier);
  }
}

// A manual Power Supply roll from the tracker panel. Same access rules as a scan, but allowed mid-scan.
async function handlePowerRoll(carrier, userId) {
  const t = trackers()[carrier];
  const user = game.users.get(userId);
  const token = carrierToken(carrier);
  if (!t || t.locked || !user || pending.has(carrier)) return;
  if (!token) return send({type: "status", carrier, text: "NO SIGNAL"});
  if (!t.viewers.includes(userId) && !token.actor?.testUserPermission(user, "OWNER")) return;
  pending.add(carrier);
  try {
    if (powerOf(token.actor) === null) return ui.notifications.warn(`No motion tracker item found on ${token.name}.`);
    const result = await rollPower(token);
    if (!result) return send({type: "powerResult", carrier, tone: "dead", headline: "DEAD: no power left", lines: ["Power is 0. Find a replacement battery cell or recharge it at a terminal."]});
    send({type: "powerResult", carrier, ...result});
    if (result.after <= 0) stop(carrier, "NO POWER");
  } finally {
    pending.delete(carrier);
  }
}

// Called on every client for every socket message; only the active GM acts on requests.
export function handleSocket(data, senderId) {
  // Foundry's module socket relays args as-is (the 2nd arg is not a user id), so trust the packet.
  // shortcut: a player could spoof another viewer's id; fine for a trusted table.
  if (!isActiveGM()) return;
  if (data?.type === "scan") handleScan(data.carrier, data.userId, data.mode);
  else if (data?.type === "phantom" && game.users.get(data.userId)?.isGM) addPhantom(data.carrier, data.d, data.b);
  else if (data?.type === "powerRoll") handlePowerRoll(data.carrier, data.userId);
}

// GM only: a fake contact that shows in the next sweeps (about 2 minutes to be used, 2 sweeps once it appears).
function addPhantom(carrier, d, b) {
  if (!trackers()[carrier] || !Number.isFinite(d) || !Number.isFinite(b)) return;
  phantoms.set(carrier, [...(phantoms.get(carrier) ?? []), {d, b, left: 2, until: Date.now() + 120000}]);
}

export function requestPhantom(carrier, d, b) {
  if (!game.user.isGM) return;
  if (isActiveGM()) addPhantom(carrier, d, b);
  else game.socket.emit(CHANNEL, {type: "phantom", carrier, userId: game.userId, d, b});
}

export function requestPowerRoll(carrier) {
  if (isActiveGM()) handlePowerRoll(carrier, game.userId);
  else game.socket.emit(CHANNEL, {type: "powerRoll", carrier, userId: game.userId});
}

// Any client may press SCAN: the active GM runs it directly, everyone else asks over the socket.
export function requestScan(carrier, mode = "omni") {
  if (isActiveGM()) handleScan(carrier, game.userId, mode);
  else game.socket.emit(CHANNEL, {type: "scan", carrier, userId: game.userId, mode});
}

export function onTrackersChanged(prev, next) {
  if (!isActiveGM()) return;
  for (const [carrier, t] of Object.entries(next)) {
    if (t.locked && !prev[carrier]?.locked) stop(carrier, "OFFLINE");
    else if (t.continuous && !t.locked) startScan(carrier);
  }
}
