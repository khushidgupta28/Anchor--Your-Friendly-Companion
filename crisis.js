// Tier 1: clear statements. Fixed helpline is always appended.
const STRONG_PATTERNS = [
  /\b(kill|hurt|harm|end)\s+(myself|my\s*life)\b/i,
  /\bsuicid/i,
  /\bself[\s-]?harm/i,
  /\b(want|wanna|going)\s+to\s+(die|disappear)\b(?!\s+(laughing|of\b))/i,   // excludes "die laughing" / "die of embarrassment"
  /\bdon'?t\s+want\s+to\s+(be\s+here|live|exist)\b/i,
  /\bno\s+reason\s+to\s+live\b/i,
  /\bbetter\s+off\s+(dead|without\s+me)\b/i,
  /\bwish\s+i\s+(was|were)\s+(dead|gone|never\s+born)\b/i,
  /\bnever\s+wake\s+up\b/i,
  // Hinglish / Hindi
  /\b(mar\s*jana|jeena\s+nahi|jeene\s+ka\s+(mann|man)\s+nahi|khud\s*kushi|atmahatya)\b/i,
  /\bkhud\s+ko\s+(khatam|maar|hurt)/i,
  /\bmar\s*jaun(ga|gi)?\b/i,
  /\bjaan\s+de\s*(du|dunga|dungi)\b/i,
  /आत्महत्या|जीना\s*नहीं|मर\s*जाना|खुद\s*को\s*खत्म/
];

// Tier 2: ambiguous distress. Gemini is told to respond carefully, but no fixed helpline.
const SOFT_PATTERNS = [
  /\bwant\s+(everything|it\s+all|all\s+of\s+this)\s+to\s+(stop|end|go\s+away)\b/i,
  /\bcan'?t\s+(do\s+this|go\s+on|take\s+(it|this)\s+anymore)\b/i,
  /\bno\s+point\s+(in\s+)?(anything|living|going\s+on)\b/i,
  /\bsab\s+khatam\b/i,
  /\bthak\s+gaya\s+hu(n)?\s+(sab|zindagi)/i
];

const isCrisis = (t) => STRONG_PATTERNS.some(p => p.test(String(t)));
const isConcerning = (t) => SOFT_PATTERNS.some(p => p.test(String(t)));
module.exports = { STRONG_PATTERNS, SOFT_PATTERNS, isCrisis, isConcerning };