import type { Metadata } from 'next';
import { Bricolage_Grotesque, Fraunces, Instrument_Sans, JetBrains_Mono, Noto_Serif_Tamil } from 'next/font/google';
import Grain from '@/components/Grain';
import SmoothScroll from '@/components/SmoothScroll';
import './globals.css';
import '@/components/site/site.css';

const serif = Fraunces({
  weight: 'variable',
  style: ['normal', 'italic'],
  axes: ['opsz', 'SOFT'],
  subsets: ['latin'],
  variable: '--font-serif',
});
const grotesk = Bricolage_Grotesque({ weight: 'variable', subsets: ['latin'], variable: '--font-grotesk' });
const tamil = Noto_Serif_Tamil({ weight: '600', subsets: ['tamil', 'latin'], variable: '--font-tamil' });
const body = Instrument_Sans({ weight: 'variable', subsets: ['latin'], variable: '--font-body' });
const mono = JetBrains_Mono({ weight: ['400', '500', '700'], subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Kaap: a guard for NEAR treasuries',
  description:
    'Kaap reads every request to a NEAR treasury before it is signed, tells members in plain words what it will do, and vetoes the theft. It can reject. It can never approve or move a cent.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = [serif, grotesk, tamil, body, mono].map((font) => font.variable).join(' ');
  return (
    <html lang="en" className={fonts}>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
        <Grain />
      </body>
    </html>
  );
}
