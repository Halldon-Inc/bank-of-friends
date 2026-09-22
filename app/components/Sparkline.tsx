/**
 * A 1-bit price line. No axes, no colour, no gradient fill: the Friends'
 * own artwork is pure black and white and the desk should not out-shout it.
 */
export default function Sparkline({ points }: { points: number[] }) {
  if (!points || points.length < 2) {
    return (
      <div className="spark" style={{ display: "grid", placeItems: "center", color: "var(--dimmer)", fontSize: "0.72rem" }}>
        not enough history to draw a line
      </div>
    );
  }
  const W = 600, H = 120, PAD = 6;
  const lo = Math.min(...points), hi = Math.max(...points);
  const span = hi - lo || hi || 1;
  const d = points
    .map((p, i) => {
      const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
      const y = H - PAD - ((p - lo) / span) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
         aria-label={`$RAREFRIENDS price, ${points.length} hourly closes, low ${lo.toExponential(3)} high ${hi.toExponential(3)} WETH`}>
      <line className="axis" x1="0" y1={H - PAD} x2={W} y2={H - PAD} />
      <path d={d} />
    </svg>
  );
}
