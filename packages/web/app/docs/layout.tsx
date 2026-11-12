import { Banner } from 'fumadocs-ui/components/banner';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Mark } from '@/components/site/Nav';
import { source } from '@/lib/source';

function Brand() {
  return (
    <>
      <Mark />
      <span className="font-grotesk text-[21px] font-extrabold tracking-[-0.03em] text-ink">Kaap</span>
      <span className="font-mono text-[12px] font-normal uppercase tracking-[0.14em] text-muted">Docs</span>
    </>
  );
}

function CheckButton() {
  return (
    <Link href="/check" className="toy-btn toy-btn--main toy-btn--small">
      Check a treasury
    </Link>
  );
}

// The docs are light only, like the rest of the site. The theme library is off, and so is its
// switch: that library edits the class on <html>, which the root layout does not expect.
export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <div className="kaap-docs">
        <Banner
          changeLayout={false}
          height="4rem"
          className="justify-between whitespace-nowrap border-b border-line bg-bg/90 px-10 text-left backdrop-blur max-md:hidden"
        >
          <Link href="/" className="toy-brand">
            <Brand />
          </Link>
          <CheckButton />
        </Banner>
        <DocsLayout
          tree={source.getPageTree()}
          // Fumadocs shows this title in its small-screen header. From md up the bar above takes
          // over and the copy at the top of the sidebar is hidden in docs.css.
          nav={{ title: <Brand />, url: '/' }}
          themeSwitch={{ enabled: false }}
          tabs={false}
          sidebar={{
            collapsible: false,
            banner: (
              <div className="md:hidden">
                <CheckButton />
              </div>
            ),
          }}
        >
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}
