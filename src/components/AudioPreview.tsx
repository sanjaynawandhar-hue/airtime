"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 30-second audio preview, played in place. Hover on pointer devices, tap on
 * touch — a hover-only affordance would make this feature invisible on the
 * primary market's devices.
 *
 * Only one preview plays at a time across the whole page: a second one starting
 * stops the first. Enforced with a module-level reference rather than a
 * context, because the rails are server-rendered and share no client parent.
 */

let currentlyPlaying: HTMLAudioElement | null = null;

interface Props {
  readonly previewUrl: string;
  readonly title: string;
  readonly artist: string;
}

export function AudioPreview({ previewUrl, title, artist }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    if (currentlyPlaying === audio) currentlyPlaying = null;
    setPlaying(false);
  }, []);

  const start = useCallback(() => {
    if (failed) return;
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(previewUrl);
      audio.preload = "none";
      const element = audio;
      element.addEventListener("ended", () => {
        setPlaying(false);
        if (currentlyPlaying === element) currentlyPlaying = null;
      });
      element.addEventListener("error", () => {
        setFailed(true);
        setPlaying(false);
      });
      audioRef.current = element;
    }
    if (currentlyPlaying && currentlyPlaying !== audio) {
      currentlyPlaying.pause();
      currentlyPlaying.currentTime = 0;
    }
    currentlyPlaying = audio;
    void audio.play().then(
      () => setPlaying(true),
      // Autoplay policy can reject this before any user gesture. That is not an
      // error worth surfacing — the control simply does nothing until they tap.
      () => setPlaying(false),
    );
  }, [previewUrl, failed]);

  useEffect(() => stop, [stop]);

  if (failed) {
    return (
      <span className="text-[10px] leading-tight text-muted" role="status">
        No preview
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => (playing ? stop() : start())}
      onMouseEnter={() => {
        if (window.matchMedia("(hover: hover)").matches && !playing) start();
      }}
      onMouseLeave={() => {
        if (window.matchMedia("(hover: hover)").matches && playing) stop();
      }}
      aria-pressed={playing}
      aria-label={
        playing
          ? `Stop preview of ${title} by ${artist}`
          : `Play 30-second preview of ${title} by ${artist}`
      }
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center border border-paper/25 bg-ink-deep/80 text-paper transition-colors hover:border-gold hover:text-gold"
    >
      {playing ? (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
          <rect x="1" y="1" width="3.5" height="10" />
          <rect x="7.5" y="1" width="3.5" height="10" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
          <path d="M2 1l9 5-9 5z" />
        </svg>
      )}
    </button>
  );
}
