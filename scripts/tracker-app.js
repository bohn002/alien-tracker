import {MODULE_ID} from "./settings.js";
import {requestScan, requestPowerRoll, requestPhantom} from "./engine.js";
import {maxPower, powerLevel, powerOf, setPower} from "./power.js";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;
const SIZE = 360;
const CENTER = SIZE / 2;
const RADIUS = CENTER - 10;
const FADE_SWEEPS = 1.5;
const apps = new Map(); // carrier uuid -> TrackerApp
const LEVEL_RGB = {dead: "90, 90, 90", red: "255, 74, 58", yellow: "255, 210, 58", green: "125, 255, 138"};
const TRAIL_SWEEPS = 6;
const setting = (key) => game.settings.get(MODULE_ID, key);

// Spatial audio: pan by the contact's bearing relative to where the token faces, muffle it when it is behind.
let audioCtx = null;
const buffers = new Map();
async function playPanned(src, pan, behind, volume) {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    if (!buffers.has(src)) buffers.set(src, fetch(src).then((r) => r.arrayBuffer()).then((b) => audioCtx.decodeAudioData(b)));
    const source = audioCtx.createBufferSource();
    source.buffer = await buffers.get(src);
    const panner = audioCtx.createStereoPanner();
    panner.pan.value = pan;
    const gain = audioCtx.createGain();
    gain.gain.value = volume * (behind ? 0.6 : 1);
    if (behind) {
      const muffle = audioCtx.createBiquadFilter();
      muffle.type = "lowpass";
      muffle.frequency.value = 700;
      source.connect(muffle).connect(panner);
    } else source.connect(panner);
    panner.connect(gain).connect(audioCtx.destination);
    source.start();
  } catch (err) {
    console.warn("hope-motion-tracker | panned audio failed, playing flat", err);
    foundry.audio.AudioHelper.play({src, volume, autoplay: true, loop: false}, false);
  }
}

// Scanlines are drawn once and stamped over every frame.
let scanlines = null;
function scanlinePattern(ctx) {
  if (!scanlines) {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 3;
    const g = c.getContext("2d");
    g.fillStyle = "rgba(0, 0, 0, 0.35)";
    g.fillRect(0, 2, 4, 1);
    scanlines = ctx.createPattern(c, "repeat");
  }
  return scanlines;
}

const bg = new Image();
bg.src = `modules/${MODULE_ID}/assets/m314_background.png`;

const trackerState = (uuid) => game.settings.get(MODULE_ID, "trackers")[uuid];

