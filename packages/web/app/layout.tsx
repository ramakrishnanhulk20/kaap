import type { Metadata } from 'next';
import {
  Big_Shoulders,
  Bricolage_Grotesque,
  Fraunces,
  Instrument_Sans,
  JetBrains_Mono,
  Noto_Serif_Tamil,
} from 'next/font/google';
import Grain from '@/components/Grain';
import SmoothScroll from '@/components/SmoothScroll';
import './globals.css';

// Google renamed Big Shoulders Display to Big Shoulders and folded the Display cut into an optical
// size axis. The poster face is set to the display end of that axis in globals.css.
const poster = Big_Shoulders({ weight: 'variable', axes: ['opsz'], subsets: ['latin'], variable: '--font-poster' });
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
  title: 'Kaap',
  // An empty icon stops the browser asking for /favicon.ico until the real mark exists.
  icons: { icon: 'data:,' },
};

// Runs before the first paint so a saved dark choice never flashes light. Nothing saved means light.
const themeScript = `(function(){try{var t=localStorage.getItem('kaap-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = [poster, serif, grotesk, tamil, body, mono].map((font) => font.variable).join(' ');
  return (
    <html lang="en" data-theme="light" className={fonts} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <SmoothScroll>{children}</SmoothScroll>
        <Grain />
      </body>
    </html>
  );
}
