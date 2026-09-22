/**
 * THE FIRST BANK OF FRIENDS - a banking hall on the SDK's 576 x 384 ground plane.
 *
 * GEOMETRY IS BUILT AROUND THE CAMERA, NOT AROUND THE PLANE.
 * GameWorld crops a fixed 960x640 window out of the 1600x1200 native projection at
 * screen (320,330), and exposes no camera prop. Working the projection backwards,
 * the centre of that crop is world point (288, 198):
 *
 *     screenX = 800 + 1.299 * (x - y - 96)      crop centre = (800, 650)
 *     screenY = 690 + 0.420 * (x + y - 480)     =>  x - y ~ 90,  x + y ~ 486
 *
 * So the hall is centred on (288, 198) and kept SMALL. A previous version spanned
 * the whole 576x384 plane, which is what made it read as jam-packed; another sat at
 * (340, 290) and rendered down in the bottom-left corner.
 *
 * Sparse on purpose. The fishing example puts SIX things on a large open floor and
 * reads clean; this had twenty-two and did not. A banking hall should read as space.
 *
 *        back wall ---------- TELLER ----------
 *          desk                                vault
 *                     (open marble floor)
 *          column      bench    planter       column
 *        ------------- ENTRANCE ------ ledger
 */
export const BANK_WORLD = {
  id: "first-bank-of-friends",
  family: "bank-hall",
  name: "The First Bank of Friends",
  setting: "Banking hall",
  shape: "Chamfered hall",
  summary: "A marble hall with a teller counter, a vault, a trading desk and a ledger.",
  variant: "complete",
  missingChunks: [] as number[],

  geometry: {
    polygons: [[
      [82, 99], [446, 99], [502, 152],
      [502, 244], [446, 297], [130, 297],
      [74, 244], [74, 152],
    ]],
    holes: [],
    depth: 27,
  },

  // Marble: a broad tiled floor with an inlaid runner down the middle.
  patches: [
    { x: 95, y: 126, w: 386, h: 72, pattern: "grid" },
    { x: 95, y: 211, w: 386, h: 67, pattern: "grid" },
    { x: 229, y: 136, w: 83, h: 145, pattern: "dither" },
  ],

  // Door to counter, then the branches out to vault and desk.
  paths: [
    { points: [[269, 278], [269, 147]], width: 43 },
    { points: [[269, 193], [425, 193]], width: 36 },
    { points: [[269, 193], [116, 193]], width: 36 },
  ],

  props: [
    { type: "terminal", x: 269, y: 118, scale: 1.55 },  // the teller counter
    { type: "tank",     x: 433, y: 147, scale: 1.75 },  // the vault
    { type: "terminal", x: 116, y: 152, scale: 1.35 },  // the trading desk
    { type: "terminal", x: 210, y: 288, scale: 1.15 },  // the ledger, front-left, clear of the runner
    { type: "pipe",     x: 103, y: 260, scale: 1.5 },   // columns
    { type: "pipe",     x: 451, y: 252, scale: 1.5 },
    { type: "bench",    x: 192, y: 265, scale: 0.95 },
  ],

  // A few other Friends in the hall so it is not empty.
  actors: [
    { sprite: 0, x: 229, y: 174 },
    { sprite: 2, x: 317, y: 214 },
  ],

  signals: [
    { x: 269, y: 155, kind: "currency" },
  ],
} as const;

/**
 * Front door. Must be WALKABLE: an earlier spawn at (322, 358) sat inside the
 * ledger desk's collision footprint and the runtime refused the world outright.
 */
export const SPAWN = [269, 254] as const;

/**
 * labelOffset lifts a prompt clear of its prop. These track prop scale: raise one
 * and the label ends up printed across the teller screen it points at.
 */
export const STATIONS = [
  { id: "teller", label: "Teller",       position: [269, 152] as const, reach: 102, labelOffset: -186 },
  { id: "vault",  label: "Vault",        position: [417, 174] as const, reach: 99, labelOffset: -192 },
  { id: "desk",   label: "Trading desk", position: [135, 182] as const, reach: 99, labelOffset: -168 },
  { id: "ledger", label: "Ledger",       position: [224, 300] as const, reach: 84, labelOffset: -150 },
] as const;
