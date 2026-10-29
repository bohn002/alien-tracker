// Plain-language explanations of dice results. Pure functions, no Foundry globals, so node can test them.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Power Supply roll for the tracker: roll dice equal to Power, each 1 drains one charge.
export function explainPower({before, ones}) {
  const after = Math.max(0, before - ones);
  const rule = "Rule: each 1 drains 1 Power. 2 to 6 do nothing. At 0 the tracker is dead until you find a fresh battery.";
  let tone, headline, lines;
  if (after <= 0) {
    tone = "dead";
    headline = "DEAD: the battery is exhausted";
    lines = [
      `You rolled ${plural(before, "die", "dice")} and ${plural(ones, "one")} drained all the charge.`,
      "The screen goes black and the audio dies. The tracker can't be used until the crew finds a replacement battery cell or recharges it at a terminal.",
    ];
  } else if (ones === 0) {
    tone = "fine";
    headline = `FINE: Power holds at ${after}`;
    lines = [`You rolled ${plural(before, "die", "dice")} and got no 1s, so nothing was drained.`];
  } else {
    tone = after === 1 ? "low" : "drain";
    headline = `${after === 1 ? "LOW" : "DRAINING"}: Power ${before} → ${after}`;
    lines = [
      `You rolled ${plural(before, "die", "dice")} and got ${plural(ones, "one")}, so ${ones === 1 ? "1 charge" : `${ones} charges`} drained.`,
      after === 1
        ? "One charge left. The next Power roll rolls just 1 die, and a 1 kills it."
        : "Still working. Fewer charges means fewer dice next time, so it drains more slowly but has less left.",
    ];
  }
  return {before, ones, after, tone, headline, lines: [...lines, rule]};
}

// Reads of a chat card from the Alien RPG system.
// card = {title, push, canPush, base: {n, sixes} | null, stress: {n, ones, sixes} | null}
export function explainCard(card) {
  const {base, stress} = card;
  const sixes = (base?.sixes ?? 0) + (stress?.sixes ?? 0);
  const lines = [];

  if (!base) {
    // Stress dice only: a Supply roll. Each 1 uses up one point of that supply.
    const ones = stress?.ones ?? 0;
    return {
      tone: ones ? "warn" : "fine",
      headline: ones ? `Supply drops by ${ones}` : "Supply holds",
      lines: [
        `Supply rolls use dice equal to the supply rating. Each 1 uses up 1 point; you rolled ${plural(ones, "one")}.`,
        ones ? "The sheet's supply is reduced for you." : "No 1s, so nothing was used up.",
      ],
    };
  }

  let tone = sixes ? "fine" : "bad";
  const headline = sixes
    ? `SUCCESS: ${plural(sixes, "six", "sixes")}`
    : "FAIL: no sixes";
  lines.push(
    sixes
      ? "One 6 is enough to succeed at most actions."
      : "You need at least one 6 on any die to succeed.",
  );
  if (sixes > 1) lines.push(`Each extra 6 beyond the first is a stunt: ${sixes - 1} to spend on a bonus effect.`);

  if (stress && stress.n > 0) {
    if (stress.ones > 0) {
      tone = "warn";
      lines.push(`${plural(stress.ones, "stress die", "stress dice")} show a 1 (facehugger): you must make a Panic roll.`);
    } else {
      lines.push("No 1s on the yellow stress dice, so no Panic roll.");
    }
  }
  if (card.push) lines.push("This is a pushed roll: dice that weren't 6 were rerolled and you gained 1 Stress Level. Totals include the sixes from before the push.");
  else if (card.canPush) lines.push(`If you don't like it you can Push once: reroll every die that isn't a 6, but gain +1 Stress Level${sixes ? "" : ". Pushing is the only way to rescue a failed roll"}.`);

  lines.push("Legend: black dice are your base dice (6 = success, 1 = nothing). Yellow dice are stress dice (6 = success, 1 = panic).");
  return {tone, headline, lines};
}
