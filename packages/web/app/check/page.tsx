import type { Metadata } from 'next';
import { Suspense } from 'react';
import CheckTool from '@/components/check/CheckTool';
import { Nav } from '@/components/lab/f/Closing';
import '@/components/lab/f/stage.css';

export const metadata: Metadata = {
  title: 'Check a treasury | Kaap',
  description: 'Read what any NEAR Sputnik DAO request will really do, with no wallet.',
};

export default function CheckPage() {
  return (
    <main data-direction="f" className="relative">
      <Nav home="/lab?d=f" />
      {/* The tool reads the address bar, which only the browser has. */}
      <Suspense fallback={null}>
        <CheckTool />
      </Suspense>
    </main>
  );
}
