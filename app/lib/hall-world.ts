/**
 * THE FIRST BANK OF FRIENDS - the hall, rebuilt around a single focal desk.
 *
 * WHY THE GEOMETRY LOOKS LIKE THIS
 *
 * The isometric projection is
 *     screenX = 800 + 1.5 * 0.8660254 * (x - y - 96)
 *     screenY = 690 + 1.5 * 0.28     * (x + y - 480) - lift
 *
 * Two consequences drive every number below.
 *
 * 1. `x - y = 96` is the SCREEN CENTRE LINE. Anything on it renders dead centre, and
 *    a pair at `x - y = 96 +/- d` renders as a mirrored pair. Earlier versions were
 *    laid out on a grid in world space, which projects to a lopsided mess.
 *
 * 2. Depth is `x + y`, so two props with a similar `x + y` overlap no matter how far
 *    apart they look on the plane. That is exactly why the old hall had things
 *    "weirdly stacked on top of each other". Everything here is placed on an explicit
 *    depth ladder with clear gaps between rungs.
 *
 * The room is a chamfered rectangle centred on (293, 197), which sits on the centre
 * line. One destination: the desk. Everything else is architecture.
 */

/** Screen centre line. A point with x - y = CENTRE renders horizontally centred. */
const CENTRE = 96;

/** The room's bounding box, from the polygon below. */
const BOUNDS = { minX: 180, maxX: 406, minY: 84, maxY: 310 };

/**
 * Place a point by DEPTH (x + y) and mirrored OFFSET from the centre line.
 *
 * Throws if the result lands outside the room. The room NARROWS with depth, so the
 * usable offset shrinks toward the back wall and a value that is fine at one rung is
 * outside at another. validateWorld would reject the whole scene later with only a
 * bare coordinate to go on; failing here names the rung.
 */
function at(depth: number, offset = 0): [number, number] {
  const x = Math.round((depth + CENTRE + offset) / 2);
  const y = Math.round((depth - CENTRE - offset) / 2);
  if (x < BOUNDS.minX || x > BOUNDS.maxX || y < BOUNDS.minY || y > BOUNDS.maxY) {
    throw new RangeError(
      `hall: depth ${depth} offset ${offset} lands at (${x}, ${y}), outside the room ` +
      `(x ${BOUNDS.minX}-${BOUNDS.maxX}, y ${BOUNDS.minY}-${BOUNDS.maxY}). The room narrows with depth.`,
    );
  }
  return [x, y];
}

// Depth ladder. Gaps are deliberate: props sharing a rung would overlap.
const D = {
  backWall: 300,
  desk: 348,
  columnsBack: 432,
  seating: 520,
  columnsFront: 578,
  door: 648,
} as const;

export const HALL = {
  id: "first-bank-hall",
  family: "bank-hall",
  name: "The First Bank of Friends",
  setting: "Banking hall",
  shape: "Chamfered hall",
  summary: "A marble hall with a single desk.",
  variant: "complete",
  missingChunks: [] as number[],

  geometry: {
    polygons: [[
      [210, 84], [376, 84], [406, 114], [406, 280],
      [376, 310], [210, 310], [180, 280], [180, 114],
    ]],
    holes: [],
    depth: 20,
  },

  // Marble. One runner to the desk and one field either side. Three patches was
  // already the busiest this can be without the floor competing with the desk.
  patches: [
    { x: 240, y: 128, w: 92, h: 146, pattern: "dither" },
  ],

  // One path: door to desk, straight up the centre line.
  paths: [{ points: [at(D.door), at(D.seating), at(D.desk + 26)], width: 30 }],

  // TWO props. Nothing else.
  //
  // This room has been through crystal monuments, four pipe columns, benches and
  // planters, and every version read as clutter. The lesson kept repeating: a
  // banking hall is mostly FLOOR, the floor is where the player is, and anything
  // else competes with the one thing you are meant to walk to. So: the desk, and a
  // vault so it reads as a bank rather than an office.
  props: [
    { type: "terminal", x: at(D.desk)[0], y: at(D.desk)[1], scale: 1.6 },
    { type: "tank", x: at(324, 52)[0], y: at(324, 52)[1], scale: 1.15 },
  ],

  // One other Friend in the room, well off the runner, so it is not a morgue.
  actors: [
    { sprite: 4, x: at(D.seating - 30, 96)[0], y: at(D.seating - 30, 96)[1] },
  ],

  signals: [{ x: at(D.desk + 40)[0], y: at(D.desk + 40)[1], kind: "currency" }],
} as const;

/** The door, on the centre line. */
export const SPAWN: readonly [number, number] = at(D.door);

/** The one thing you can walk up to. */
export const DESK = {
  id: "desk",
  label: "The Desk",
  position: at(D.desk + 30) as readonly [number, number],
  reach: 78,
};

/**
 * Camera. renderWorld emits a 1600x1200 document; this is the window we show.
 * Centred on the midpoint between the door and the desk so the whole approach is in
 * frame, with the desk sitting slightly above centre where the eye lands first.
 */
export const VIEWBOX = { x: 419, y: 321, width: 763, height: 512 };

/**
 * Not eyeballed. The room's eight corners were projected, the geometry depth skirt
 * added below, and the desk's lift subtracted above, giving a content box of
 * x 545-1055, y 347-807 centred on (800, 577). The window is that box plus a small
 * margin at the frame's aspect ratio. A hand-picked camera left the hall floating
 * low and to one side with dead space above it.
 */
