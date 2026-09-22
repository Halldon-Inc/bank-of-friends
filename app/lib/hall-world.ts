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
};

/**
 * Each room was solved rather than chosen: maximise floor depth, keep the facade a
 * sane fraction of the hall's width, subject to the 576x384 plane, at the target
 * proportion. The plane is why the wide hall is 1.99 and not wider - a hall's depth
 * is capped at `768 - 2 * half`, so one both very wide and deep enough to walk down
 * does not exist.
 */
const SPECS: Spec[] = [
  { key: "wide", half: 212, near: 320, far: 640, chamfer: 46, facadeH: 95,  counterH: 34, aisle: 40, reach: 64, vaultFrom: 52 },
  { key: "mid",  half: 192, near: 310, far: 650, chamfer: 44, facadeH: 130, counterH: 38, aisle: 38, reach: 66, vaultFrom: 74 },
  { key: "tall", half: 66,  near: 174, far: 764, chamfer: 26, facadeH: 110, counterH: 34, aisle: 30, reach: 78, vaultFrom: 150 },
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
  const pedH = F * 0.2, entabH = F * 0.1, plinthH = F * 0.09;
  const colTop = top + pedH + entabH;
  const colBot = base - plinthH;
  const width = right - left;
  const colH = colBot - colTop;
  // The central bay holds the vault door, and the aisle runs into it.
  const bay = Math.min(width * 0.44, colH * 1.5);
  const r = Math.min(colH * 0.42, bay * 0.4);
  return {
    left, right, width, base, top, F, colH,
    pedBottom: top + pedH,
    entabTop: top + pedH, entabBottom: colTop,
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
  const deskLabelOffset = Math.round(((runL + runR) / 2 - CX) / (S * A));

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
    // The LABEL sits over the left run of the counter, which is the thing it
    // names. Centred in the aisle it stacked on top of the vault's sign and the
    // pair of them covered the vault door.
    anchor: at(counterAt, deskLabelOffset) as readonly [number, number],
    reach: spec.reach,
    lift: Math.round(spec.counterH + 4),
  };
  const vault = {
    id: "vault" as const,
    label: "The Vault",
    hint: "see the book",
    position: at(vaultAt) as readonly [number, number],
    anchor: at(vaultAt) as readonly [number, number],
    // Just off the floor in front of the door. Lifting it clear of the door put it
    // straight through the pediment and across the bank's own name.
    lift: 14,
    reach: spec.reach,
  };
  const spawn = at(spawnAt) as readonly [number, number];

  /**
   * You must have to WALK somewhere, and arriving at one destination must not arm
   * the other. In an earlier room the vault sat within reach of the door, so its
   * sign was lit before you had moved a pixel.
   */
  const apart = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  for (const t of [desk, vault]) {
    if (apart(spawn, t.position) <= t.reach * 1.25) {
      throw new Error(`hall/${spec.key}: you spawn ${apart(spawn, t.position).toFixed(0)} from ${t.label}, inside its reach of ${t.reach}.`);
    }
  }
  const gap = apart(desk.position, vault.position);
  if (gap <= Math.max(desk.reach, vault.reach)) {
    throw new Error(`hall/${spec.key}: desk and vault are ${gap.toFixed(0)} apart, inside a reach of ${Math.max(desk.reach, vault.reach)}.`);
  }

  /* Camera: the floor's own corners, the skirt below it, the building above it,
     and room for both signs. Solved, never typed in. */
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
  for (const t of [desk, vault]) {
    const [px, py] = projectXY(t.anchor[0], t.anchor[1]);
    see(px, py - t.lift - PROMPT_ROOM);
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
    world, spawn, desk, vault, facade, counter,
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
