// A fine paper grain fixed over the whole page. Its strength is --grain-opacity in globals.css.
export default function Grain() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 h-full w-full"
      style={{ opacity: 'var(--grain-opacity)', mixBlendMode: 'overlay' }}
    >
      <filter id="kaap-grain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#kaap-grain)" />
    </svg>
  );
}
