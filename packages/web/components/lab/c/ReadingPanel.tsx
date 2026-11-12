import { motion } from 'framer-motion';
import { description, effects, hashHex, proposalId, sentence, withText } from '@/lib/labData';

const escapeForPattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The key and the account id are taken from the engine's own effects, so the sentence can be split
// around them without typing either by hand.
const LITERALS = effects
  .flatMap((effect) => [effect.public_key, effect.path])
  .filter((value): value is string => typeof value === 'string' && value !== '' && sentence.includes(value));

const PIECES = LITERALS.length > 0 ? sentence.split(new RegExp(`(${LITERALS.map(escapeForPattern).join('|')})`)) : [sentence];

const LABEL = 'font-mono text-[11px] uppercase tracking-[0.18em] text-muted';
const VALUE = 'mt-1 font-body text-[15px] leading-[1.4] text-ink';

export default function ReadingPanel({ still }: { still: boolean }) {
  const rows = [
    {
      label: 'PROPOSAL',
      value: <>#{proposalId}</>,
    },
    {
      label: 'IT SAYS',
      value: <span className="line-clamp-3">{description}</span>,
    },
    {
      label: 'IT SHOWS',
      value: <span className="font-mono text-[13px]">{hashHex.slice(0, 16)}...</span>,
    },
    {
      label: 'IT REALLY DOES',
      value: PIECES.map((piece, index) =>
        index % 2 === 1 ? (
          <span key={index} className="font-mono text-[13px] [overflow-wrap:anywhere]">
            {piece}
          </span>
        ) : (
          piece
        ),
      ),
    },
    {
      label: 'VERDICT',
      value: (
        <>
          <span className="mr-2 inline-block h-2 w-2 bg-accent align-middle" />
          <span className="font-mono text-[13px] font-bold tracking-[0.16em] text-accent">
            {withText.riskFloor.toUpperCase()}
          </span>
          <span className="text-muted"> · do not sign</span>
        </>
      ),
    },
  ];

  return (
    <div
      data-shrink
      className="relative z-[4] mt-6 w-full cursor-default rounded-lg border border-line bg-bg/85 p-5 backdrop-blur-[12px] transition-colors duration-150 ease-out hover:border-ink/40 sm:absolute sm:right-8 sm:top-8 sm:mt-0 sm:w-[360px]"
    >
      <dl className="flex flex-col gap-[14px]">
        {rows.map((row, position) => (
          <motion.div
            key={row.label}
            initial={still ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut', delay: 0.6 + position * 0.12 }}
          >
            <dt className={LABEL}>{row.label}</dt>
            <dd className={VALUE}>{row.value}</dd>
          </motion.div>
        ))}
      </dl>
    </div>
  );
}
