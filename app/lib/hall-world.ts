/**
 * THE FIRST BANK OF FRIENDS - the hall.
 *
 * WHY IT IS DRAWN HEAD ON AND NOT IN 45-DEGREE ISOMETRIC
 *
 * The projection is fixed by the SDK:
 *
 *     screenX = 800 + 1.5 * 0.8660254 * (x - y - 96)
 *     screenY = 690 + 1.5 * 0.28      * (x + y - 480) - lift
 *
 * Read it as two axes: OFFSET (x - y - 96) moves you across the screen only, and
 * DEPTH (x + y) moves you down the screen only. A room bounded by constant offsets
 * and constant depths therefore projects to a plain RECTANGLE, seen head on - and a
 * wall of constant offset is edge on, so side walls are invisible by construction.
 *
 * That matters because the first version put the SDK's own props into such a room.
 * Those props are drawn as 45-degree isometric boxes, so the picture held two
 * incompatible perspectives at once: a flat rectangular floor with boxes standing
 * on it at an angle that cannot exist. The report was "the desk is sitting on
 * something but at an awkward angle", which was a real error being read correctly,
 * not a matter of taste. The props were also a generic kiosk and a WATER TANK, so
 * there was no bank anywhere in the bank.
 *
 * The room is now committed to the head-on reading and its furniture is drawn to
 * match: one straight aisle up the middle, a teller counter across the hall with an
 * opening in it, and a columned facade at the end with the vault door in it.
 * `lib/hall-art.ts` draws between the numbers computed here and invents no geometry
 * of its own, because two modules deriving the same proportions separately is how a
 * sign ends up floating through a pediment.
 *
 * WHY THERE ARE THREE ROOMS
 *
 * Across the screen a unit is worth 1.299 px and into it only 0.42, so one room
 * cannot fill both an ultrawide monitor and a phone held upright: the first hall
 * was 390x197 inside an 844 tall page, 23% of the screen. Each room below is the
 * same bank at a different proportion, and the component measures the box it
 * actually has and picks whichever wastes least.
 */

const A = 0.8660254038, B = 0.28, S = 1.5, CX = 800, CY = 690;

/** Screen centre line: a point at `x - y = CENTRE` renders dead centre. */
const CENTRE = 96;

/** The SDK's plane. Nothing may be placed outside it. */
const PLANE = { width: 576, height: 384 };

const DEPTH_SKIRT = 16;
const PAD = 24;

/** Room for a sign above whatever it names. */
const PROMPT_ROOM = 36;


/** Screen position of an offset from the aisle, and of a depth. */
export const sx = (offset: number) => CX + S * A * offset;
export const sy = (depth: number) => CY + S * B * (depth - 480);

const projectXY = (x: number, y: number, lift = 0): [number, number] =>
  [CX + S * A * (x - y - CENTRE), CY + S * B * (x + y - 480) - lift];

/** Plane point from depth and mirrored offset. */
const plane = (depth: number, offset: number): [number, number] =>
  [Math.round((depth + CENTRE + offset) / 2), Math.round((depth - CENTRE - offset) / 2)];

type Pt = readonly [number, number];

/**
 * A chamfered hall: `half` either side of the aisle, `near` to `far` in depth.
 * GENERATED, never typed out. Hand-written vertices once put a corner 100 units
 * off the centre line, which drew a skewed room with the desk stranded to one side.
 */
function corridor(half: number, near: number, far: number, c: number): Pt[] {
  const d = Math.round(c * Math.SQRT1_2);
  const [nl, nr, fr, fl] = [
    plane(near, -half), plane(near, half), plane(far, half), plane(far, -half),
  ];
  // ONLY the near corners are chamfered. Cutting the back ones too made the floor's
  // back edge narrower than the hall, so the building at the end of it was a small
  // box floating between two diagonal slivers of floor.
  return [
    nl, nr,
    [fr[0] - d, fr[1] - d], [fr[0] - d, fr[1] + d],
    [fl[0] + d, fl[1] - d], [fl[0] - d, fl[1] - d],
  ];
}

/** Even-odd point in polygon. The rooms are diamonds on the plane, so a bounding
 *  box drawn around one is mostly off the floor. */
function inside(poly: readonly Pt[], x: number, y: number) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

