import Closing from '@/components/landing/Closing';
import Hero from '@/components/landing/Hero';
import Limits from '@/components/landing/Limits';
import Proof from '@/components/landing/Proof';
import Reading from '@/components/landing/Reading';
import Steps from '@/components/landing/Steps';
import Footer from '@/components/site/Footer';

export default function Home() {
  return (
    <main>
      <Hero />
      <Reading />
      <Steps />
      <Limits />
      <Proof />
      <Closing />
      <Footer />
    </main>
  );
}
