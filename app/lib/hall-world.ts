/**
 * THE FIRST BANK OF FRIENDS - the hall, in two shapes.
 *
 * WHY THERE ARE TWO
 *
 * The isometric projection is fixed:
 *
 *     screenX = 800 + 1.5 * 0.8660254 * (x - y - 96)
 *     screenY = 690 + 1.5 * 0.28      * (x + y - 480) - lift
 *
 * Across the screen a unit is worth 1.299 px; into the screen it is worth 0.42. So
 * ANY room built as a rectangle on the plane projects 3.09 : 1, and no amount of
 * framing makes a 3.09 : 1 picture fill a phone held upright. The first version of
 * this hall was 390 x 197 inside an 844 tall page: a letterbox slot with the HUD
 * sitting on top of the desk sign and the hint running across the floor.
 *
 * The fix is not a smaller camera, it is a different ROOM. Depth is worth a third of
 * width, so a hall that is long into the screen and narrow across it projects TALL.
 * `wide` is a banking floor you look across; `tall` is the same hall as a corridor
 * you look down. Both are generated from one spec by `room()` below, so the desk,
 * the vault and the walk always mean the same thing.
 *
 * Everything else here is derived rather than chosen. Placement is by DEPTH and
 * mirrored OFFSET, not raw coordinates, because `x - y = 96` is the screen centre
 * line and `x + y` is depth: two props at a similar depth overlap however far apart
 * they look on the plane. And the camera is solved from the room's own corners, the
 * depth skirt below them and each prop's lift above them, so the frame ratio can
 * never drift from the viewBox and letterbox the scene.
 */

const A = 0.8660254038, B = 0.28, S = 1.5, CX = 800, CY = 690;

/** Screen centre line: a point at `x - y = CENTRE` renders dead centre. */
const CENTRE = 96;

/** The SDK's plane. Nothing may be placed outside it. */
const PLANE = { width: 576, height: 384 };

/**
 * How far each prop actually reaches from its ground anchor, in canvas units.
 *
 * MEASURED, not assumed. The first version of this read PROP_CANVAS (240x240,
 * anchored at 120,180) and reserved 120 either side and 180 above. The artwork uses
 * a fraction of that canvas: `getBBox()` on the rendered `.world-prop` groups gives
 * the numbers below, and renderWorld then multiplies `prop.scale` by 1.4 of its own
 * accord. Reserving the canvas instead of the art padded the wide frame with 132
 * units of empty paper above the room and shrank the hall to pay for it.
 *
 * If the SDK's artwork ever changes these go stale, so `scripts/hall-sweep.mjs`
 * asserts every rendered prop is inside the frame rather than trusting them.
 */
const PROP_BASE_SCALE = 1.4;
const PROP_ART: Record<string, { half: number; up: number; down: number }> = {
  terminal: { half: 27, up: 65, down: 8 },
  tank: { half: 26, up: 81, down: 2 },
};

/** How far in front of the desk prop you stand to use it. */
const DESK_STAND = 40;

const DEPTH_SKIRT = 26;
const PAD = 24;
/**
 * Room for the sign itself above its anchor. It is an HTML box of a fixed pixel
 * height, so in canvas units it varies with the screen: ~26 units on a phone, ~31
 * on a desktop. 36 covers both.
 */
const PROMPT_ROOM = 36;

const projectXY = (x: number, y: number, lift = 0): [number, number] =>
  [CX + S * A * (x - y - CENTRE), CY + S * B * (x + y - 480) - lift];

/** Plane point from depth (x + y) and mirrored offset from the centre line. */
const plane = (depth: number, offset: number): [number, number] =>
  [Math.round((depth + CENTRE + offset) / 2), Math.round((depth - CENTRE - offset) / 2)];

/**
 * Even-odd point in polygon. A bounding box is not enough: both rooms are diamonds
 * in one space or the other, so most of any box drawn around them is off the floor.
 */
function inside(poly: readonly (readonly [number, number])[], x: number, y: number) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

type Prop = { type: string; depth: number; offset: number; scale: number };
type Pt = readonly [number, number];

/**
 * OUTLINES ARE GENERATED, NEVER TYPED OUT.
 *
 * Both of these were hand-written once and both were wrong in ways no test caught:
 * a single corner of the corridor sat 100 units off the centre line, which drew a
 * skewed room with the desk stranded to one side of it. The vertices are a pure
 * function of four numbers, so they should be computed from those four numbers.
 */

/** A chamfered rectangle on the plane. Projects to a wide floor. */
function planeRect(x0: number, y0: number, x1: number, y1: number, c: number): Pt[] {
  return [
    [x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c],
    [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c],
  ];
}

/**
 * A chamfered corridor: `half` either side of the centre line, running from `near`
 * to `far` in depth. Projects to an upright floor. The chamfer is applied along
 * each edge, which in this space means 1/sqrt(2) of it on each axis.
 */
