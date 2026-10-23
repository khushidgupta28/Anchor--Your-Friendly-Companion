const { isCrisis, isConcerning } = require('./crisis');

// [phrase, expected tier]: "strong", "soft", or "none"
const cases = [
  ["I want to kill myself", "strong"],
  ["I want to end my life", "strong"],
  ["I don't want to be here anymore", "strong"],
  ["I keep thinking about suicide", "strong"],
  ["I want to hurt myself", "strong"],
  ["everyone would be better off without me", "strong"],
  ["I wish I could sleep and never wake up", "strong"],
  ["mujhe mar jana hai", "strong"],
  ["ab jeena nahi chahta", "strong"],
  ["mujhe jeene ka mann nahi hai", "strong"],
  ["mujhe khud ko khatam karna hai", "strong"],
  ["I just want everything to stop", "soft"],
  ["I can't take this anymore", "soft"],
  ["this homework is killing me", "none"],
  ["I'm dying to see that movie", "none"],
  ["I want to die laughing", "none"],
  ["I had a great day today", "none"],
  ["aaj mera mood bahut accha hai", "none"],
  ["Would anyone care if I was gone?", "strong"],
  ["My partner is leaving me", "soft"],
  ["My partner is hurting me", "strong"],
  ["I don't feel safe at my own house","soft"],
  ["I can't breath and my chest feels soo heavy","soft"],
  ["I think i'm going crazy", "soft"],
  ["I think I am having massive panick attack","strong"],
];

const tier = (t) => isCrisis(t) ? "strong" : isConcerning(t) ? "soft" : "none";

let pass = 0;
for (const [phrase, expected] of cases) {
  const got = tier(phrase);
  const ok = got === expected;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  expected=${expected}  got=${got}  "${phrase}"`);
}
console.log(`\n${pass}/${cases.length} as expected`);