export class TrackerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["hope-motion-tracker"],
    position: {width: 360},
    actions: {
      scan: TrackerApp.#onScan,
      phantom: TrackerApp.#onPhantom,
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
  #range = null; // range of the scan on screen, since a directional scan reaches farther
  #arc = null; // {facing, width} while the last scan was directional
  #facing = -Math.PI / 2;
  #trail = [];
  #phantomMode = false;
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
      skin: setting("skin"),
      directional: setting("directional"),
      phantomMode: this.#phantomMode,
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
    this.element.querySelector("canvas")?.addEventListener("click", (ev) => this.#placePhantom(ev));
    this.element.classList.toggle("mt-phantom", this.#phantomMode);
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

  static #onScan(event, target) {
    requestScan(this.carrier, target?.dataset.mode);
  }

  static #onPhantom() {
    this.#phantomMode = !this.#phantomMode;
    this.render({parts: ["controls"]});
  }

  // GM clicked the screen while in phantom mode: turn the click into a distance and bearing.
  #placePhantom(ev) {
    if (!this.#phantomMode || !game.user.isGM) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * SIZE - CENTER;
    const y = ((ev.clientY - rect.top) / rect.height) * SIZE - CENTER;
    requestPhantom(this.carrier, Math.min(1, Math.hypot(x, y) / RADIUS), Math.atan2(y, x));
    this.#phantomMode = false;
    ui.notifications.info("Phantom contact placed: it shows on the next scans.");
    this.render({parts: ["controls"]});
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
    this.#arc = null;
    this.#trail = [];
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
    const range = (this.#range = p.range ?? setting("range"));
    this.#arc = p.arc ?? null;
    this.#facing = p.facing ?? -Math.PI / 2;
    this.#sweepMs = game.settings.get(MODULE_ID, "sweepSeconds") * 1000;
    this.#sweepStart = now;
    this.#units = p.units;
    this.#glitch = p.glitch;
    const wasScanning = this.#scanning;
    this.#scanning = true;
    this.#status = "SCANNING";
    this.#cues.push({at: now, src: game.settings.get(MODULE_ID, "soundWave")});
    for (const c of p.contacts) {
      const at = now + Math.min(1, c.d / range) * this.#sweepMs;
      this.#blips.push({...c, at});
      this.#trail.push({d: c.d, b: c.b, at});
    }
    const near = p.contacts[0];
    if (near) {
      const at = now + Math.min(1, near.d / range) * this.#sweepMs;
      const key = near.band === "SHORT" ? "soundClose" : near.band === "MEDIUM" ? "soundMedium" : "soundFar";
      const rel = near.b - this.#facing;
      this.#cues.push({at, src: setting(key), pan: Math.sin(rel), behind: Math.cos(rel) < 0});
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
    this.#trail = this.#trail.filter((t) => now - t.at < this.#sweepMs * TRAIL_SWEEPS);
    this.#cues = this.#cues.filter((c) => {
      if (c.at > now) return true;
      const volume = setting("volume");
      if (c.pan !== undefined && setting("panning")) playPanned(c.src, c.pan, c.behind, volume);
      else foundry.audio.AudioHelper.play({src: c.src, volume, autoplay: true, loop: false}, false);
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
    const range = this.#range ?? setting("range");
    const crt = setting("skin") === "crt";
    const rgb = LEVEL_RGB[this.#level] ?? LEVEL_RGB.green;
    const idle = !this.#scanning && (this.#status === "STANDBY" || this.#status === "OFFLINE");
    const wobble = idle && setting("idleGlitch") ? 1 + 0.006 * Math.sin(now / 650) : 1; // the rings breathe slightly
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (crt) {
      const glow = ctx.createRadialGradient(CENTER, CENTER, 10, CENTER, CENTER, CENTER * 1.3);
      glow.addColorStop(0, "#1d6a28");
      glow.addColorStop(0.7, "#0e3a16");
      glow.addColorStop(1, "#031207");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, SIZE, SIZE);
    } else {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, SIZE, SIZE);
      if (bg.complete && bg.naturalWidth) {
        const {naturalWidth: w, naturalHeight: h} = bg; // image is not square: crop the centre
        ctx.drawImage(bg, 0, (h - w) / 2, w, w, 0, 0, SIZE, SIZE);
      }
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(0, 0, SIZE, SIZE);
    }

    // Range rings, dashed like the screen in the films on the CRT skin.
    ctx.lineWidth = 1;
    ctx.strokeStyle = crt ? `rgba(${rgb}, 0.4)` : "rgba(255, 176, 0, 0.3)";
    ctx.setLineDash(crt ? [5, 6] : []);
    for (const key of ["bandShort", "bandMedium", "bandLong"].map((k) => setting(k)).concat(range)) {
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, Math.min(1, key / range) * RADIUS * wobble, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Directional scan: show the cone so it is obvious this was not a 360 degree read.
    if (this.#arc) {
      const {facing, width} = this.#arc;
      ctx.strokeStyle = `rgba(${rgb}, 0.9)`;
      ctx.fillStyle = `rgba(${rgb}, 0.08)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(CENTER, CENTER);
      ctx.arc(CENTER, CENTER, RADIUS, facing - width / 2, facing + width / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    const p = (now - this.#sweepStart) / this.#sweepMs;
    if (p >= 0 && p <= 1) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${crt ? rgb : LEVEL_RGB[this.#level] ?? "255, 200, 60"}, 0.8)`;
      ctx.beginPath();
      if (this.#arc) ctx.arc(CENTER, CENTER, p * RADIUS, this.#arc.facing - this.#arc.width / 2, this.#arc.facing + this.#arc.width / 2);
      else ctx.arc(CENTER, CENTER, p * RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }

    const at = (d, b) => [CENTER + Math.cos(b) * Math.min(1, d / range) * RADIUS, CENTER + Math.sin(b) * Math.min(1, d / range) * RADIUS]; // map y grows downward, so north stays up
    if (setting("trails")) {
      for (const t of this.#trail) {
        const age = now - t.at;
        if (age < 0) continue;
        const [x, y] = at(t.d, t.b);
        ctx.fillStyle = `rgba(${rgb}, ${0.28 * (1 - age / (this.#sweepMs * TRAIL_SWEEPS))})`;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.font = "14px monospace";
    for (const b of this.#blips) {
      const age = now - b.at;
      if (age < 0) continue;
      const a = 1 - age / fade;
      const [x, y] = at(b.d, b.b);
      const size = b.n ? 18 : 12;
      const g = ctx.createRadialGradient(x, y, 0, x, y, size);
      g.addColorStop(0, `rgba(${rgb}, ${a})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${rgb}, ${a})`;
      if (b.elev) ctx.fillText(b.elev > 0 ? "▲" : "▼", x + 8, y - 8);
      if (b.n) ctx.fillText(`x${b.n}`, x + 12, y + 4); // a swarm that has not split yet
    }

    if (this.#glitch) {
      ctx.fillStyle = `rgba(125, 255, 138, ${0.04 + Math.random() * 0.06})`;
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < 25; i++) {
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.25})`;
        ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 20 + Math.random() * 120, 1 + Math.random() * 2);
      }
    } else if (idle && setting("idleGlitch")) this.#idleGlitch(ctx, now, rgb);

    if (crt) {
      ctx.fillStyle = scanlinePattern(ctx);
      ctx.fillRect(0, 0, SIZE, SIZE);
      const vignette = ctx.createRadialGradient(CENTER, CENTER, SIZE * 0.35, CENTER, CENTER, SIZE * 0.72);
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(1, "rgba(0, 0, 0, 0.65)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
  }

  // Subtle life while the window is just sitting there: a slow rolling band, speckle, and now and then a tear or flicker.
  #idleGlitch(ctx, now, rgb) {
    const y = (now / 35) % (SIZE + 80) - 40;
    const band = ctx.createLinearGradient(0, y - 30, 0, y + 30);
    band.addColorStop(0, `rgba(${rgb}, 0)`);
    band.addColorStop(0.5, `rgba(${rgb}, 0.06)`);
    band.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = band;
    ctx.fillRect(0, y - 30, SIZE, 60);
    for (let i = 0; i < 10; i++) {
      ctx.fillStyle = `rgba(${rgb}, ${Math.random() * 0.18})`;
      ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 1 + Math.random() * 2, 1);
    }
    if (Math.random() < 0.025) {
      const ty = Math.random() * SIZE;
      const h = 4 + Math.random() * 10;
      ctx.drawImage(ctx.canvas, 0, ty, SIZE, h, (Math.random() - 0.5) * 14, ty, SIZE, h); // a horizontal tear
    }
    if (Math.random() < 0.006) {
      ctx.fillStyle = `rgba(${rgb}, 0.07)`;
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
  }
}
