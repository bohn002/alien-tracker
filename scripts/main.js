import {MODULE_ID, registerSettings} from "./settings.js";
import {CHANNEL, handleSocket, onTrackersChanged, startEngine} from "./engine.js";
import {TrackerApp} from "./tracker-app.js";
import {explainCard} from "./explain.js";

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

// Keep the Power meter in sync with the sheet.
Hooks.on("updateItem", (item) => {
  if (item.parent?.documentName === "Actor" && /motion tracker/i.test(item.name)) TrackerApp.refreshPower(item.parent.id);
});

// Dice 101: add a collapsible plain-language explanation to the Alien RPG roll cards.
// Read from what the card shows (dice faces), so it also works on old messages and on every client.
function readCard(root) {
  const count = (cls) => root.querySelectorAll(`.alien-diceface-${cls}`).length;
  const title = root.querySelector("h2")?.textContent.trim() ?? "";
  const [b6, b0, y6, y1, y0] = ["b6", "b0", "y6", "y1", "y0"].map(count);
  return {
    title,
    push: title.startsWith(game.i18n.localize("ALIENRPG.Push")),
    canPush: !!root.querySelector("button.alien-Push-button"),
    base: b6 + b0 ? {n: b6 + b0, sixes: b6} : null,
    stress: y6 + y1 + y0 ? {n: y6 + y1 + y0, ones: y1, sixes: y6} : null,
  };
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!game.settings.get(MODULE_ID, "explainRolls")) return;
  const root = html.querySelector(".chatBG");
  if (!root || root.querySelector(".mt-explain")) return;
  const card = readCard(root);
  if (!card.base && !card.stress) return;
  if (card.title.includes(game.i18n.localize("ALIENRPG.Radiation"))) return; // those cards already spell out the result
  const {tone, headline, lines} = explainCard(card);
  const box = document.createElement("details");
  box.className = `mt-explain ${tone}`;
  box.innerHTML = `<summary>What does this mean? ${headline}</summary><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;
  root.append(box);
});
