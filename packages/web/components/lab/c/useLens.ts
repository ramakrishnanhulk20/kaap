import { animate } from 'framer-motion';
import { useEffect, type RefObject } from 'react';

const FOLLOW = 0.18;
const TOUCH_IDLE_MS = 3000;
const SHRUNK = 0.4;
const REST = { x: 0.7, y: 0.4 };
const GROW_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

type Point = { x: number; y: number };
type Ease = 'easeOut' | [number, number, number, number];

const isControl = (target: EventTarget | null) => target instanceof Element && target.closest('[data-shrink]') !== null;

/**
 * Moves the lens by writing --lx, --ly and --ls on the section from one requestAnimationFrame loop.
 * Nothing here sets React state, so the page never re-renders while the lens moves.
 */
export function useLens(ref: RefObject<HTMLElement | null>, still: boolean) {
  useEffect(() => {
    const section = ref.current;
    if (!section) return;

    let rect = section.getBoundingClientRect();
    let rectStale = false;
    let pointer: Point | null = null;
    let usingTouch = false;
    let fingerDown = false;
    let lastInputAt = 0;
    let overControl = false;
    let entered = false;
    let scale = 0;
    let playback: { stop: () => void } | undefined;
    let place: Point | null = null;
    let written: Point = { x: Number.NaN, y: Number.NaN };
    let startedAt = -1;
    let frameId = 0;
    let growTimer: ReturnType<typeof setTimeout> | undefined;

    const setScale = (value: number) => {
      scale = value;
      section.style.setProperty('--ls', String(value));
    };

    const scaleTo = (target: number, seconds: number, ease: Ease) => {
      playback?.stop();
      if (still) {
        setScale(target);
        return;
      }
      playback = animate(scale, target, { duration: seconds, ease, onUpdate: setScale });
    };

    const setOverControl = (next: boolean) => {
      if (next === overControl) return;
      overControl = next;
      if (entered) scaleTo(next ? SHRUNK : 1, 0.2, 'easeOut');
    };

    const frame = (now: number) => {
      frameId = requestAnimationFrame(frame);
      if (startedAt < 0) startedAt = now;
      if (rectStale) {
        rect = section.getBoundingClientRect();
        rectStale = false;
      }

      const steered = pointer !== null && (still || !usingTouch || fingerDown || now - lastInputAt < TOUCH_IDLE_MS);
      let targetX: number;
      let targetY: number;
      if (steered && pointer) {
        targetX = pointer.x - rect.left;
        targetY = pointer.y - rect.top;
      } else if (still) {
        targetX = rect.width * REST.x;
        targetY = rect.height * REST.y;
      } else {
        const seconds = (now - startedAt) / 1000;
        targetX = rect.width * (0.5 + 0.34 * Math.sin((seconds * 2 * Math.PI) / 9));
        targetY = rect.height * (0.46 + 0.26 * Math.sin((seconds * 2 * Math.PI) / 6.5 + 1));
      }

      if (!place || still) {
        place = { x: targetX, y: targetY };
      } else {
        place.x += (targetX - place.x) * FOLLOW;
        place.y += (targetY - place.y) * FOLLOW;
      }

      const x = Math.round(place.x * 10) / 10;
      const y = Math.round(place.y * 10) / 10;
      if (x !== written.x) section.style.setProperty('--lx', `${x}px`);
      if (y !== written.y) section.style.setProperty('--ly', `${y}px`);
      written = { x, y };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      usingTouch = false;
      lastInputAt = performance.now();
      rectStale = true;
      setOverControl(isControl(event.target));
    };

    const onPointerLeave = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') setOverControl(false);
    };

    const onTouch = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (touch) pointer = { x: touch.clientX, y: touch.clientY };
      usingTouch = true;
      fingerDown = event.touches.length > 0;
      lastInputAt = performance.now();
      rectStale = true;
      setOverControl(fingerDown && isControl(event.target));
    };

    const markStale = () => {
      rectStale = true;
    };

    setScale(0);
    if (still) {
      entered = true;
      setScale(1);
    } else {
      growTimer = setTimeout(() => {
        entered = true;
        scaleTo(overControl ? SHRUNK : 1, 0.7, GROW_EASE);
      }, 300);
    }

    const resizeWatcher = new ResizeObserver(markStale);
    resizeWatcher.observe(section);
    window.addEventListener('scroll', markStale, { passive: true });
    window.addEventListener('resize', markStale);
    section.addEventListener('pointermove', onPointerMove);
    section.addEventListener('pointerleave', onPointerLeave);
    section.addEventListener('touchstart', onTouch, { passive: true });
    section.addEventListener('touchmove', onTouch, { passive: true });
    section.addEventListener('touchend', onTouch, { passive: true });
    section.addEventListener('touchcancel', onTouch, { passive: true });
    frameId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(growTimer);
      playback?.stop();
      resizeWatcher.disconnect();
      window.removeEventListener('scroll', markStale);
      window.removeEventListener('resize', markStale);
      section.removeEventListener('pointermove', onPointerMove);
      section.removeEventListener('pointerleave', onPointerLeave);
      section.removeEventListener('touchstart', onTouch);
      section.removeEventListener('touchmove', onTouch);
      section.removeEventListener('touchend', onTouch);
      section.removeEventListener('touchcancel', onTouch);
    };
  }, [ref, still]);
}
