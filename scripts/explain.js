// Plain-language explanation of the tracker's Power check (dice cards live in the explain-my-roll module). Pure functions, no Foundry globals, so node can test them.

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
