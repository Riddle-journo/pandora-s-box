// Approximate cross-script name matching for Devanagari (Marathi/Hindi) OCR bodies.
// The Internet Archive mahGRs corpus is Marathi; the roster is English. Exact string
// matching can't bridge scripts, so we reduce BOTH sides to a "consonant skeleton"
// — romanize Devanagari to Latin, fold the common romanization variants (aspirates,
// w/v, ph/f, sibilants), then drop vowels. Two spellings of the same name usually
// collapse to the same consonant run (फडणवीस → "fdnvs" == Fadnavis → "fdnvs").
//
// This is APPROXIMATE by design: it boosts recall on a corpus that would otherwise
// match nothing, at the cost of some noise and misses on heavily-anglicized spellings
// (Thackeray/ठाकरे). Matches are LEADS to verify, never findings — consistent with
// every other name-in-body source here.

// Each Devanagari consonant → the single folded ASCII consonant its sound maps to
// (aspiration dropped: ख→k, घ→g, थ→t …). Vowels, matras, anusvara, virama, nukta →
// "" (skeleton drops vowels anyway). ळ→l, श/ष/स→s, व→v, फ→f.
const DEVA = {
  "क": "k", "ख": "k", "ग": "g", "घ": "g", "ङ": "n",
  "च": "c", "छ": "c", "ज": "j", "झ": "j", "ञ": "n",
  "ट": "t", "ठ": "t", "ड": "d", "ढ": "d", "ण": "n",
  "त": "t", "थ": "t", "द": "d", "ध": "d", "न": "n",
  "प": "p", "फ": "f", "ब": "b", "भ": "b", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "ळ": "l",
  "श": "s", "ष": "s", "स": "s", "ह": "h",
  // independent vowels + matras + signs → dropped
  "अ": "", "आ": "", "इ": "", "ई": "", "उ": "", "ऊ": "", "ए": "", "ऐ": "", "ओ": "", "औ": "", "ऋ": "",
  "ा": "", "ि": "", "ी": "", "ु": "", "ू": "", "े": "", "ै": "", "ो": "", "ौ": "", "ृ": "",
  "ं": "n", "ँ": "n", "ः": "", "्": "", "़": "", "ऽ": "", // anusvara/chandrabindu → nasal 'n'
};

// PURE. Romanize a Devanagari string to a folded ASCII consonant stream (spaces and
// non-Devanagari kept as-is so word boundaries survive).
export function devanagariToLatin(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (ch in DEVA) out += DEVA[ch];
    else if (/\s/.test(ch)) out += " ";
    else if (/[ऀ-ॿ]/.test(ch)) out += ""; // any other Devanagari sign → drop
    else out += ch; // latin/digits/punct pass through
  }
  return out;
}

// PURE. Fold an already-Latin token to the same consonant skeleton the Devanagari
// side produces: lowercase, drop non-letters, fold aspirate digraphs + w→v + ph→f +
// sibilants + c→k, then drop vowels. Applied to English roster names.
export function latinSkeleton(s) {
  let t = String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  t = t
    .replace(/w/g, "v")             // Pawar/Pavar
    .replace(/ph/g, "f")            // Phadnavis → Fadnavis
    .replace(/([kgtdpbcjs])h/g, "$1") // drop aspiration: kh→k, th→t, sh→s, ch→c …
    .replace(/c/g, "k")             // hard-c/ch → k-family (folds with क)
    .replace(/q/g, "k").replace(/x/g, "ks").replace(/z/g, "j")
    .replace(/h/g, "");             // drop leftover aspiration/ह (व्ह, standalone h)
  return t.replace(/[aeiou]/g, "");  // drop vowels → consonant skeleton
}

// PURE. Skeleton for a Devanagari (or already-Latin) string: romanize if it has
// Devanagari, then run the same Latin folding. So both scripts converge.
export function consonantSkeleton(s) {
  const romanized = /[ऀ-ॿ]/.test(String(s ?? "")) ? devanagariToLatin(s) : String(s ?? "");
  // Fold per space-separated token then join (keeps the romanized 'c' before c→k).
  return latinSkeleton(romanized);
}

// Build match skeletons for a set of roster names, keeping only those long enough to
// be specific (short skeletons over-match in a big OCR body). Returns a Set.
export function buildTranslitNeedles(names, { minLen = 5 } = {}) {
  const set = new Set();
  for (const n of names) {
    const sk = consonantSkeleton(n);
    if (sk.length >= minLen) set.add(sk);
  }
  return set;
}

// Does a (Devanagari or Latin) text contain any needle skeleton? Romanizes the whole
// text to one skeleton and substring-checks. minLen guards against noise.
export function textMatchesTranslit(text, needleSkeletons) {
  if (!needleSkeletons || !needleSkeletons.size) return false;
  const hay = consonantSkeleton(text);
  if (!hay) return false;
  for (const sk of needleSkeletons) if (hay.includes(sk)) return true;
  return false;
}
