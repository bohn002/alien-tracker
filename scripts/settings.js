export const MODULE_ID = "hope-motion-tracker";

const sound = (file) => `modules/${MODULE_ID}/assets/sounds/${file}.ogg`;

export function registerSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, data);
  const world = (key, name, hint, type, value, extra = {}) =>
    reg(key, {name, hint, scope: "world", config: true, type, default: value, ...extra});

  world("range", "Scanner range (m)", "Tokens farther than this are ignored.", Number, 50);
  world("bandShort", "Short band (m)", "Up to this distance a contact reads SHORT. Includes Engaged range.", Number, 10);
  world("bandMedium", "Medium band (m)", "Up to this distance a contact reads MEDIUM.", Number, 25);
  world("bandLong", "Long band (m)", "Up to this distance a contact reads LONG. Beyond it, EXTREME.", Number, 50);
  world("sweepSeconds", "Seconds per sweep", "Time for one sweep of the scanner ring.", Number, 2);
  world("burstSweeps", "Sweeps per scan", "Sweeps run by one SCAN press before the scanner goes to standby.", Number, 3);
  world("motionWindow", "Motion window (s)", "A token that moved within this many seconds counts as moving.", Number, 30);
  world("includePCs", "Detect player characters", "Player-owned tokens that move nearby also show on the scanner.", Boolean, true);
  world("floorHeight", "Floor height (m)", "Vertical distance between floor regions on the same scene.", Number, 3);
  world("jitter", "Readout jitter", "Show the distance readout with a random error of plus or minus 1m.", Boolean, true);
  world("rollPower", "Roll for power", "Each SCAN first rolls the tracker's power supply.", Boolean, false);
  world("soundWave", "Sweep sound", "Sound played on each sweep.", String, sound("wave"), {filePicker: "audio"});
  world("soundClose", "Close ping sound", "Sound played for a contact in the short band.", String, sound("close"), {filePicker: "audio"});
  world("soundMedium", "Medium ping sound", "Sound played for a contact in the medium band.", String, sound("medium"), {filePicker: "audio"});
  world("soundFar", "Far ping sound", "Sound played for a contact in the long or extreme band.", String, sound("far"), {filePicker: "audio"});

  reg("explainRolls", {
    name: "Explain dice rolls",
    hint: "Add a short plain-language explanation under each Alien RPG roll card in chat (on this client).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  reg("trackers", {scope: "world", config: false, type: Object, default: {}});

  reg("volume", {
    name: "Scanner volume",
    hint: "Volume of the scanner sounds on this client.",
    scope: "client",
    config: true,
    type: Number,
    default: 0.8,
    range: {min: 0, max: 1, step: 0.05},
  });
}
