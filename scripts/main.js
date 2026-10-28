import {MODULE_ID, registerSettings} from "./settings.js";
import {CHANNEL, handleSocket, onTrackersChanged, startEngine} from "./engine.js";
import {TrackerApp} from "./tracker-app.js";

const MODES = ["auto", "always", "dormant"];
const MODE_LABEL = {auto: "Auto", always: "Always moving", dormant: "Dormant"};
const MODE_ICON = {auto: "fa-wave-square", always: "fa-bolt", dormant: "fa-moon"};
const trackers = () => foundry.utils.deepClone(game.settings.get(MODULE_ID, "trackers"));

Hooks.once("init", registerSettings);

Hooks.once("ready", () => {
  game.socket.on(CHANNEL, (data, senderId) => {
    TrackerApp.receive(data);
    handleSocket(data, senderId);
  });
  startEngine(TrackerApp.receive);

  let prev = trackers();
  const changed = (setting) => {
    if (setting.key !== `${MODULE_ID}.trackers`) return;
    const next = trackers();
    for (const carrier of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      const was = prev[carrier]?.viewers.includes(game.userId);
      const is = next[carrier]?.viewers.includes(game.userId);
      if (game.user.isGM) continue; // the GM opens windows from the scene button
      if (is && !was) TrackerApp.open(carrier);
      else if (was && !is) TrackerApp.close(carrier);
    }
    TrackerApp.refresh();
    onTrackersChanged(prev, next);
    prev = next;
  };
  Hooks.on("createSetting", changed);
  Hooks.on("updateSetting", changed);
});

async function openTrackers() {
  const all = trackers();
  if (!game.user.isGM) {
    const mine = Object.keys(all).filter((c) => all[c].viewers.includes(game.userId));
    if (!mine.length) ui.notifications.warn("No motion tracker assigned");
    return mine.forEach((c) => TrackerApp.open(c));
  }
  const token = canvas.tokens.controlled[0]?.document;
  if (token) {
    const actor = token.actor;
    if (!actor) return ui.notifications.warn("That token has no actor");
    if (!all[actor.uuid]) {
      const owners = game.users.filter((u) => !u.isGM && actor.testUserPermission(u, "OWNER"));
      all[actor.uuid] = {locked: true, continuous: false, viewers: owners.map((u) => u.id)};
      await game.settings.set(MODULE_ID, "trackers", all);
    }
    return TrackerApp.open(actor.uuid);
  }
  const keys = Object.keys(all);
  if (!keys.length) ui.notifications.warn("No motion trackers yet. Select a character token to add one.");
  keys.forEach((c) => TrackerApp.open(c));
}

Hooks.on("getSceneControlButtons", (controls) => {
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools.motionTracker = {
    name: "motionTracker",
    title: "Motion Tracker",
    icon: "fa-solid fa-satellite-dish",
    order: Object.keys(tools).length,
    button: true,
    onChange: openTrackers,
  };
});

Hooks.on("renderTokenHUD", (hud, html) => {
  if (!game.user.isGM) return;
  const mode = hud.document.getFlag(MODULE_ID, "mode") ?? "auto";
  const label = `Motion: ${MODE_LABEL[mode]}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-icon${mode === "auto" ? "" : " active"}`;
  button.dataset.tooltip = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<i class="fa-solid ${MODE_ICON[mode]}" inert></i>`;
  button.addEventListener("click", async () => {
    await hud.document.setFlag(MODULE_ID, "mode", MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    hud.render();
  });
  html.querySelector(".col.left").append(button);
});
