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

// roundCoord(s, scale?) — scales then rounds a coordinate string to 2 decimal places.
// scale defaults to 1. Returns the original string unchanged if it isn't a valid number.
function roundCoord(s, scale = 1) {
  const n = parseFloat(s);
  return isNaN(n) ? s : String(Math.round(n * scale * 100) / 100);
}

// MMD coordinates are in units 1000× larger than ISS (µm vs mm).
const MMD_COORD_SCALE = 0.001;

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
//
// Row field counts:
//   6 fields — normal component:  X, Y, Angle, IPN, Refdes, Package
//   5 fields — fiducial:          X, Y, Angle, MarkerType, Refdes
//     Fiducials have no BOM IPN. They are assigned IPN = "FIDUCIAL" and
//     the marker type (e.g. "r30") is stored as the package field.
//     The declared Part Count excludes fiducials, so they are counted
//     separately when validating against it.
//
// Note on fiducial refdes sorting: refdes like "BoardFid_1" contain an
// underscore, which falls outside the splitRefdes regex. They sort
// lexicographically as plain strings. With the 2–4 fiducials typical on
// a board this is harmless, but "BoardFid_2" would sort after "BoardFid_10".
// --------------------------------------------------------------------------
function parseMmdFile(text, errorsOut) {
  // sections: Map<sectionNameLower, Map<keyLower, value>>
  const sections     = {};
  const dataRows     = [];
  let   section      = null; // current section name (lowercased)
  let   lineNum      = 0;
  let   fiducialCount = 0;

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
      // Fields are tab-separated
      const fields = valueStr.split('\t');

      if (fields.length === 5) {
        // Fiducial row — no package field. Field order: X, Y, Angle, MarkerType, Refdes.
        const [xRaw, yRaw, angle, markerType, refdesStr] = fields.map(f => f.trim());
        fiducialCount++;
        dataRows.push({
          refdes:  refdesStr.toUpperCase() ? [refdesStr.toUpperCase()] : [],
          ipn:     'FIDUCIAL',
          package: markerType, // e.g. "r30" — fiducial marker size/type code
          x: roundCoord(xRaw, MMD_COORD_SCALE),
          y: roundCoord(yRaw, MMD_COORD_SCALE),
          angle,
        });
        continue;
      }

      if (fields.length !== 6) {
        if (errorsOut) errorsOut.push(`Line ${lineNum}: expected 5 or 6 tab-separated fields, got ${fields.length}`);
        continue;
      }

      const [xRaw, yRaw, angle, ipn, refdesStr, pkg] = fields.map(f => f.trim());

      dataRows.push({
        refdes:  refdesStr.toUpperCase() ? [refdesStr.toUpperCase()] : [],
        ipn:     ipn.toUpperCase(),
        package: pkg,
        x: roundCoord(xRaw, MMD_COORD_SCALE),
        y: roundCoord(yRaw, MMD_COORD_SCALE),
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

  const meta          = parseMeta(sections);
  const declaredCount = parseInt(meta.partCount, 10);
  const componentCount = dataRows.length - fiducialCount;

  // Warn only if component count (excluding fiducials) doesn't match declared Part Count
  if (!isNaN(declaredCount) && componentCount !== declaredCount) {
    if (errorsOut) {
      errorsOut.push(
        `Part Count declared ${declaredCount} but parsed ${componentCount} components` +
        (fiducialCount > 0 ? ` (+ ${fiducialCount} fiducials)` : '')
      );
    }
  }

  // Store fiducial count in meta for display in View Full Table
  if (fiducialCount > 0) meta.fiducialCount = String(fiducialCount);

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
