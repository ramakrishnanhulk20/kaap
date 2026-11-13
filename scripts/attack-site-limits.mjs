#!/usr/bin/env node
// Attacks the per-caller limits of the hosted site from outside (rule C35 in
// docs/security/threat-model.md): can a caller get past a limit by saying it is someone else?
//
//   node scripts/attack-site-limits.mjs <https://the-site's-address> [--press]
//
// 1. The check route allows one caller eight checks a minute. This asks it twelve times inside a
//    minute for an account that is no treasury, each time under another made-up X-Forwarded-For and
//    X-Real-IP. A site that believes either header gives each ask its own count and never refuses.
//    The right answers are a refusal of the question itself until the count is used up, and
//    429 from then on, by the ninth ask at the latest. Nothing is filed and nothing is spent.
// 2. With --press: the try-it button allows one caller two presses in ten minutes. This presses
//    three times, each under another made-up address. Each press that goes through files a real
//    request on the demo treasury and costs Kaap's watcher a sealed run, which is why it is asked
//    for by name. The right outcome: at most two go through, and the third is refused with 429.
//
// Run it after every deploy: which header a host's proxy overwrites is the host's behaviour, and no
// test inside this repository can see it. It uses up this machine's checks on that site for a
// minute, and with --press its presses for ten minutes.
//
// Not covered: that two real callers get two separate counts; a caller that reaches the site over
// two networks, such as IPv4 and IPv6, and so has two counts of its own; and the limits a host
// applies by itself before the site is asked.

const site = process.argv[2];
const pressToo = process.argv.includes('--press');
if (typeof site !== 'string' || !/^https:\/\/[a-z0-9.-]+$/i.test(site)) {
  console.error("give the site's address, such as https://kaap.example.org, and --press to press the button too");
  process.exit(2);
}

const madeUp = (n) => ({ 'x-forwarded-for': `203.0.113.${n}`, 'x-real-ip': `198.51.100.${n}` });

async function main() {
  console.log(`Kaap site limits attack, ${new Date().toISOString()}: ${site}`);
  const checks = [];
  for (let n = 1; n <= 12; n++) {
    const res = await fetch(`${site}/api/check?network=testnet&dao=kaap-no-such-treasury-${n}.testnet`, { headers: madeUp(n), signal: AbortSignal.timeout(60_000) });
    checks.push(res.status);
  }
  const firstRefusal = checks.indexOf(429);
  const checkHeld = firstRefusal !== -1 && firstRefusal <= 8 && checks.slice(firstRefusal).every((s) => s === 429);
  console.log(`1. twelve checks, each under another made-up address: ${checks.join(' ')}`);
  console.log(`   ${checkHeld ? `the limit bit after ${firstRefusal} asks: the made-up addresses changed nothing` : 'THE LIMIT DID NOT HOLD'}`);

  let pressHeld = true;
  if (pressToo) {
    const presses = [];
    for (let n = 101; n <= 103; n++) {
      const res = await fetch(`${site}/api/demo/attack`, { method: 'POST', headers: { ...madeUp(n), 'x-kaap-demo': '1' }, signal: AbortSignal.timeout(90_000) });
      const body = await res.json().catch(() => ({}));
      presses.push(res.ok ? `filed #${body.id}` : `${res.status} ${body.reason ?? ''}`.trim());
    }
    const through = presses.filter((p) => p.startsWith('filed')).length;
    pressHeld = through <= 2 && presses[2].startsWith('429');
    console.log(`2. three presses, each under another made-up address: ${presses.join('; ')}`);
    console.log(`   ${pressHeld ? `${through} went through and the third was refused: the made-up addresses changed nothing` : 'THE LIMIT DID NOT HOLD'}`);
  }
  const ok = checkHeld && pressHeld;
  console.log(ok ? 'RESULT: pass' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
