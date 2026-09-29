/**
 * FRAMING A GENERATIONS FRIEND. A hardwired Generations tokenURI is a 512px isometric world with the Friend
 * walking on it, and where it stands depends on the generation: a Gen-2 roams x 260..386, well right of centre,
 * a Gen-5 stays near 220..260. The old frame was a fixed zoom on the tile's centre, so a Gen-2 tile showed only
 * terrain, and the same zoom on a full-bleed Gen-5 or Gen-6 portrait (no world at all) showed only its middle.
 *
 * So the frame is read from the art, never tuned per generation: the SVG's viewBox is cropped to a square around
 * the Friend's resting spot (the `#friend` group's translate), and the Friend is held there, as the art itself
 * does for reduced motion, so it can never walk out of the frame. `pad` is how much of its world shows around it:
 * small for an avatar, more for a tile. Anything without a `#friend` (a portrait, a PNG) is returned unchanged.
 */

/** The Friend sprite: an 18px grid drawn at scale(2) from its translate. */
const SPRITE = 36;
const SIDE = 512;

const cache = new Map<string, string>();

function decode(url: string): string | null {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    if (/;base64/i.test(m[1] ?? "")) {
      const bin = atob(m[2]);
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    return decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}

export function framedArt(url: string, pad: number): string {
  const key = `${pad}:${url}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let out = url;
  const svg = decode(url);
  const at = svg && /id="friend"[^>]*transform="translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)"/.exec(svg);
  if (svg && at) {
    const side = Math.min(SIDE, SPRITE + 2 * pad);
    const clamp = (v: number) => Math.min(SIDE - side, Math.max(0, v + SPRITE / 2 - side / 2));
    const x = clamp(Number(at[1])), y = clamp(Number(at[2]));
    const framed = svg
      .replace(/viewBox="[^"]*"/, `viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${side} ${side}"`)
      .replace(/<\/svg>\s*$/, "<style>.rf-moving{display:none}.rf-still{display:inline}</style></svg>");
    out = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(framed)}`;
  }
  cache.set(key, out);
  return out;
}

/** Around an avatar (the HUD, a vault door): the Friend nearly fills it. */
export const AVATAR_PAD = 8;
/** Around a tile (the picker, /docs): the Friend with a little of its world. */
export const TILE_PAD = 30;

/**
 * The Friend alone, for the hall's walking sprite: its resting frame with the world hidden and its body lit on the
 * tile's black, the same one-bit convention as a Genesis portrait. Sampling the whole
 * world (the old way) mixed terrain into the sprite and a Gen-2 walked in as a blob. Null when there is no world.
 */
export function friendSprite(url: string): string | null {
  const framed = framedArt(url, 0);
  if (framed === url) return null;
  // The art paints a white silhouette and the black body over it; the hall reads bright as ink, so swap the two
  // and the body, not its outline, becomes the sprite (the hall adds its own paper halo).
  const style = "<style>#landscape,.rf-currency-static,.rf-currency-moving{display:none}"
    + "#portrait path[fill='#fff']{fill:#000}#portrait path[fill='#000']{fill:#fff}</style></svg>";
  return framed.replace(/%3C%2Fsvg%3E$/, encodeURIComponent(style));
}
