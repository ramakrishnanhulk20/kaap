'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStill } from '../d/useStill';

const PHONE_QUERY = '(max-width: 859px)';

const ALT =
  'A set of painted wooden toys. Three treasury members bring sealed letters to a striped round treasury. A watchman with a big moustache holds one letter up to his lantern, and the light shows a key hidden inside it. A yellow thread winds three times around the treasury and ties itself in a bow across the door.';

const FILM = {
  desktop: {
    first: '/world/film/first.jpg',
    end: '/world/film/end.jpg',
    story: '/world/film/story.mp4',
    loop: '/world/film/loop.mp4',
  },
  phone: {
    first: '/world/film/first-phone.jpg',
    end: '/world/film/end-phone.jpg',
    story: '/world/film/story-phone.mp4',
    loop: '/world/film/loop-phone.mp4',
  },
} as const;

interface Plan {
  phone: boolean;
  saveData: boolean;
}

let plan: Plan | null = null;

// Read once per page load, so the film never changes files halfway through the story.
function readPlan(): Plan {
  if (plan === null) {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    plan = {
      phone: window.matchMedia(PHONE_QUERY).matches,
      saveData: connection?.saveData === true,
    };
  }
  return plan;
}

const subscribeToNothing = () => () => {};

// The server and the first client render know nothing about the visitor, so both show the first still.
const readPlanOnServer = (): Plan | null => null;

function Still({ end }: { end: boolean }) {
  return (
    <picture>
      <source media={PHONE_QUERY} srcSet={end ? FILM.phone.end : FILM.phone.first} />
      {/* eslint-disable-next-line @next/next/no-img-element -- the still must be the very file the film starts on */}
      <img src={end ? FILM.desktop.end : FILM.desktop.first} alt={ALT} fetchPriority="high" />
    </picture>
  );
}

type Stage = 'waiting' | 'story' | 'loop';

type Phase = 'loading' | 'starting' | 'story' | 'loop' | 'blocked';

function Player({ phone }: { phone: boolean }) {
  const files = phone ? FILM.phone : FILM.desktop;
  const rootRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLVideoElement>(null);
  const loopRef = useRef<HTMLVideoElement>(null);
  const [stage, setStage] = useState<Stage>('waiting');

  useEffect(() => {
    const root = rootRef.current;
    const story = storyRef.current;
    const loop = loopRef.current;
    if (!root || !story || !loop) return;

    let phase: Phase = 'loading';
    let ready = false;
    let onScreen = true;
    let disposed = false;

    const active = () => (phase === 'story' ? story : phase === 'loop' ? loop : null);

    const tryStart = () => {
      if (phase !== 'loading' || !ready || !onScreen) return;
      phase = 'starting';
      story.play().then(
        () => {
          if (disposed) return;
          phase = 'story';
          setStage('story');
          if (!onScreen) story.pause();
        },
        () => {
          // Autoplay was refused: the first still stays and nothing else happens.
          phase = 'blocked';
        },
      );
    };

    const onCanPlay = () => {
      ready = true;
      tryStart();
    };

    // The loop starts on the frame after the story's last, so showing it and hiding the story in
    // one step leaves no visible jump.
    const onEnded = () => {
      phase = 'loop';
      if (onScreen) loop.play().catch(() => {});
      setStage('loop');
    };

    const observer = new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      if (!onScreen) {
        active()?.pause();
        return;
      }
      const current = active();
      if (current) current.play().catch(() => {});
      else tryStart();
    });

    story.addEventListener('canplay', onCanPlay);
    story.addEventListener('ended', onEnded);
    observer.observe(root);
    // A cached file can be ready before the listener above exists.
    if (story.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) onCanPlay();

    return () => {
      disposed = true;
      observer.disconnect();
      story.removeEventListener('canplay', onCanPlay);
      story.removeEventListener('ended', onEnded);
      story.pause();
      loop.pause();
    };
  }, []);

  return (
    <div ref={rootRef} className="toy-film-videos">
      <video
        ref={storyRef}
        src={files.story}
        poster={files.first}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        style={{ opacity: stage === 'story' ? 1 : 0 }}
      />
      <video
        ref={loopRef}
        src={files.loop}
        poster={files.end}
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        style={{ opacity: stage === 'loop' ? 1 : 0 }}
      />
    </div>
  );
}

/**
 * The hero film: the story plays once, then a short loop keeps the set alive. A visitor who asked
 * for less motion or less data gets the last picture of the story instead.
 */
export default function Film() {
  const reducedMotion = useStill();
  const choice = useSyncExternalStore(subscribeToNothing, readPlan, readPlanOnServer);
  const stillOnly = choice !== null && (reducedMotion || choice.saveData);

  return (
    <div className="toy-film-media">
      <Still end={stillOnly} />
      {choice !== null && !stillOnly ? <Player phone={choice.phone} /> : null}
    </div>
  );
}
