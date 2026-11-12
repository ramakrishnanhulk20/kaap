'use client';

import { motion } from 'framer-motion';
import { useStill } from '@/lib/useStill';
import './steps.css';

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const SEEN = { once: true, amount: 0.3 } as const;

const STEPS = [
  {
    picture: '/world/how-queue.jpg',
    alt: 'Three wooden toy members wait in a line, each holding a sealed letter.',
    title: 'A request is filed.',
    text: "A payment, a new member, a change of rules, a signature. Kaap's watcher picks up each one as it reaches the treasury.",
  },
  {
    picture: '/world/how-light.jpg',
    alt: 'The toy watchman holds a letter up to his lantern, and the light shows a key inside it.',
    title: 'Kaap holds it to the light.',
    text: 'It works out what the request will really do and checks that against what it says. Where there is only a hash, it reads the text behind it inside sealed hardware. Members who follow the treasury get the answer in plain words.',
  },
  {
    picture: '/world/how-door.jpg',
    alt: 'A yellow thread is wound around the toy treasury and tied in a bow across its door.',
    title: 'A theft gets one vote: no.',
    text: "Kaap's guard holds a role that can only reject. It casts that one vote and the door stays shut. It cannot approve, pay or change anything, and one vote of yours removes it.",
  },
] as const;

/** The three things Kaap does, each beside a closer look at the same toy set as the hero. */
export default function Steps() {
  const still = useStill();

  return (
    <section id="how-it-works" className="toy-steps">
      <div className="toy-steps-inner">
        <p className="toy-label">How it works</p>
        <h2 className="toy-steps-title">Every request is read before it is signed.</h2>

        <ol className="toy-steps-row">
          {STEPS.map((step, index) => (
            <motion.li
              key={step.picture}
              className="toy-step"
              initial={still ? false : { opacity: 0, y: 34 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={SEEN}
              transition={{ duration: 0.75, ease: EASE, delay: index * 0.14 }}
            >
              <div className="toy-stamp-lift">
                <div className="toy-stamp">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a small local picture, already sized for its place */}
                  <img src={step.picture} alt={step.alt} width={1600} height={1200} loading="lazy" />
                  <span className="toy-stamp-value" aria-hidden="true">
                    {index + 1}
                  </span>
                </div>
              </div>
              <h3 className="toy-step-title">{step.title}</h3>
              <p className="toy-step-text">{step.text}</p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}
