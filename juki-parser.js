// juki-parser.js
// Parses Juki ISS placement program files (XML format).
//
// Public API:
//   parseIssFile(xmlString, errorsOut?) → { meta, rows }
//
// Limitations:
//   - Only refdes and ipn fields are populated in output rows.
//     The ISS format has no FN, MPN, or CPN data.
//   - x/y coordinates are per-circuit-reference, not absolute board
//     coordinates. On a panelized board they are relative to the
//     circuit's <referencePosition>, not the raw PCB edge.

// --------------------------------------------------------------------------
// Utility helpers
// --------------------------------------------------------------------------

// roundCoord(s) — rounds a coordinate string to 3 decimal places.
// Returns the original string unchanged if it isn't a valid number.
function roundCoord(s) {
  const n = parseFloat(s);
  return isNaN(n) ? s : String(Math.round(n * 1000) / 1000);
}

// getText(contextNode, cssSelector)
// Returns trimmed text content of the first matching descendant, or ''.
function getText(ctx, sel) {
  const el = ctx.querySelector(sel);
  return el ? el.textContent.trim() : '';
}

// getAttr(contextNode, cssSelector, attrName)
// Returns the attribute value of the first matching descendant, or ''.
function getAttr(ctx, sel, attr) {
  const el = ctx.querySelector(sel);
  return el ? (el.getAttribute(attr) || '') : '';
}

// --------------------------------------------------------------------------
// parseMeta(doc)
// Extracts assembly-level metadata from the document.
// --------------------------------------------------------------------------
function parseMeta(doc) {
  return {
    assemblyName:    getText(doc, 'core > pwbData > pwbId'),
    lastEdit:        getText(doc, 'headerData > lastEdit'),
    lineName:        getText(doc, 'headerData > lineConfiguration > lineName'),
    totalPlacements: getAttr(doc, 'headerData > headPlacement', 'total'),
  };
}

// --------------------------------------------------------------------------
// parseComponents(doc)
// Builds a Map from componentName (uppercase) to description string.
// Description comes from the <comment> field, which Juki uses for
// human-readable part descriptions (e.g. "#100nF 50V 0402").
// The leading '#' character is stripped if present — Juki uses it as a
// prefix convention, not part of the description itself.
// --------------------------------------------------------------------------
function parseComponents(doc) {
  const map = new Map();

  const components = doc.querySelectorAll('core > componentData > component');
  for (const comp of components) {
    const name    = getText(comp, 'componentName').toUpperCase();
    let   comment = getText(comp, 'comment');

    // Strip the conventional '#' prefix that Juki prepends to descriptions
    if (comment.startsWith('#')) comment = comment.slice(1);

    if (name) map.set(name, comment);
  }

  return map;
}

// --------------------------------------------------------------------------
// parsePlacements(doc, componentMap)
// Returns one row object per <placement> in core > placementData.
// Each row matches the app's bomRow shape where possible:
//   { refdes, ipn, description, x, y, angle, skip }
//
// refdes is a single-element array to match the bomRow convention.
// ipn and refdes are uppercased.
// Skipped placements (skip placement="YES") are INCLUDED with skip:'YES'.
// --------------------------------------------------------------------------
function parsePlacements(doc, componentMap) {
  const rows = [];

  const placements = doc.querySelectorAll('core > placementData > placement');
  for (const pl of placements) {
    const refdesStr = getText(pl, 'placementId').toUpperCase();
    const ipn       = getText(pl, 'componentName').toUpperCase();
    const x         = roundCoord(getAttr(pl, 'placementPosition', 'x'));
    const y         = roundCoord(getAttr(pl, 'placementPosition', 'y'));
    const angle     = getAttr(pl, 'placementAngle', 'angle');
    const skip      = getAttr(pl, 'skip', 'placement').toUpperCase() || 'NO';

    const description = componentMap.get(ipn) || '';

    const row = {
      refdes:      refdesStr ? [refdesStr] : [],
      ipn,
      description,
      x,
      y,
      angle,
      skip,
    };

    rows.push(row);
  }

  return rows;
}

// --------------------------------------------------------------------------
// parseIssFile(xmlString, errorsOut?)
// Main entry point. Parses a Juki ISS file string into structured data.
//
//   xmlString  — raw XML text content of the .iss file
//   errorsOut  — optional array; XML parse errors are pushed here as strings
//
// Returns { meta, rows } on success.
// Returns { meta: {}, rows: [] } if the XML is unparseable (error pushed).
// --------------------------------------------------------------------------
function parseIssFile(xmlString, errorsOut) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');

  // DOMParser signals parse failure by inserting a <parsererror> element
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    const msg = parseError.textContent.trim().split('\n')[0]; // first line only
    if (errorsOut) errorsOut.push('XML parse error: ' + msg);
    return { meta: {}, rows: [] };
  }

  const meta         = parseMeta(doc);
  const componentMap = parseComponents(doc);
  const rows         = parsePlacements(doc, componentMap);

  return { meta, rows };
}

// --------------------------------------------------------------------------
// Export for both browser (global) and Node.js (require)
// --------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseIssFile };
} else {
  window.parseIssFile = parseIssFile;
}
