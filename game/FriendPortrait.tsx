"use client";

/**
 * The Friend you are playing as, drawn from its own canonical on-chain sprite.
 *
 * The SDK's Friend PICKER shows text only: <strong>label</strong><small>kind</small>.
 * So you choose blind between Friends that look nothing alike, and after choosing
 * you never see who you got. The picker lives in the trusted runtime and games are
 * told not to reimplement selection, so this cannot fix the choosing. It can at
 * least make the Friend present once you are inside the bank.
 *
 * The artwork is a 16x16 one-bit mask read from the families registry, rendered as
 * SVG rects so it stays sharp at any size. Nothing is invented and nothing is
 * recoloured: this is the same source the world renderer draws from.
 */

import { useEffect, useRef, useState } from "react";
import { createFriendReader, spriteFrame, type GenerationSprites } from "@rarefriends/friendsdk/sprites";

type Props = { friendId: bigint; size?: number; onFamily?: (family: string) => void };

export default function FriendPortrait({ friendId, size = 44, onFamily }: Props) {
  const [sprites, setSprites] = useState<GenerationSprites | null>(null);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  // Keep the callback out of the effect's deps so a new closure each render does
  // not re-read the sprite from chain on every parent update.
  const report = useRef(onFamily);
  report.current = onFamily;

  useEffect(() => {
    const version = ++epoch.current;
    setSprites(null);
    setFailed(false);
    createFriendReader()
      .read(friendId)
      .then((value) => { if (version === epoch.current) { setSprites(value); report.current?.(value.familyName); } })
      // A portrait is decoration. If the read fails the bank still works, so fall
      // back to a placeholder rather than failing the session.
      .catch(() => { if (version === epoch.current) setFailed(true); });
    return () => { epoch.current++; };
  }, [friendId]);

  if (failed || !sprites) {
    return (
      <div
        className={`bank-portrait ${failed ? "is-failed" : "is-loading"}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }

  // Facing the player, standing still. Colossus has no up/down frames and the
  // reader falls back sideways on its own.
  const rows = spriteFrame(sprites, "down", false, 0).frame.rows;

  return (
    <div className="bank-portrait" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        shapeRendering="crispEdges"
        role="img"
        aria-label={`Your Friend, a ${sprites.familyName}, token ${friendId}`}
      >
        {rows.map((row, y) =>
          [...row].map((cell, x) =>
            cell === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" /> : null,
          ),
        )}
      </svg>
    </div>
  );
}
