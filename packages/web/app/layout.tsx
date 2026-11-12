import type { Metadata } from 'next';
import { Bricolage_Grotesque, Fraunces, Instrument_Sans, JetBrains_Mono, Noto_Serif_Tamil } from 'next/font/google';
import Grain from '@/components/Grain';
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

const TITLE = 'Kaap: a guard for NEAR treasuries';
const DESCRIPTION =
  'Kaap reads every request to a NEAR treasury before it is signed, tells members in plain words what it will do, and vetoes the theft. It can reject. It can never approve or move a cent.';

// The share picture is app/opengraph-image.jpg, which Next.js adds to both blocks by itself.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: 'website', siteName: 'Kaap', title: TITLE, description: DESCRIPTION },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = [serif, grotesk, tamil, body, mono].map((font) => font.variable).join(' ');
  return (
    <html lang="en" className={fonts}>
      <body>
        {children}
        <Grain />
      </body>
    </html>
  );
}
