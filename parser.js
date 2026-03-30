// parser.js — refdes parsing logic
//
// Main export: parseRefdesList(rawText)
//   Takes a raw string, returns a sorted, deduplicated array of refdes strings.
//   e.g. "R1-R3, c5" → ["C5", "R1", "R2", "R3"]
//
// This file works in both the browser (loaded via <script>) and Node.js
// (loaded via require()). The conditional export at the bottom enables this.

// Matches a range token like R1-R5 or TP10-TP12.
// Groups: (prefix1)(num1)-(prefix2)(num2)
const RANGE_PATTERN  = /^([A-Za-z]+)(\d+)-([A-Za-z]+)(\d+)$/;

// Matches a single valid token: standard refdes (R1, TP3), pure letters (GND),
// or pure digits (20).
const REFDES_PATTERN = /^[A-Za-z]+\d+$|^[A-Za-z]+$|^\d+$/;

// --------------------------------------------------------------------------
// stripComments(text)
// Removes // ... and # ... to end of line.
// --------------------------------------------------------------------------
function stripComments(text) {
  return text
    .replace(/\/\/.*$/gm, '')
    .replace(/#.*$/gm, '');
}

// --------------------------------------------------------------------------
// expandToken(token, errorsOut?)
// Takes a single whitespace/comma-separated token and returns an array of
// individual uppercase refdes strings.
//
// If errorsOut (an array) is provided, unrecognised tokens are pushed into it
// instead of being silently discarded. Callers that omit errorsOut get the
// original silent-drop behavior.
// --------------------------------------------------------------------------
function expandToken(token, errorsOut) {
  const rangeMatch = token.match(RANGE_PATTERN);

  if (rangeMatch) {
    const [, prefix1, num1str, prefix2, num2str] = rangeMatch;

    if (prefix1.toUpperCase() === prefix2.toUpperCase()) {
      // Same prefix — expand the numeric range.
      // Math.min/max handles reversed ranges like R8-R1.
      const start  = Math.min(parseInt(num1str, 10), parseInt(num2str, 10));
      const end    = Math.max(parseInt(num1str, 10), parseInt(num2str, 10));
      const prefix = prefix1.toUpperCase();
      const items  = [];
      for (let i = start; i <= end; i++) items.push(prefix + i);
      return items;
    } else {
      // Different prefixes (e.g. R1-C5) — not a range, treat as two tokens.
      return [
        (prefix1 + num1str).toUpperCase(),
        (prefix2 + num2str).toUpperCase(),
      ];
    }
  }

  // Single refdes token — uppercase and return if valid, flag otherwise.
  if (REFDES_PATTERN.test(token)) {
    return [token.toUpperCase()];
  }

  // Unrecognised — report as a parse error if a collector was provided.
  if (errorsOut) errorsOut.push(token);
  return [];
}

// --------------------------------------------------------------------------
// splitRefdes(s)
// Splits a token into a sortable { prefix, num } pair.
//   Standard refdes "TP10" → { prefix: "TP", num: 10 }
//   Pure number  "20"   → { prefix: "",   num: 20  }  (sorts before all letters)
//   Pure letters "GND"  → { prefix: "GND", num: 0  }  (sorts before GND1, etc.)
// --------------------------------------------------------------------------
function splitRefdes(s) {
  const m = s.match(/^([A-Za-z]+)(\d+)$/);
  if (m) return { prefix: m[1], num: parseInt(m[2], 10) };
  if (/^\d+$/.test(s)) return { prefix: '', num: parseInt(s, 10) };
  return { prefix: s, num: 0 }; // pure letters
}

// --------------------------------------------------------------------------
// naturalSort(a, b)
// Sorts refdes strings by prefix alphabetically, then by number numerically.
// Ensures R1, R2, R10 rather than the lexicographic R1, R10, R2.
// --------------------------------------------------------------------------
function naturalSort(a, b) {
  const pa = splitRefdes(a);
  const pb = splitRefdes(b);
  if (pa.prefix !== pb.prefix) return pa.prefix < pb.prefix ? -1 : 1;
  return pa.num - pb.num;
}

// --------------------------------------------------------------------------
// collapseToRanges(tokens, statusOf)
// Collapses a sorted refdes array into range notation where possible.
//
// tokens:   sorted array of refdes strings (output of parseRefdesList)
// statusOf: function(token) → status class string (e.g. 'status-unique')
//           Pass () => '' to ignore status and collapse purely by sequence.
//
// A run can only extend while: same prefix, consecutive number, same status.
// Returns an array of { display, statusClass } objects.
//   display:     e.g. "R1-R5" or "R3"
//   statusClass: the status of every token in this run (they're all the same)
// --------------------------------------------------------------------------
function collapseToRanges(tokens, statusOf) {
  const groups = [];
  let i = 0;

  while (i < tokens.length) {
    const { prefix, num } = splitRefdes(tokens[i]);
    const status = statusOf(tokens[i]);

    // Extend the run as long as prefix, consecutive number, and status match
    let j = i + 1;
    while (j < tokens.length) {
      const { prefix: p2, num: n2 } = splitRefdes(tokens[j]);
      if (p2 === prefix && n2 === num + (j - i) && statusOf(tokens[j]) === status) {
        j++;
      } else {
        break;
      }
    }

    const runLength = j - i;
    const display = runLength > 1
      ? `${prefix}${num}-${prefix}${num + runLength - 1}`
      : tokens[i];

    groups.push({ display, statusClass: status });
    i = j;
  }

  return groups;
}

// --------------------------------------------------------------------------
// parseRefdesList(rawText, errorsOut?) — public entry point
//
// errorsOut: optional array; unrecognised tokens are pushed into it as raw
//            strings. Omit to preserve the original silent-drop behavior
//            (used by BOM import, which doesn't care about parse errors).
// --------------------------------------------------------------------------
function parseRefdesList(rawText, errorsOut) {
  if (!rawText || rawText.trim() === '') return [];

  const cleaned   = stripComments(rawText);
  const tokens    = cleaned.split(/[\s,;]+/).filter(Boolean);
  const expanded  = tokens.flatMap(t => expandToken(t, errorsOut));
  const unique    = [...new Set(expanded)];
  return unique.sort(naturalSort);
}

// --------------------------------------------------------------------------
// Node.js compatibility — allows require('./parser') outside the browser
// --------------------------------------------------------------------------
if (typeof module !== 'undefined') {
  module.exports = { parseRefdesList, splitRefdes, collapseToRanges };
}