type Spec = {
  key: "wide" | "mid" | "tall";
  half: number; near: number; far: number; chamfer: number;
  /** Height of the facade above the floor's far edge, in canvas units. */
  facadeH: number;
  /** How tall the teller counter is. Where it stands is derived. */
  counterH: number;
  /** Aisle width, and how close you must be for a sign to arm. */
  aisle: number; reach: number;
  /**
   * How far in front of the facade you stand to use the vault. Where the hall is
   * deep enough this is set so the vault's SIGN clears the building; the wide hall
   * has only 248 units of aisle for three separated points, so there its sign sits
   * on the door like a plaque instead.
   */
  vaultFrom: number;
  /**
   * The Trading Floor: the quote board stands BEHIND the teller line on the right,
   * the way a bank's dealing room sits behind its counter. You reach it through the
   * opening in the counter. Depth and offset are placed so it is out of reach of
   * both the desk and the vault in every room; the guards below prove that at load.
   */
  floorAt: number; floorOffset: number;
  /**
   * How much of the pediment's height the vault plaque takes. The tympanum is a
   * triangle, so a shorter plaque is a wider one; the corridor needs the width.
   */
  plaqueH: number;
  /** The pediment's share of the facade. The corridor's is taller, for the plaque. */
  pedF: number;
};

/**
 * Each room was solved rather than chosen: maximise floor depth, keep the facade a
 * sane fraction of the hall's width, subject to the 576x384 plane, at the target
 * proportion. The plane is why the wide hall is 1.99 and not wider: a hall's depth
 * is capped at `768 - 2 * half`, so one both very wide and deep enough to walk down
 * does not exist.
 */
const SPECS: Spec[] = [
  { key: "wide", half: 212, near: 320, far: 640, chamfer: 46, facadeH: 95,  counterH: 34, aisle: 40, reach: 64, vaultFrom: 52,  floorAt: 418, floorOffset: 132, plaqueH: 0.6, pedF: 0.27 },
  { key: "mid",  half: 192, near: 310, far: 650, chamfer: 44, facadeH: 130, counterH: 38, aisle: 38, reach: 66, vaultFrom: 74,  floorAt: 432, floorOffset: 120, plaqueH: 0.6, pedF: 0.27 },
  { key: "tall", half: 66,  near: 174, far: 764, chamfer: 26, facadeH: 130, counterH: 34, aisle: 30, reach: 78, vaultFrom: 150, floorAt: 430, floorOffset: 44, plaqueH: 0.44, pedF: 0.38 },
];

/**
 * The facade, in SCREEN coordinates, as the lines the art module draws between.
 * It spans the floor's back edge exactly, which is the full width of the hall
 * because only the near corners are chamfered.
 */
function facadeOf(spec: Spec) {
  const left = sx(-spec.half), right = sx(spec.half);
  const base = sy(spec.near), F = spec.facadeH;
  const top = base - F;
  // The pediment is tall enough to carry THE VAULT HOLDS plaque in its tympanum.
  const pedH = F * spec.pedF, entabH = F * 0.1, plinthH = F * 0.09;
  /**
   * The marquee: a lit frieze under the name, the full width of the entablature.
   * The ticker used to be a separate black strip floating above the roof; it is
   * part of the building now, so the colonnade gives up a tenth of its height.
   */
  const marqueeH = F * 0.14;
  const colTop = top + pedH + entabH + marqueeH;
  const colBot = base - plinthH;
  const width = right - left;
  const colH = colBot - colTop;
  // The central bay holds the vault door, and the aisle runs into it.
  const bay = Math.min(width * 0.44, colH * 1.5);
  const r = Math.min(colH * 0.42, bay * 0.4);
  return {
    left, right, width, base, top, F, colH,
    pedBottom: top + pedH,
    entabTop: top + pedH, entabBottom: top + pedH + entabH,
    /**
     * THE VAULT HOLDS: a brass plaque in the pediment, the most visible place on
     * the building. The tympanum is a triangle, so the plaque is sized to the
     * width the triangle actually has at the plaque's top edge, never wider.
     */
    plaque: (() => {
      const pedBottom = top + pedH;
      const bottom = pedBottom - pedH * 0.04;
      const h = pedH * spec.plaqueH;
      const topY = bottom - h;
      const widthAtTop = width * (1 - (pedBottom - topY) / pedH);
      const half = Math.max(8, widthAtTop * 0.5 * 0.96);
      return { left: CX - half, right: CX + half, top: topY, bottom };
    })(),
    marquee: (() => {
      const mTop = top + pedH + entabH, inset = Math.max(1.5, marqueeH * 0.15);
      return {
        frame: { left, right, top: mTop, bottom: colTop },
        screen: { left: left + inset * 3, right: right - inset * 3, top: mTop + inset, bottom: colTop - inset },
      };
    })(),
    colTop, colBot, plinthH,
    bay,
    door: { cx: CX, cy: colBot - r * 1.04, r },
  };
}

