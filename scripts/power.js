export async function powerCheck(carrier) {
  if (!game.settings.get("hope-motion-tracker", "rollPower")) return {ok: true};
  const actor = carrier.actor;
  const item = actor?.items.find((i) => /motion tracker/i.test(i.name));
  if (!item) {
    ui.notifications.warn(`No motion tracker item found on ${carrier.name}; scanning without a power roll.`);
    return {ok: true};
  }
  const before = Number(item.system.attributes.power.value) || 0;
  if (before <= 0) return {dead: true};

  // The system's own roll posts to chat and writes each 1 to r2One. Reset it so a roll that
  // aborts early cannot leave a stale count from an earlier roll.
  game.alienrpg.rollArr.r2One = 0;
  await actor.consumablesCheck(actor, "power", item.name, item.id, {}, 0);
  const ones = Number(game.alienrpg.rollArr.r2One) || 0;

  // The system does not await its item update, so derive the new power instead of re-reading it.
  if (before - ones <= 0) return {dead: true};
  return {ok: true, glitch: ones > 0};
}
