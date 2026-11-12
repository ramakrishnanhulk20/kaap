import type { Metadata } from 'next';
import { Suspense } from 'react';
import CheckTool from '@/components/check/CheckTool';
import TryIt from '@/components/check/TryIt';
import Footer from '@/components/site/Footer';
import Nav from '@/components/site/Nav';

export const metadata: Metadata = {
  title: 'Check a treasury | Kaap',
  description: 'Read what any NEAR Sputnik DAO request will really do, with no wallet.',
};

export default function CheckPage() {
  return (
    <main className="relative">
      <Nav />
      {/* The tool reads the address bar, which only the browser has. */}
      <Suspense fallback={null}>
        <CheckTool />
      </Suspense>
      <TryIt />
      <Footer />
    </main>
  );
}