/** The teller counter, in SCREEN coordinates: two runs with the aisle between. */
function counterOf(spec: Spec, depth: number) {
  const y = sy(depth);
  const gap = sx(spec.aisle * 0.7) - CX;
  const inset = (sx(spec.half) - CX) * 0.07;
  return {
    y, top: y - spec.counterH, height: spec.counterH,
    runs: [
      [sx(-spec.half) + inset, CX - gap],
      [CX + gap, sx(spec.half) - inset],
    ] as [number, number][],
  };
}

export type Hall = ReturnType<typeof room>;

function room(spec: Spec) {
  const poly = corridor(spec.half, spec.near, spec.far, spec.chamfer);

  /** Place by depth and offset, refusing anything off the floor. */
  const at = (depth: number, offset = 0): [number, number] => {
    const [x, y] = plane(depth, offset);
    if (x < 0 || x > PLANE.width || y < 0 || y > PLANE.height || !inside(poly, x, y)) {
      throw new RangeError(`hall/${spec.key}: depth ${depth} offset ${offset} lands at (${x}, ${y}), off the floor.`);
    }
    return [x, y];
  };

  const facade = facadeOf(spec);

  /* Three points on ONE straight line: in at the bottom, past the counter, and up
     to the vault door. The counter sits exactly HALFWAY between the door you come
     in by and the vault, rather than at a number someone picked, which is what
     kept putting it inside the spawn's own reach. */
  const spawnAt = spec.far - 20;
  const vaultAt = spec.near + spec.vaultFrom;
  const deskAt = Math.round((spawnAt + vaultAt) / 2);
  const counterAt = deskAt - 30;
  const counter = counterOf(spec, counterAt);
  const [runL, runR] = counter.runs[0];

  /**
   * Collision only. The counter is DRAWN by lib/hall-art; these stop you strolling
   * through it, so the opening in the middle is the way past. They are hidden in
   * CSS, which is also why their type does not matter.
   */
  const blockers = counter.runs.flatMap(([x0, x1]) => {
    const o0 = (x0 - CX) / (S * A), o1 = (x1 - CX) / (S * A);
    const n = Math.max(2, Math.round(Math.abs(o1 - o0) / 46));
    return Array.from({ length: n }, (_, i) => {
      const o = o0 + ((o1 - o0) * (i + 0.5)) / n;
      const [px, py] = at(counterAt, Math.round(o));
      return { type: "crate", x: px, y: py, scale: 0.5 };
    });
  });

  const world = {
    id: `first-bank-hall-${spec.key}`,
    family: "bank-hall",
    name: "The First Bank of Friends",
    setting: "Banking hall",
    shape: "Chamfered hall",
    summary: "A marble hall with a teller counter and a vault.",
    variant: "complete",
    missingChunks: [] as number[],
    geometry: { polygons: [poly.map(([x, y]) => [x, y])], holes: [], depth: DEPTH_SKIRT },
    patches: [],
    paths: [{ points: [at(spawnAt), at(vaultAt)], width: spec.aisle }],
    props: blockers,
    // renderWorld paints only the live actors handed to it, never world.actors.
    actors: [],
    signals: [],
  };

  const desk = {
    id: "desk" as const,
    label: "The Desk",
    hint: "open an account",
    position: at(deskAt) as readonly [number, number],
    reach: spec.reach,
    /**
     * EVERY SIGN IS PINNED TO THE THING IT NAMES, in screen space, from the same
     * numbers the art is drawn with. They used to be projected from a floor point
     * plus a lift, which on the phone left the vault's sign floating mid-hall and
     * the floor's sign on the frieze. The desk's hangs over the left counter run.
     */
    sign: { x: (runL + runR) / 2, y: counter.top + 1, hang: "above" as "above" | "below" },
    art: "desk",
  };
  const vault = {
    id: "vault" as const,
    label: "The Vault",
    hint: "see the book",
    position: at(vaultAt) as readonly [number, number],
    reach: spec.reach,
    // Hangs from the foot of the door frame, like a plaque on the plinth.
    sign: { x: CX, y: facade.door.cy + facade.door.r * 1.22 + 1, hang: "below" as "above" | "below" },
    art: "vault",
  };
  /*
   * The Trading Floor: a quote board standing behind the right run of the counter.
   * You stand in front of the board; the board itself sits a little further back.
   * It is kept LOW: the strip of floor behind the counter is shallow, and a tall
   * board rose straight up over the colonnade.
   */
  const boardAt = spec.floorAt - 12;
  const boardHalf = Math.min(sx(spec.half) - CX, 150) * 0.2;
  const board = {
    cx: sx(spec.floorOffset),
    base: sy(boardAt),
    top: sy(boardAt) - spec.counterH * 1.25,
    legs: spec.counterH * 0.35,
    left: sx(spec.floorOffset) - boardHalf,
    right: sx(spec.floorOffset) + boardHalf,
  };
  const floor = {
    id: "floor" as const,
    label: "The Trading Floor",
    hint: "is the desk on?",
    position: at(spec.floorAt, spec.floorOffset) as readonly [number, number],
    reach: spec.reach,
    // Sits on top of the quote board it names.
    sign: { x: board.cx, y: board.top + 1, hang: "above" as "above" | "below" },
    art: "floor",
  };

  const spawn = at(spawnAt) as readonly [number, number];
  const stations = [desk, floor, vault] as const;

  /**
   * You must have to WALK somewhere, and arriving at one destination must not arm
   * another. In an earlier room the vault sat within reach of the door, so its
   * sign was lit before you had moved a pixel. Checked for EVERY pair, because a
   * third station is exactly how a pairwise guard written for two quietly stops
   * covering the room.
   */
  const apart = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (const t of stations) {
    if (apart(spawn, t.position) <= t.reach * 1.25) {
      throw new Error(`hall/${spec.key}: you spawn ${apart(spawn, t.position).toFixed(0)} from ${t.label}, inside its reach of ${t.reach}.`);
    }
  }
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i], b = stations[j];
      const gap = apart(a.position, b.position);
      if (gap <= Math.max(a.reach, b.reach)) {
        throw new Error(`hall/${spec.key}: ${a.label} and ${b.label} are ${gap.toFixed(0)} apart, inside a reach of ${Math.max(a.reach, b.reach)}.`);
      }
    }
  }

  /**
   * The keeper's round: from the opening in the counter, up the aisle, to the foot
   * of the vault door. The far end is the door itself, not the vault's standing
   * spot, so in the corridor it visibly walks all the way up to the vault.
   */
  const keeper = {
    from: projectXY(...at(counterAt)),
    // Just beside the door, never under the vault's sign, which hangs from the frame.
    to: projectXY(...at(spec.near + 16, -Math.min(28, spec.half * 0.45))),
  };

  /** The ticker runs in the marquee's lit screen. */
  const ticker = facade.marquee.screen;
  const plaque = facade.plaque;

  /* Camera: the floor's own corners, the skirt below it, the building above it,
     and room for every sign. Solved, never typed in. */
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const see = (px: number, py: number) => {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  };
  for (const [x, y] of poly) {
    const [px, py] = projectXY(x, y);
    see(px, py); see(px, py + S * DEPTH_SKIRT);
  }
  see(facade.left, facade.top); see(facade.right, facade.base);
  for (const t of stations) {
    see(t.sign.x, t.sign.hang === "above" ? t.sign.y - PROMPT_ROOM : t.sign.y + PROMPT_ROOM);
  }
  const width = Math.round(maxX - minX + PAD * 2);
  const height = Math.round(maxY - minY + PAD * 2);
  const viewBox = {
    x: Math.round((minX + maxX) / 2 - width / 2),
    y: Math.round((minY + maxY) / 2 - height / 2),
    width, height,
  };

  return {
    key: spec.key,
    world, spawn, desk, vault, floor, stations, facade, counter, board, keeper, ticker, plaque,
    viewBox,
    /** MUST match the viewBox or preserveAspectRatio letterboxes the scene. */
    ratio: viewBox.width / viewBox.height,
  };
}

export const HALLS = {
  wide: room(SPECS[0]),
  mid: room(SPECS[1]),
  tall: room(SPECS[2]),
} as const;

/**
 * Pick the room that wastes the least of the box it has to live in. A function of
 * the AVAILABLE BOX, not the window: the right room depends on the space left once
 * the chrome is out, and a media query cannot see that.
 */
export function hallFor(boxRatio: number): Hall {
  const used = (h: Hall) => (boxRatio > h.ratio ? h.ratio / boxRatio : boxRatio / h.ratio);
  let best: Hall = HALLS.wide;
  for (const h of [HALLS.mid, HALLS.tall]) if (used(h) > used(best)) best = h;
  return best;
}

/** The largest box of the hall's own ratio that fits inside `box`. */
export function fit(hall: Hall, box: { width: number; height: number }) {
  const width = Math.min(box.width, box.height * hall.ratio);
  return { width, height: width / hall.ratio };
}

export const project = projectXY;
