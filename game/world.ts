/**
 * THE FIRST BANK OF FRIENDS - a banking hall on the SDK's 576 x 384 ground plane.
 *
 * The supplied presets are gardens, rooftops and caverns; none of them is a bank.
 * WORLD_RULES.md explicitly allows authoring your own scene in the SDK world format,
 * so this is a custom world built from the same vocabulary the presets use:
 * a ground polygon, floor patches, walking paths, props and actors.
 *
 * Reading the room, in plan:
 *
 *        back wall  ---- TELLERS ----          [ VAULT ]
 *          |  desk                                  |
 *        column        (marble floor)          column
 *          |        benches      benches            |
 *        ------------- ENTRANCE ------------- ledger
 */
export const BANK_WORLD = {
  id: "first-bank-of-friends",
  family: "bank-hall",
  name: "The First Bank of Friends",
  setting: "Banking hall",
  shape: "Chamfered hall",
  summary: "A marble hall with three teller windows, a vault, a trading desk and a ledger.",
  variant: "complete",
  missingChunks: [] as number[],

  // A chamfered rectangle reads as architecture rather than landscape.
  geometry: {
    polygons: [[
      [72, 24], [504, 24], [552, 72], [552, 300],
      [504, 348], [336, 372], [240, 372], [72, 348],
      [24, 300], [24, 72],
    ]],
    holes: [],
    depth: 22,
  },

  // Marble. `grid` reads as tiling, `dither` as the inlaid runner down the middle.
  patches: [
    { x: 60, y: 48, w: 456, h: 96, pattern: "grid" },
    { x: 60, y: 240, w: 456, h: 96, pattern: "grid" },
    { x: 246, y: 140, w: 84, h: 200, pattern: "dither" },
    { x: 404, y: 44, w: 120, h: 92, pattern: "dense" },
  ],

  // The queue line: door to teller, then the branch to vault and desk.
  paths: [
    { points: [[288, 344], [288, 150], [288, 108]], width: 26 },
    { points: [[288, 168], [452, 168], [452, 112]], width: 20 },
    { points: [[288, 200], [132, 200], [132, 150]], width: 20 },
    { points: [[288, 300], [452, 300]], width: 18 },
  ],

  props: [
    // --- the teller counter: three windows across the back wall ---
    { type: "terminal", x: 288, y: 62, scale: 2.0 },   // the teller counter, one big landmark

    // --- the vault, right side. A tank is the only cylinder in the kit. ---
    { type: "tank", x: 470, y: 92, scale: 2.6 },      // the vault
    { type: "crystal", x: 512, y: 62, scale: 1.5 },

    // --- the trading desk, left side ---
    { type: "terminal", x: 118, y: 130, scale: 1.8 },  // the trading desk
    { type: "antenna", x: 84, y: 108, scale: 1.15 },

    // --- columns holding the hall up ---
    { type: "pipe", x: 100, y: 214, scale: 2.2 },
    { type: "pipe", x: 476, y: 214, scale: 2.2 },

    // --- the waiting area ---
    { type: "bench", x: 232, y: 290, scale: 1.2 },
    { type: "planter", x: 404, y: 248, scale: 1.2 },

    // --- the ledger desk, bottom right ---
    { type: "terminal", x: 470, y: 296, scale: 1.4 },  // the ledger

    // --- lobby dressing, kept sparse: a banking hall reads as SPACE ---
  ],

  // Other Friends in the hall. The bank should not feel empty.
  actors: [
    { sprite: 0, x: 258, y: 150 },
    { sprite: 1, x: 318, y: 168 },
    { sprite: 2, x: 210, y: 268 },
    { sprite: 3, x: 392, y: 262 },
    { sprite: 4, x: 430, y: 196 },
  ],

  // Money markers, the kit's own currency glyph.
  signals: [
    { x: 288, y: 104, kind: "currency" },
    { x: 452, y: 120, kind: "currency" },
    { x: 132, y: 160, kind: "node" },
    { x: 452, y: 292, kind: "node" },
  ],
} as const;

/** Front door, dead centre at the bottom of the hall. */
export const SPAWN = [288, 336] as const;

/** The four things you can walk up to. */
/**
 * labelOffset lifts the prompt above its prop. The props were scaled up to read as
 * architecture, so these had to grow with them or the label sits across the teller
 * screen it is pointing at.
 */
export const STATIONS = [
  { id: "teller",  label: "Teller window",  position: [288, 96]  as const, reach: 96, labelOffset: -272 },
  { id: "vault",   label: "The vault",      position: [452, 128] as const, reach: 94, labelOffset: -300 },
  { id: "desk",    label: "Trading desk",   position: [124, 142] as const, reach: 92, labelOffset: -252 },
  { id: "ledger",  label: "The ledger",     position: [462, 306] as const, reach: 88, labelOffset: -230 },
] as const;