function corridor(half: number, near: number, far: number, c: number): Pt[] {
  const d = Math.round(c * Math.SQRT1_2);
  const [nl, nr, fr, fl] = [
    plane(near, -half), plane(near, half), plane(far, half), plane(far, -half),
  ];
  return [
    [nl[0] + d, nl[1] - d], [nr[0] - d, nr[1] + d],
    [nr[0] + d, nr[1] + d], [fr[0] - d, fr[1] - d],
    [fr[0] - d, fr[1] + d], [fl[0] + d, fl[1] - d],
    [fl[0] - d, fl[1] - d], [nl[0] + d, nl[1] + d],
  ];
}

type Spec = {
  key: "wide" | "mid" | "tall";
  /** Floor outline on the plane, already chamfered. */
  poly: readonly (readonly [number, number])[];
  /** desk is the destination, door is the spawn. */
  depth: { desk: number; door: number };
  props: readonly Prop[];
  /** An optional dither rectangle on the plane, which projects to a diamond. */
  patch: { x: number; y: number; w: number; h: number } | null;
  /** How close you must be to the desk for it to open. */
  reach: number;
  pathWidth: number;
  /** How high above the desk its sign floats, in canvas units. */
  promptLift: number;
  /** How far past the door the runner carries on toward the back wall. */
  runOn: number;
};

/**
 * WIDE: a banking floor, 935 px of floor across the screen. Desk and vault are 60
 * apart in depth so neither hides the other.
 */
const WIDE: Spec = {
  key: "wide",
  poly: planeRect(48, 32, 528, 352, 40),
  depth: { desk: 400, door: 700 },
  props: [
    { type: "terminal", depth: 400, offset: 0, scale: 1.25 },
    { type: "tank", depth: 340, offset: -190, scale: 1.0 },
  ],
  patch: { x: 198, y: 102, w: 180, h: 180 },
  reach: 92,
  pathWidth: 34,
  promptLift: 110,
  runOn: 90,
};

/**
 * TALL: the same hall as a corridor. Offsets run +/-85 and depth runs 210 to 760,
 * which is as long as the 576 x 384 plane allows - the binding corner is the left
 * wall at the near end, where `y = (depth - 96 - offset) / 2` hits 384. It projects
 * 269 x 404, upright, and a phone fills with it.
 *
 * Two constraints shaped the props, and both were found by drawing it.
 *
 * A prop reaches 180*scale ABOVE its anchor, so in a narrow room the desk's head
 * and the vault's head collide long before their feet do: clearing them takes ~320
 * units of depth, which is most of the corridor. Hence the vault back by the door.
 *
 * And a prop wider than the wall it stands against widens the whole CAMERA, which
 * is what first made this room 0.80 rather than 0.67 and left a phone two thirds
 * empty. The vault's offset is set so its 60 px half-width stays inside the wall.
 */
const TALL: Spec = {
  key: "tall",
  poly: corridor(62, 200, 780, 34),
  depth: { desk: 260, door: 700 },
  props: [
    { type: "terminal", depth: 260, offset: 0, scale: 0.62 },
    { type: "tank", depth: 560, offset: -40, scale: 0.5 },
  ],
  // No rug. The runner already crosses this floor and two dither shapes in a
  // corridor this narrow read as clutter.
  patch: null,
  reach: 78,
  pathWidth: 26,
  promptLift: 70,
  runOn: 40,
};

/**
 * MID: the same hall again, for the shapes in between - 4:3 tablets in landscape
 * and 16:10 laptops, which are most desktops. Those boxes fit neither of the other
 * two well: at 1024x768 the wide hall filled the width and left 46% of the screen
 * as paper above and below it.
 *
 * It is the corridor generator with a much wider half-width, which is what a room
 * at 1.53 : 1 has to be. A plane rectangle cannot make this shape at all: for any
 * rectangle the k and depth ranges are both w + h, so every one of them projects
 * 3.09 : 1 no matter its proportions.
 */
const MID: Spec = {
  key: "mid",
  poly: corridor(184, 310, 665, 50),
  depth: { desk: 360, door: 620 },
  props: [
    { type: "terminal", depth: 360, offset: 0, scale: 1.0 },
    // Kept well inboard: a tall prop parked against the wall has its FEET on
    // the floor and its body over blank paper, because nothing draws the wall it
    // would be occluding.
    { type: "tank", depth: 480, offset: -110, scale: 0.85 },
  ],
  patch: { x: 223, y: 127, w: 150, h: 150 },
  reach: 88,
  pathWidth: 30,
  promptLift: 110,
  runOn: 40,
};

/**
 * Solve the camera from the room itself: corners, the skirt below them, the lift
 * above each prop, framed at the content's own aspect ratio.
 */
