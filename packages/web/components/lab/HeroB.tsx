import { hashHex } from '@/lib/labData';

export default function HeroB() {
  return (
    <div className="flex min-h-[calc(100svh-var(--bar))] flex-col items-center justify-center px-6 text-center">
      <h1 className="font-serif leading-none text-ink" style={{ fontSize: 'clamp(3rem, 10vw, 9rem)' }}>
        The thread
      </h1>
      <p className="mt-6 max-w-3xl font-mono text-[14px] text-muted [overflow-wrap:anywhere]">{hashHex}</p>
    </div>
  );
}
