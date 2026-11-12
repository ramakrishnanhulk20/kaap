import type { Metadata } from 'next';
import { Suspense } from 'react';
import LabShell from '@/components/lab/LabShell';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <Suspense>
      <LabShell />
    </Suspense>
  );
}
