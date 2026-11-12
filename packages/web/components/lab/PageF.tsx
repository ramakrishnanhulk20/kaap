import HeroF from './HeroF';
import Closing from './f/Closing';
import Limits from './f/Limits';
import Proof from './f/Proof';
import Reading from './f/Reading';
import Steps from './f/Steps';

/** The landing page in the wooden-toy look, section by section as each is approved on the lab. */
export default function PageF() {
  return (
    <>
      <HeroF />
      <Reading />
      <Steps />
      <Limits />
      <Proof />
      <Closing />
    </>
  );
}
