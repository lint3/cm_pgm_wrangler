// mmd-parser.js
// Parses MMD placement program files.
//
// Public API:
//   parseMmdFile(text, errorsOut?) → { meta, rows }
//
// Format overview:
//   INI-style sections ([Fiducial], [Part Info]).
//   Part data lines live in [Part Info] and start with '#':
//     #00000001=X\tY\tAngle\tIPN\tRefdes\tPackage
//   All other lines are key=value metadata pairs.
//
// Limitation:
//   Only refdes and ipn fields are populated in output rows.
//   The MMD format has no FN, MPN, or CPN data.

// --------------------------------------------------------------------------
// Utility helpers
// --------------------------------------------------------------------------

// roundCoord(s) — rounds a coordinate string to 3 decimal places.
// Returns the original string unchanged if it isn't a valid number.
function roundCoord(s) {
  const n = parseFloat(s);
  return isNaN(n) ? s : String(Math.round(n * 1000) / 1000);
}

// --------------------------------------------------------------------------
// parseMeta(sections)
// Builds the metadata object from the parsed section maps.
// --------------------------------------------------------------------------
function parseMeta(sections) {
  const fid    = sections['fiducial']  || new Map();
  const info   = sections['part info'] || new Map();

  return {
    partCount:           info.get('part count')           || '',
    coordinateTransform: info.get('coordinate transform') || '',
    fid1X: fid.get('fid1_x') || '',
    fid1Y: fid.get('fid1_y') || '',
    fid2X: fid.get('fid2_x') || '',
    fid2Y: fid.get('fid2_y') || '',
  };
}

// --------------------------------------------------------------------------
// parseMmdFile(text, errorsOut?)
// Main entry point.
//
//   text      — raw string content of the .mmd file
//   errorsOut — optional array; format errors are pushed here as strings
//
// Returns { meta, rows }.
// --------------------------------------------------------------------------
function parseMmdFile(text, errorsOut) {
  // sections: Map<sectionNameLower, Map<keyLower, value>>
  const sections  = {};
  const dataRows  = [];
  let   section   = null; // current section name (lowercased)
  let   lineNum   = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    lineNum++;
    const line = rawLine.trim();
    if (!line) continue;

    // Section header: [Section Name]
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).toLowerCase();
      if (!sections[section]) sections[section] = new Map();
      continue;
    }

    // Data row (part entry): starts with '#', only expected in [Part Info]
    if (line.startsWith('#')) {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) {
        if (errorsOut) errorsOut.push(`Line ${lineNum}: missing '=' in part entry`);
        continue;
      }

      const valueStr = line.slice(eqIdx + 1);
      // Fields are tab-separated: X, Y, Angle, IPN, Refdes, Package
      const fields = valueStr.split('\t');

      if (fields.length !== 6) {
        if (errorsOut) errorsOut.push(`Line ${lineNum}: expected 6 tab-separated fields, got ${fields.length}`);
        continue;
      }

      const [xRaw, yRaw, angle, ipn, refdesStr, pkg] = fields.map(f => f.trim());

      dataRows.push({
        refdes:  refdesStr.toUpperCase() ? [refdesStr.toUpperCase()] : [],
        ipn:     ipn.toUpperCase(),
        package: pkg,
        x: roundCoord(xRaw),
        y: roundCoord(yRaw),
        angle,
      });
      continue;
    }

    // Key=value metadata line
    if (section !== null) {
      const eqIdx = line.indexOf('=');
      if (eqIdx !== -1) {
        const key = line.slice(0, eqIdx).trim().toLowerCase();
        const val = line.slice(eqIdx + 1).trim();
        sections[section].set(key, val);
      }
      // Lines without '=' inside a section are silently ignored
    }
  }

  // Warn if actual row count doesn't match declared Part Count
  const meta         = parseMeta(sections);
  const declaredCount = parseInt(meta.partCount, 10);
  if (!isNaN(declaredCount) && dataRows.length !== declaredCount) {
    if (errorsOut) {
      errorsOut.push(
        `Part Count declared ${declaredCount} but parsed ${dataRows.length} rows`
      );
    }
  }

  return { meta, rows: dataRows };
}

// --------------------------------------------------------------------------
// Export for both browser (global) and Node.js (require)
// --------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMmdFile };
} else {
  window.parseMmdFile = parseMmdFile;
}
