import {MODULE_ID} from "./settings.js";
import {requestScan, requestPowerRoll} from "./engine.js";
import {maxPower, powerLevel, powerOf, setPower} from "./power.js";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;
const SIZE = 360;
const CENTER = SIZE / 2;
const RADIUS = CENTER - 10;
const FADE_SWEEPS = 1.5;
const apps = new Map(); // carrier uuid -> TrackerApp
const LEVEL_RGB = {dead: "90, 90, 90", red: "255, 74, 58", yellow: "255, 210, 58", green: "125, 255, 138"};
const bg = new Image();
bg.src = `modules/${MODULE_ID}/assets/m314_background.png`;

const trackerState = (uuid) => game.settings.get(MODULE_ID, "trackers")[uuid];

export class TrackerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["hope-motion-tracker"],
    position: {width: 360},
    actions: {
      scan: TrackerApp.#onScan,
      power: TrackerApp.#onPower,
      powerDown: TrackerApp.#onPowerStep,
      powerUp: TrackerApp.#onPowerStep,
      recharge: TrackerApp.#onRecharge,
      lock: TrackerApp.#onLock,
      continuous: TrackerApp.#onContinuous,
    },
  };

  static PARTS = {
    screen: {template: `modules/${MODULE_ID}/templates/tracker.hbs`},
    controls: {template: `modules/${MODULE_ID}/templates/tracker-controls.hbs`},
  };

  static open(carrier) {
    let app = apps.get(carrier);
    if (!app) apps.set(carrier, (app = new TrackerApp(carrier)));
    app.render({force: true});
  }

  static close(carrier) {
    apps.get(carrier)?.close();
  }

  // Called when the trackers setting changes: refresh the controls and the OFFLINE/STANDBY state.
  static refreshPower(actorId) {
    for (const app of apps.values()) if (app.carrier.endsWith(actorId)) app.render({parts: ["controls"]});
  }

  static refresh() {
    for (const app of apps.values()) {
      app.#sync();
      app.render({parts: ["controls"]});
    }
  }

  static receive(packet) {
    apps.get(packet.carrier)?.#receive(packet);
  }

  carrier;
  #status = "STANDBY";
  #scanning = false;
  #glitch = false;
  #raf = null;
  #units = "m";
  #sweepStart = -Infinity;
  #sweepMs = 2000;
  #blips = [];
  #cues = [];
  #nearest = null; // {text, at, until}
  #shown = {};
  #powerResult = null;
  #level = null; // dead|red|yellow|green once the viewer can see the tracker item

  constructor(carrier) {
    const name = fromUuidSync(carrier)?.name ?? "Unknown";
    super({id: `${MODULE_ID}-${carrier.replace(/\W/g, "-")}`, window: {title: `Motion Tracker: ${name}`}});
    this.carrier = carrier;
  }

  async _prepareContext() {
    const t = trackerState(this.carrier);
    const actor = fromUuidSync(this.carrier);
    const power = actor?.testUserPermission?.(game.user, "OBSERVER") ? powerOf(actor) : null;
    this.#level = power === null ? null : powerLevel(power);
    return {
      power: power === null ? null : {value: power, level: powerLevel(power), atMax: power >= maxPower(), cells: Array.from({length: maxPower()}, (_, i) => i < power)},
      powerResult: this.#powerResult,
      powerDisabled: !t || t.locked,
      isGM: game.user.isGM,
      locked: t?.locked ?? true,
      continuous: !!t?.continuous,
      scanDisabled: !t || t.locked || this.#scanning,
      users: game.users.filter((u) => !u.isGM).map((u) => ({id: u.id, name: u.name, checked: !!t?.viewers.includes(u.id)})),
    };
  }

  _onRender() {
    for (const box of this.element.querySelectorAll("[data-viewer]")) {
      box.addEventListener("change", () => {
        const id = box.dataset.viewer;
        this.#edit((t) => {
          t.viewers = t.viewers.filter((v) => v !== id);
          if (box.checked) t.viewers.push(id);
        });
      });
    }
    this.#shown = {}; // the DOM was replaced, so rewrite the readout and status
    this.#sync();
    this.#raf ??= requestAnimationFrame(this.#frame);
  }

  _onClose() {
    cancelAnimationFrame(this.#raf);
    this.#raf = null;
    apps.delete(this.carrier);
  }

  async #edit(fn) {
    const all = foundry.utils.deepClone(game.settings.get(MODULE_ID, "trackers"));
    if (!all[this.carrier]) return;
    fn(all[this.carrier]);
    await game.settings.set(MODULE_ID, "trackers", all);
  }

  static #onScan() {
    requestScan(this.carrier);
  }

  static #onPower() {
    requestPowerRoll(this.carrier);
  }

  // GM only (the buttons are not drawn for players).
  static #onPowerStep(event, target) {
    if (!game.user.isGM) return;
    const actor = fromUuidSync(this.carrier);
    setPower(actor, powerOf(actor) + (target.dataset.action === "powerUp" ? 1 : -1));
  }

  static #onRecharge() {
    if (game.user.isGM) setPower(fromUuidSync(this.carrier), maxPower());
  }

  static #onLock() {
    this.#edit((t) => (t.locked = !t.locked));
  }

  static #onContinuous() {
    this.#edit((t) => (t.continuous = !t.continuous));
  }

  #sync() {
    const t = trackerState(this.carrier);
    if (!t || t.locked) this.#goDark("OFFLINE");
    else if (this.#status === "OFFLINE") this.#status = "STANDBY";
  }

  #goDark(text) {
    this.#blips = [];
    this.#cues = [];
    this.#nearest = null;
    this.#scanning = this.#glitch = false;
    this.#status = text;
  }

  #receive(p) {
    const now = performance.now();
    if (p.type === "status") {
      if (p.text === "OFFLINE" || p.text === "NO POWER") this.#goDark(p.text);
      else {
        this.#scanning = this.#glitch = false;
        this.#status = p.text;
      }
      return this.render({parts: ["controls"]});
    }
    if (p.type === "powerResult") {
      this.#powerResult = p;
      return this.render({parts: ["controls"]});
    }
    if (p.type !== "contacts") return; // e.g. a player's scan request, which the engine handles
    const range = game.settings.get(MODULE_ID, "range");
    this.#sweepMs = game.settings.get(MODULE_ID, "sweepSeconds") * 1000;
    this.#sweepStart = now;
    this.#units = p.units;
    this.#glitch = p.glitch;
    const wasScanning = this.#scanning;
    this.#scanning = true;
    this.#status = "SCANNING";
    this.#cues.push({at: now, src: game.settings.get(MODULE_ID, "soundWave")});
    for (const c of p.contacts) {
      this.#blips.push({...c, at: now + Math.min(1, c.d / range) * this.#sweepMs});
    }
    const near = p.contacts[0];
    if (near) {
      const at = now + Math.min(1, near.d / range) * this.#sweepMs;
      const key = near.band === "SHORT" ? "soundClose" : near.band === "MEDIUM" ? "soundMedium" : "soundFar";
      this.#cues.push({at, src: game.settings.get(MODULE_ID, key)});
      this.#nearest = {text: `${Math.round(near.d)}${p.units} · ${near.band}`, at, until: at + FADE_SWEEPS * this.#sweepMs};
    } else this.#nearest = null;
    if (!wasScanning) this.render({parts: ["controls"]});
  }

  #frame = (now) => {
    this.#raf = requestAnimationFrame(this.#frame);
    const canvas = this.element.querySelector("canvas");
    if (!canvas) return;

    // A burst whose STANDBY packet never arrived (GM reloaded) must not leave SCAN greyed out.
    if (this.#scanning && now - this.#sweepStart > this.#sweepMs * 2.5) {
      this.#scanning = this.#glitch = false;
      this.#status = "STANDBY";
      this.render({parts: ["controls"]});
    }
    const fade = this.#sweepMs * FADE_SWEEPS;
    this.#blips = this.#blips.filter((b) => now - b.at < fade);
    this.#cues = this.#cues.filter((c) => {
      if (c.at > now) return true;
      foundry.audio.AudioHelper.play({src: c.src, volume: game.settings.get(MODULE_ID, "volume"), autoplay: true, loop: false}, false);
      return false;
    });
    this.#draw(canvas.getContext("2d"), now, fade);

    const readout = this.#nearest && now >= this.#nearest.at && now < this.#nearest.until ? this.#nearest.text : "--";
    this.#write("readout", readout);
    this.#write("status", this.#status);
  };

  #write(key, text) {
    if (this.#shown[key] === text) return;
    this.#shown[key] = text;
    const el = this.element.querySelector(`[data-${key}]`);
    if (el) {
      el.textContent = text;
      el.dataset.state = text; // lets CSS pulse STANDBY
    }
  }

  #draw(ctx, now, fade) {
    const range = game.settings.get(MODULE_ID, "range");
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (bg.complete && bg.naturalWidth) {
      const {naturalWidth: w, naturalHeight: h} = bg; // image is not square: crop the centre
      ctx.drawImage(bg, 0, (h - w) / 2, w, w, 0, 0, SIZE, SIZE);
    }
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 176, 0, 0.3)";
    for (const key of ["bandShort", "bandMedium", "bandLong"].map((k) => game.settings.get(MODULE_ID, k)).concat(range)) {
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, Math.min(1, key / range) * RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }

    const p = (now - this.#sweepStart) / this.#sweepMs;
    if (p >= 0 && p <= 1) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${LEVEL_RGB[this.#level] ?? "255, 200, 60"}, 0.8)`;
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, p * RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }

    const rgb = LEVEL_RGB[this.#level] ?? LEVEL_RGB.green;
    ctx.font = "14px monospace";
    for (const b of this.#blips) {
      const age = now - b.at;
      if (age < 0) continue;
      const a = 1 - age / fade;
      const r = Math.min(1, b.d / range) * RADIUS;
      const x = CENTER + Math.cos(b.b) * r; // map y grows downward, so north stays up
      const y = CENTER + Math.sin(b.b) * r;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 12);
      g.addColorStop(0, `rgba(${rgb}, ${a})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();
      if (b.elev) {
        ctx.fillStyle = `rgba(${rgb}, ${a})`;
        ctx.fillText(b.elev > 0 ? "▲" : "▼", x + 8, y - 8);
      }
    }

    if (this.#glitch) {
      ctx.fillStyle = `rgba(125, 255, 138, ${0.04 + Math.random() * 0.06})`;
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < 25; i++) {
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.25})`;
        ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 20 + Math.random() * 120, 1 + Math.random() * 2);
      }
    }
  }
}
