import {MODULE_ID} from "./settings.js";
import {explainPower} from "./explain.js";

// Tracker battery size, a world setting (default 5).
export const maxPower = () => game.settings.get(MODULE_ID, "maxPower");
export const powerLevel = (v) => (v <= 0 ? "dead" : v === 1 ? "red" : v <= 3 ? "yellow" : "green");

export const trackerItem = (actor) => actor?.items.find((i) => /motion tracker/i.test(i.name));

// Current Power of the actor's tracker item, or null if the actor has none.
export function powerOf(actor) {
  const item = trackerItem(actor);
  return item ? Number(item.system.attributes.power.value) || 0 : null;
}

// Set the tracker's Power and keep the sheet's Power consumable (the total over all items) in step.
export async function setPower(actor, value) {
  const item = trackerItem(actor);
  const before = powerOf(actor);
  if (!item) return;
  value = Math.min(maxPower(), Math.max(0, Math.round(value)));
  await item.update({"system.attributes.power.value": value});
  const total = Number(actor.system.consumables?.power?.value);
  if (Number.isFinite(total)) await actor.update({"system.consumables.power.value": Math.max(0, total + value - before)});
}

// Roll dice equal to the tracker's Power (rules: each 1 drains 1 Power), save the result and post a chat card.
export async function rollPower(carrier) {
  const actor = carrier.actor;
  const item = trackerItem(actor);
  const before = powerOf(actor);
  if (!item || before <= 0) return null;

  const roll = await new Roll(`${before}ds`).evaluate();
  const ones = roll.dice[0].results.filter((r) => r.result === 1).length;
  const result = explainPower({before, ones});

  await setPower(actor, result.after);

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({actor}),
    flavor: `<h3>${item.name}: Power check</h3><strong>${result.headline}</strong><ul>${result.lines.map((l) => `<li>${l}</li>`).join("")}</ul>`,
  });
  return result;
}

// Run before a SCAN. A dead battery always blocks; the optional "Roll for power" setting rolls it first.
export async function powerCheck(carrier) {
  const before = powerOf(carrier.actor);
  if (before === null) {
    if (game.settings.get(MODULE_ID, "rollPower")) ui.notifications.warn(`No motion tracker item found on ${carrier.name}; scanning without a power roll.`);
    return {ok: true};
  }
  if (before <= 0) return {dead: true};
  if (!game.settings.get(MODULE_ID, "rollPower")) return {ok: true};
  const r = await rollPower(carrier);
  return r.after <= 0 ? {dead: true} : {ok: true, glitch: r.ones > 0};
}
