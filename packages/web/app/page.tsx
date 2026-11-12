import Closing from '@/components/landing/Closing';
import Hero from '@/components/landing/Hero';
import Limits from '@/components/landing/Limits';
import Proof from '@/components/landing/Proof';
import Reading from '@/components/landing/Reading';
import Steps from '@/components/landing/Steps';
import Footer from '@/components/site/Footer';
import SmoothScroll from '@/components/SmoothScroll';

export default function Home() {
  return (
    <SmoothScroll>
      <main>
        <Hero />
        <Reading />
        <Steps />
        <Limits />
        <Proof />
        <Closing />
        <Footer />
      </main>
    </SmoothScroll>
  );
}
