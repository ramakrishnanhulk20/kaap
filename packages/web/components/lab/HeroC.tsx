import { hashHex } from '@/lib/labData';

export default function HeroC() {
  return (
    <div className="flex min-h-[calc(100svh-var(--bar))] flex-col items-center justify-center px-6 text-center">
      <h1 className="font-grotesk leading-none text-ink" style={{ fontSize: 'clamp(3rem, 10vw, 9rem)' }}>
        The lens
      </h1>
      <p className="mt-6 max-w-3xl font-mono text-[14px] text-muted [overflow-wrap:anywhere]">{hashHex}</p>
    </div>
  );
}