function camera(spec: Spec) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const see = (px: number, py: number) => {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  };
  for (const [x, y] of spec.poly) {
    const [px, py] = projectXY(x, y);
    see(px, py); see(px, py + S * DEPTH_SKIRT);
  }
  // The desk's SIGN is content too, and it floats above the tallest prop in the
  // room. Leaving it out of the solve put it above the top edge of the frame.
  {
    // Anchored where the COMPONENT anchors it - at the desk's standing position,
    // 40 units in front of the prop - not at the prop. Solving against the prop
    // reserved 76 units of sky that nothing was ever drawn into.
    const [dx, dy] = plane(spec.depth.desk + DESK_STAND, 0);
    const [px, py] = projectXY(dx, dy);
    see(px, py - spec.promptLift - PROMPT_ROOM);
  }
  for (const p of spec.props) {
    const art = PROP_ART[p.type];
    if (!art) throw new Error(`hall: no measured extents for prop "${p.type}"`);
    const k = p.scale * PROP_BASE_SCALE;
    const [x, y] = plane(p.depth, p.offset);
    const [px, py] = projectXY(x, y);
    see(px - art.half * k, py - art.up * k);
    see(px + art.half * k, py + art.down * k);
  }
  const width = Math.round(maxX - minX + PAD * 2);
  const height = Math.round(maxY - minY + PAD * 2);
  return {
    x: Math.round((minX + maxX) / 2 - width / 2),
    y: Math.round((minY + maxY) / 2 - height / 2),
    width, height,
  };
}

function room(spec: Spec) {
  /**
   * Place by depth and offset, refusing anything off the floor. The room narrows
   * toward its chamfers, so an offset that is fine at one depth is outside at
   * another, and validateWorld would otherwise reject the whole scene with only a
   * bare coordinate to go on.
   */
  const at = (depth: number, offset = 0): [number, number] => {
    const [x, y] = plane(depth, offset);
    if (x < 0 || x > PLANE.width || y < 0 || y > PLANE.height || !inside(spec.poly, x, y)) {
      throw new RangeError(
        `hall/${spec.key}: depth ${depth} offset ${offset} lands at (${x}, ${y}), off the floor.`,
      );
    }
    return [x, y];
  };

  const signal = at(spec.depth.desk + 46);

  const world = {
    id: `first-bank-hall-${spec.key}`,
    family: "bank-hall",
    name: "The First Bank of Friends",
    setting: "Banking hall",
    shape: spec.key === "wide" ? "Chamfered hall" : "Chamfered corridor",
    summary: "A marble hall with a single desk.",
    variant: "complete",
    missingChunks: [] as number[],
    geometry: { polygons: [spec.poly.map(([x, y]) => [x, y])], holes: [], depth: DEPTH_SKIRT },
    patches: spec.patch ? [{ ...spec.patch, pattern: "dither" }] : [],
    paths: [{
      points: [
        // Runs PAST the door to the back wall. Starting it at the spawn left the
        // runner stopping in open floor, which read as unfinished.
        at(spec.depth.door + spec.runOn),
        at(Math.round((spec.depth.door + spec.depth.desk) / 2)),
        at(spec.depth.desk + 34),
      ],
      width: spec.pathWidth,
    }],
    props: spec.props.map((p) => {
      const [x, y] = at(p.depth, p.offset);
      return { type: p.type, x, y, scale: p.scale };
    }),
    // renderWorld paints props and signals from the world, but NOT world.actors:
    // only live actors handed to it at render time. An entry here would validate
    // and then draw nothing.
    actors: [],
    signals: [{ x: signal[0], y: signal[1], kind: "currency" }],
  };

  const viewBox = camera(spec);

  return {
    key: spec.key,
    world,
    /** The door, on the centre line. */
    spawn: at(spec.depth.door) as readonly [number, number],
    /** The one thing you can walk up to. */
    desk: {
      label: "The Desk",
      position: at(spec.depth.desk + DESK_STAND) as readonly [number, number],
      reach: spec.reach,
    },
    promptLift: spec.promptLift,
    viewBox,
    /** MUST match the viewBox or preserveAspectRatio letterboxes the scene. */
    ratio: viewBox.width / viewBox.height,
    frameRatio: `${viewBox.width} / ${viewBox.height}`,
  };
}

export type Hall = ReturnType<typeof room>;

export const HALLS = { wide: room(WIDE), mid: room(MID), tall: room(TALL) } as const;

/**
 * Pick the room that wastes the least of the box it has to live in. This is a
 * function of the AVAILABLE BOX, not of the window: a short landscape phone and a
 * tall tablet want different halls at the same width, and a media query cannot see
 * the difference once the chrome above and below has been taken out.
 */
export function hallFor(boxRatio: number): Hall {
  const used = (h: Hall) => (boxRatio > h.ratio ? h.ratio / boxRatio : boxRatio / h.ratio);
  let best = HALLS.wide;
  for (const h of [HALLS.mid, HALLS.tall]) if (used(h) > used(best)) best = h;
  return best;
}

/** The largest box of the hall's own ratio that fits inside `box`. */
export function fit(hall: Hall, box: { width: number; height: number }) {
  const width = Math.min(box.width, box.height * hall.ratio);
  return { width, height: width / hall.ratio };
}

export const project = projectXY;
