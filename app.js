// Program Wrangler — app.js

// --------------------------------------------------------------------------
// Panel state
// Panels are objects with id, label, sourceType, bomRows[], and parseErrors[].
// Adding/removing panels means mutating this array, then calling runComparison().
// --------------------------------------------------------------------------
const PANEL_IDS = ['a', 'b', 'c', 'd']; // max 4 panels, fixed slot order

const panels = [
  { id: 'a', label: 'Panel A', sourceType: 'file', bomRows: [], parseErrors: [] },
  { id: 'b', label: 'Panel B', sourceType: 'file', bomRows: [], parseErrors: [] },
];

// --------------------------------------------------------------------------
// Config state
// --------------------------------------------------------------------------
const config = {
  viewMode: 'all', // 'all' | 'diff-rows' | 'diff-only'
};

// --------------------------------------------------------------------------
// escAttr(s) — escapes a string for safe use in an HTML attribute value.
// --------------------------------------------------------------------------
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// --------------------------------------------------------------------------
// Config bar wiring
// --------------------------------------------------------------------------
function initConfigBar() {
  document.querySelectorAll('input[name="view-mode"]').forEach(radio => {
    radio.addEventListener('change', e => {
      config.viewMode = e.target.value;
      runComparison();
    });
  });
}

function syncConfigBarUI() {
  const radio = document.querySelector(`input[name="view-mode"][value="${config.viewMode}"]`);
  if (radio) radio.checked = true;
}

// --------------------------------------------------------------------------
// addPanel() / deletePanel(id)
// --------------------------------------------------------------------------
function addPanel() {
  if (panels.length >= 4) return;
  const usedIds = new Set(panels.map(p => p.id));
  const id      = PANEL_IDS.find(s => !usedIds.has(s));
  panels.push({ id, label: 'Panel ' + id.toUpperCase(), sourceType: 'file', bomRows: [], parseErrors: [] });
  runComparison();
}

function deletePanel(id) {
  panels.splice(panels.findIndex(p => p.id === id), 1);
  runComparison();
}

// --------------------------------------------------------------------------
// buildPanelData(panel)
// Builds a two-level index for one panel:
//   Map<IPN, { attributes: {fn,cpn,mpn,description}, refdes: Map<Refdes, {x,y,angle,skip,package}> }>
//
// Iterates bomRows, grouping by IPN.
//   XLSX BOM rows have multiple refdes but no coords.
//   Juki/MMD rows have one refdes with coords.
// --------------------------------------------------------------------------
function buildPanelData(panel) {
  const result = new Map();

  // bom / juki / mmd
  for (const row of (panel.bomRows || [])) {
    const ipn = row.ipn;
    if (!ipn) continue;

    if (!result.has(ipn)) {
      result.set(ipn, {
        attributes: {
          fn:          row.fn          || undefined,
          cpn:         row.cpn         || undefined,
          mpn:         row.mpn         || undefined,
          description: row.description || undefined,
        },
        refdes: new Map(),
      });
    } else {
      // Merge any attributes present on this row that weren't on the first row
      const existing = result.get(ipn).attributes;
      if (!existing.fn          && row.fn)          existing.fn          = row.fn;
      if (!existing.cpn         && row.cpn)         existing.cpn         = row.cpn;
      if (!existing.mpn         && row.mpn)         existing.mpn         = row.mpn;
      if (!existing.description && row.description) existing.description = row.description;
    }

    // Coord data — only present for Juki/MMD rows (XLSX BOM refdes have no coords)
    const coords = {};
    if (row.x       !== undefined) coords.x       = row.x;
    if (row.y       !== undefined) coords.y        = row.y;
    if (row.angle   !== undefined) coords.angle    = row.angle;
    if (row.skip    !== undefined) coords.skip     = row.skip;
    if (row.package !== undefined) coords.package  = row.package;

    const refdesMap = result.get(ipn).refdes;
    for (const r of (row.refdes || [])) {
      refdesMap.set(r, coords);
    }
  }

  return result;
}

// --------------------------------------------------------------------------
// computeIpnRow(ipn, panelData, panels)
// Returns a comparison row object for one IPN:
//   { ipn, panelEntries, refdesRows, attrRows, ipnStatus }
// --------------------------------------------------------------------------
function computeIpnRow(ipn, panelData, panels) {
  const panelEntries = panels.map((_, i) => panelData[i].get(ipn) ?? null);

  // Collect all unique refdes across panels that have this IPN, then natural-sort
  const allRefdesSet = new Set();
  for (const entry of panelEntries) {
    if (!entry) continue;
    for (const r of entry.refdes.keys()) allRefdesSet.add(r);
  }
  const allRefdes = [...allRefdesSet].sort((a, b) => {
    // Reuse splitRefdes from parser.js for natural ordering
    const pa = splitRefdes(a), pb = splitRefdes(b);
    if (pa.prefix !== pb.prefix) return pa.prefix < pb.prefix ? -1 : 1;
    return pa.num - pb.num;
  });

  // Build refdes sub-rows
  const refdesRows = allRefdes.map(r => {
    const cells        = panelEntries.map(e => e?.refdes.get(r) ?? null);
    const presentCount = cells.filter(c => c !== null).length;

    let status;
    if (presentCount < panels.length) {
      status = 'missing';
    } else {
      // Compare coord strings from panels that actually have coord data
      const coordStrings = cells
        .filter(c => c !== null && c.x !== undefined)
        .map(c => `${c.x},${c.y},${c.angle}`);
      status = (coordStrings.length > 1 && new Set(coordStrings).size > 1) ? 'differ' : 'match';
    }
    return { refdes: r, cells, status };
  });

  // Build attribute sub-rows — only for attrs present in at least one panel
  const ATTRS = ['fn', 'cpn', 'mpn'];
  const attrRows = ATTRS
    .filter(k => panelEntries.some(e => e?.attributes[k]))
    .map(k => ({
      attr:  k,
      cells: panelEntries.map(e => e?.attributes[k] ?? null),
    }));

  // IPN-level status
  const presentCount = panelEntries.filter(e => e !== null).length;
  let ipnStatus;
  if (presentCount < panels.length) {
    ipnStatus = 'missing';
  } else if (refdesRows.some(r => r.status !== 'match')) {
    ipnStatus = 'differ';
  } else {
    ipnStatus = 'match';
  }

  return { ipn, panelEntries, refdesRows, attrRows, ipnStatus };
}

// --------------------------------------------------------------------------
// postProcessIpnChanges(compRows, panels)
// Post-processing step run after all IPN rows are computed.
// Finds pairs of 'missing' IPN rows that have identical refdes sets AND are
// perfectly complementary (one covers exactly the panels the other lacks).
// Such a pair is collapsed into a single 'changed' row: IPN-A ↔ IPN-B.
//
// Ambiguous cases (two pairs share the same refdes key) are left as missing.
// Empty refdes keys (IPNs with no placed parts) are never collapsed.
// --------------------------------------------------------------------------
function postProcessIpnChanges(compRows, panels) {
  const allPanelsMask = (1 << panels.length) - 1;

  // Record original index of each row for later positional insertion
  const originalIdx = new Map(); // ipn → index in compRows
  const missingRows = [];
  for (let i = 0; i < compRows.length; i++) {
    const row = compRows[i];
    originalIdx.set(row.ipn, i);
    if (row.ipnStatus === 'missing') missingRows.push(row);
  }

  // Annotate each missing row with its presence bitmask and refdes key
  const enriched = missingRows.map(row => {
    let presenceMask = 0;
    const allRefdes  = new Set();
    row.panelEntries.forEach((entry, i) => {
      if (entry !== null) {
        presenceMask |= (1 << i);
        entry.refdes.forEach((_, r) => allRefdes.add(r));
      }
    });
    const refdesKey = [...allRefdes].sort().join('|');
    return { row, presenceMask, refdesKey };
  });

  // Group by refdesKey; skip empty keys (IPNs with no placed parts)
  const byRefdesKey = new Map(); // refdesKey → enriched[]
  for (const item of enriched) {
    if (!item.refdesKey) continue;
    if (!byRefdesKey.has(item.refdesKey)) byRefdesKey.set(item.refdesKey, []);
    byRefdesKey.get(item.refdesKey).push(item);
  }

  // Find complementary pairs — claim each IPN at most once
  const claimed     = new Set();  // IPN strings already in a merged pair
  const mergedPairs = [];         // { mergedRow, earlierIdx }

  for (const items of byRefdesKey.values()) {
    if (items.length < 2) continue;

    // If more than two items share a refdesKey the match is ambiguous; skip all
    if (items.length > 2) continue;

    const [A, B] = items;
    if (claimed.has(A.row.ipn) || claimed.has(B.row.ipn)) continue;
    if ((A.presenceMask | B.presenceMask) !== allPanelsMask) continue;
    if ((A.presenceMask & B.presenceMask) !== 0) continue;

    // A and B are complementary — build the merged row
    claimed.add(A.row.ipn);
    claimed.add(B.row.ipn);

    // Alphabetical order for display: "IPN-A ↔ IPN-B"
    const [first, second] = A.row.ipn < B.row.ipn ? [A, B] : [B, A];
    const mergedIpn = `${first.row.ipn} ↔ ${second.row.ipn}`;

    // panelEntries: each panel takes from whichever source IPN is present there
    const mergedPanelEntries = panels.map((_, i) =>
      A.row.panelEntries[i] !== null ? A.row.panelEntries[i] : B.row.panelEntries[i]
    );

    // refdesRows: merge cells from A and B (refdes sets are identical, cells are disjoint)
    const refdesMergeMap = new Map(); // refdes → cells[]
    for (const refRow of A.row.refdesRows) {
      refdesMergeMap.set(refRow.refdes, [...refRow.cells]);
    }
    for (const refRow of B.row.refdesRows) {
      const existing = refdesMergeMap.get(refRow.refdes);
      if (existing) {
        refRow.cells.forEach((cell, i) => { if (cell !== null) existing[i] = cell; });
      } else {
        refdesMergeMap.set(refRow.refdes, [...refRow.cells]);
      }
    }
    const mergedRefdesRows = [...refdesMergeMap.entries()].map(([refdes, cells]) => ({
      refdes,
      cells,
      status: cells.every(c => c !== null) ? 'match' : 'differ',
    }));

    // attrRows: combine from both sources, deduplicate by attr key, merge cells
    const attrMergeMap = new Map(); // attr → cells[]
    for (const attrRow of [...A.row.attrRows, ...B.row.attrRows]) {
      if (!attrMergeMap.has(attrRow.attr)) {
        attrMergeMap.set(attrRow.attr, [...attrRow.cells]);
      } else {
        const existing = attrMergeMap.get(attrRow.attr);
        attrRow.cells.forEach((cell, i) => { if (cell !== null) existing[i] = cell; });
      }
    }
    const mergedAttrRows = [...attrMergeMap.entries()].map(([attr, cells]) => ({ attr, cells }));

    const mergedRow = {
      ipn:          mergedIpn,
      ipnStatus:    'changed',
      panelEntries: mergedPanelEntries,
      refdesRows:   mergedRefdesRows,
      attrRows:     mergedAttrRows,
      changedA:     { ipn: A.row.ipn, mask: A.presenceMask },
      changedB:     { ipn: B.row.ipn, mask: B.presenceMask },
    };

    mergedPairs.push({
      mergedRow,
      earlierIdx: Math.min(originalIdx.get(A.row.ipn), originalIdx.get(B.row.ipn)),
    });
  }

  if (mergedPairs.length === 0) return compRows;

  // Reconstruct compRows: at the position of the earlier source IPN, insert the
  // merged row; skip both source IPNs wherever they appear.
  const mergedByEarlierIdx = new Map(mergedPairs.map(p => [p.earlierIdx, p.mergedRow]));

  const result = [];
  for (let i = 0; i < compRows.length; i++) {
    if (mergedByEarlierIdx.has(i)) {
      // Insert the merged row at the position of the earlier source IPN
      result.push(mergedByEarlierIdx.get(i));
      // Fall through to the claimed check — the source row at i is skipped below
    }
    if (!claimed.has(compRows[i].ipn)) {
      result.push(compRows[i]);
    }
  }
  return result;
}

// --------------------------------------------------------------------------
// buildRefdescells(refRow, diffOnly)
// Builds the HTML <td> cells for one refdes sub-row.
//
// In normal mode: each cell shows all coord fields (location, angle, skip, pkg).
// In diff-only mode: each cell shows only the fields that differ across panels.
//   Location (X,Y) is treated as a single unit — if either differs, both are shown.
//   Angle, skip, and package are each shown/hidden independently.
// --------------------------------------------------------------------------
function buildRefdescells(refRow, diffOnly) {
  if (!diffOnly) {
    return refRow.cells.map(coords => {
      if (!coords) return `<td class="cell-absent">—</td>`;
      if (coords.x !== undefined) {
        const parts = [`${coords.x}, ${coords.y}, ${coords.angle}°`];
        if (coords.skip && coords.skip !== 'NO') parts.push(`skip:${coords.skip}`);
        if (coords.package) parts.push(coords.package);
        return `<td class="cell-present">${escAttr(parts.join(' | '))}</td>`;
      }
      return `<td class="cell-present">✓</td>`;
    }).join('');
  }

  // Diff-only: determine which fields vary across panels with coord data
  const coordCells = refRow.cells.filter(c => c !== null && c.x !== undefined);
  const showLocation = coordCells.length > 1 && new Set(coordCells.map(c => `${c.x},${c.y}`)).size > 1;
  const showAngle    = coordCells.length > 1 && new Set(coordCells.map(c => String(c.angle))).size > 1;
  const showSkip     = coordCells.length > 1 && new Set(coordCells.map(c => c.skip ?? '')).size > 1;
  const showPackage  = coordCells.length > 1 && new Set(coordCells.map(c => c.package ?? '')).size > 1;

  return refRow.cells.map(coords => {
    if (!coords) return `<td class="cell-absent">—</td>`;
    if (coords.x === undefined) return `<td class="cell-present">✓</td>`;
    const parts = [];
    if (showLocation) parts.push(`${coords.x}, ${coords.y}`);
    if (showAngle)    parts.push(`${coords.angle}°`);
    if (showSkip && coords.skip && coords.skip !== 'NO') parts.push(`skip:${coords.skip}`);
    if (showPackage && coords.package) parts.push(coords.package);
    return parts.length > 0
      ? `<td class="cell-present">${escAttr(parts.join(' | '))}</td>`
      : `<td></td>`;
  }).join('');
}

// --------------------------------------------------------------------------
// renderComparison(compRows, panels)
// Builds and injects the comparison table HTML.
// --------------------------------------------------------------------------
function renderComparison(compRows, panels) {
  const body        = document.getElementById('comparison-body');
  const countEl     = document.getElementById('comparison-count');
  const totalRows   = compRows.length;
  const diffRows    = compRows.filter(r => r.ipnStatus !== 'match').length;

  const hideControls = () => {
    document.getElementById('btn-expand-all').setAttribute('hidden', '');
    document.getElementById('btn-collapse-all').setAttribute('hidden', '');
  };

  if (totalRows === 0) {
    body.innerHTML = '<p class="comparison-empty">No IPN data found in loaded panels.</p>';
    countEl.textContent = '';
    hideControls();
    return;
  }

  // Update count display
  if (config.viewMode === 'diff-rows' || config.viewMode === 'diff-only') {
    countEl.textContent = `${diffRows} of ${totalRows} rows`;
  } else {
    countEl.textContent = `${totalRows} rows`;
  }

  // Both diff-rows and diff-only hide matching IPN rows via CSS class on the table
  const tableClass = (config.viewMode === 'diff-rows' || config.viewMode === 'diff-only') ? ' view-diff-rows' : '';

  // Non-match rows auto-expand in any non-'all' mode
  const autoExpandDiff = config.viewMode !== 'all';

  // Build table header — editable label input + filename below
  const panelHeaders = panels.map(p => `
    <th class="col-panel-header">
      <div class="col-label-row">
        <input type="text" class="col-label-input" value="${escAttr(p.label)}" data-panel-id="${escAttr(p.id)}">
        <button class="btn-fade btn-danger btn-remove-col" data-panel-id="${escAttr(p.id)}" title="Remove">×</button>
      </div>
      <span class="col-filename">${escAttr(p.filename || '')}</span>
    </th>`).join('');
  let html = `<table class="comparison-table${tableClass}">`;
  html += `<thead><tr><th class="col-key">IPN</th>${panelHeaders}</tr></thead><tbody>`;

  for (const row of compRows) {
    const ipnEsc    = escAttr(row.ipn);
    const autoOpen  = autoExpandDiff && row.ipnStatus !== 'match';
    const subHidden = autoOpen ? '' : ' hidden';
    const btnArrow  = autoOpen ? '▼' : '▶';

    // IPN summary row — changed rows show which IPN applies per panel
    let panelCells;
    if (row.ipnStatus === 'changed') {
      panelCells = row.panelEntries.map((entry, i) => {
        if (!entry) return `<td class="cell-absent">—</td>`;
        const count    = entry.refdes.size;
        const panelIpn = (row.changedA.mask & (1 << i)) ? row.changedA.ipn : row.changedB.ipn;
        const label    = `${panelIpn} — ${count} refdes`;
        return `<td class="cell-present">${escAttr(label)}</td>`;
      }).join('');
    } else {
      panelCells = row.panelEntries.map(entry => {
        if (!entry) return `<td class="cell-absent">—</td>`;
        const count = entry.refdes.size;
        const label = count === 0 ? '✓' : `${count} refdes`;
        return `<td class="cell-present">${escAttr(label)}</td>`;
      }).join('');
    }

    // Key cell — changed rows get a badge
    const ipnDisplay = row.ipnStatus === 'changed'
      ? `${ipnEsc} <span class="badge-changed">changed</span>`
      : ipnEsc;

    html += `<tr class="ipn-row row-${row.ipnStatus}" data-ipn="${ipnEsc}">`;
    html += `<td class="col-key"><button class="btn-expand">${btnArrow}</button> ${ipnDisplay}</td>`;
    html += panelCells;
    html += `</tr>`;

    // Attribute sub-rows
    for (const attrRow of row.attrRows) {
      const attrLabel = attrRow.attr.toUpperCase();
      const attrCells = attrRow.cells.map(val =>
        val !== null ? `<td>${escAttr(val)}</td>` : `<td class="cell-absent">—</td>`
      ).join('');
      html += `<tr class="sub-row attr-row" data-parent="${ipnEsc}"${subHidden}>`;
      html += `<td class="col-key col-sub">${attrLabel}</td>${attrCells}`;
      html += `</tr>`;
    }

    // Refdes sub-rows — cell content filtered in 'diff-only' mode
    const diffOnlyCells = config.viewMode === 'diff-only';
    for (const refRow of row.refdesRows) {
      const refdesLabel = escAttr(refRow.refdes);
      const refdescells = buildRefdescells(refRow, diffOnlyCells);
      html += `<tr class="sub-row refdes-row row-${refRow.status}" data-parent="${ipnEsc}"${subHidden}>`;
      html += `<td class="col-key col-sub">↳ ${refdesLabel}</td>${refdescells}`;
      html += `</tr>`;
    }
  }

  html += '</tbody></table>';
  body.innerHTML = html;

  // Wire column label inputs and remove buttons
  const table = body.querySelector('.comparison-table');
  table.querySelectorAll('.col-label-input').forEach(input => {
    const panel = panels.find(p => p.id === input.dataset.panelId);
    input.addEventListener('input', () => { if (panel) panel.label = input.value; });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  });
  table.querySelectorAll('.btn-remove-col').forEach(btn => {
    btn.addEventListener('click', () => deletePanel(btn.dataset.panelId));
  });

  // Wire per-row expand/collapse toggle buttons
  table.querySelectorAll('.btn-expand').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const ipn     = btn.closest('tr').dataset.ipn;
      const subRows = table.querySelectorAll(`[data-parent="${CSS.escape(ipn)}"]`);
      const isOpen  = subRows.length > 0 && !subRows[0].hasAttribute('hidden');
      subRows.forEach(r => r.toggleAttribute('hidden', isOpen));
      btn.textContent = isOpen ? '▶' : '▼';
    });
  });

  // Wire expand-all / collapse-all buttons (shown only when table is present)
  const btnExpandAll   = document.getElementById('btn-expand-all');
  const btnCollapseAll = document.getElementById('btn-collapse-all');

  function setAllExpanded(open) {
    table.querySelectorAll('.sub-row').forEach(r => {
      // In diff-rows and diff-only modes, don't expand sub-rows of hidden match rows
      if (open && config.viewMode !== 'all') {
        const parentIpn = r.dataset.parent;
        const parentRow = table.querySelector(`.ipn-row[data-ipn="${CSS.escape(parentIpn)}"]`);
        if (parentRow?.classList.contains('row-match')) return;
      }
      r.toggleAttribute('hidden', !open);
    });
    table.querySelectorAll('.btn-expand').forEach(b => {
      if (open && config.viewMode !== 'all') {
        const parentRow = b.closest('tr');
        if (parentRow?.classList.contains('row-match')) return;
      }
      b.textContent = open ? '▼' : '▶';
    });
  }

  btnExpandAll.removeAttribute('hidden');
  btnCollapseAll.removeAttribute('hidden');
  btnExpandAll.addEventListener('click',   () => setAllExpanded(true));
  btnCollapseAll.addEventListener('click', () => setAllExpanded(false));
}

// --------------------------------------------------------------------------
// runComparison()
// Builds per-panel data indexes, computes comparison rows, renders the
// comparison table. Uses only panels that have data loaded.
// --------------------------------------------------------------------------
function runComparison() {
  const panelData    = panels.map(buildPanelData);
  const activePanels = panels.filter((_, i) => panelData[i].size > 0);
  const activeData   = activePanels.map(p => panelData[panels.indexOf(p)]);

  if (activePanels.length === 0) {
    renderLandingZone();
    return;
  }

  // Union of all IPNs across active panels, natural-sorted
  const allIPNsSet = new Set();
  for (const pd of activeData) pd.forEach((_, ipn) => allIPNsSet.add(ipn));
  const allIPNs = [...allIPNsSet].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

  // Build one comparison row per IPN, then collapse complementary IPN-change pairs
  const rawRows  = allIPNs.map(ipn => computeIpnRow(ipn, activeData, activePanels));
  const compRows = postProcessIpnChanges(rawRows, activePanels);

  renderComparison(compRows, activePanels);
}

// --------------------------------------------------------------------------
// renderLandingZone()
// Renders a Browse button prompt into #comparison-body when no files are
// loaded. Drag-and-drop is handled page-wide by initPageDropZone().
// --------------------------------------------------------------------------
function renderLandingZone() {
  const body    = document.getElementById('comparison-body');
  const countEl = document.getElementById('comparison-count');
  countEl.textContent = '';
  document.getElementById('btn-expand-all').setAttribute('hidden', '');
  document.getElementById('btn-collapse-all').setAttribute('hidden', '');

  body.innerHTML = `
    <div class="drop-zone-landing">
      <input type="file" class="file-input-landing" accept=".xlsx,.iss,.mmd" hidden>
      <button class="btn-browse btn-browse-landing">Browse</button>
      <span class="drop-zone-label">or drag a file anywhere on the page</span>
    </div>
  `;

  const fileInput = body.querySelector('.file-input-landing');
  body.querySelector('.btn-browse-landing').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    fileInput.value = '';
    handleBomFile(file, getDropTargetPanelId());
  });
}

// --------------------------------------------------------------------------
// getDropTargetPanelId()
// Returns the id of a panel to load a dropped file into:
//   - The first panel with no data loaded, if any.
//   - A newly created panel, if under the 4-panel cap.
//   - null if all panels are full.
// --------------------------------------------------------------------------
function getDropTargetPanelId() {
  const empty = panels.find(p => !p.bomRows || p.bomRows.length === 0);
  if (empty) return empty.id;
  if (panels.length < 4) {
    addPanel();
    return panels[panels.length - 1].id;
  }
  return null;
}

// --------------------------------------------------------------------------
// initPageDropZone()
// Makes the entire viewport a persistent drag-and-drop target.
// Shows a fixed overlay ring while a file is being dragged over the page.
// On drop, routes the file to the next available panel slot.
// --------------------------------------------------------------------------
function initPageDropZone() {
  const overlay = document.getElementById('drop-overlay');
  // dragCounter tracks nested dragenter/dragleave pairs so the overlay only
  // hides when the drag truly leaves the window (not just crosses child elements).
  let dragCounter = 0;

  document.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounter++;
    overlay.removeAttribute('hidden');
  });

  document.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter === 0) overlay.setAttribute('hidden', '');
  });

  document.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  });

  document.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    overlay.setAttribute('hidden', '');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const panelId = getDropTargetPanelId();
    if (panelId) handleBomFile(file, panelId);
  });
}



// --------------------------------------------------------------------------
// Role auto-detection: maps common BOM header text to a role name.
// Tested against the trimmed header string, case-insensitive.
// --------------------------------------------------------------------------
const ROLE_DETECT = [
  { role: 'fn',     pattern: /^(fn|find|find\s*num\.?|find\s*number|item\s*no?\.?|line\s*item)$/i },
  { role: 'ipn',    pattern: /^(ipn|internal\s*part(\s*number)?|part\s*#?)$/i },
  { role: 'mpn',    pattern: /^(mpn|mfr\.?\s*part(\s*number)?|manufacturer\s*part(\s*number)?|mfg\.?\s*part)$/i },
  { role: 'cpn',    pattern: /^(cpn|customer\s*part(\s*number)?)$/i },
  { role: 'refdes', pattern: /^(refdes|ref\.?\s*des\.?|reference|designator|ref\.?)$/i },
  { role: 'qty',    pattern: /^(qty|quantity|count)$/i },
  { role: 'side',   pattern: /^(side|mount|placement|layer)$/i },
];

function detectRole(headerText) {
  const h = String(headerText).trim();
  for (const { role, pattern } of ROLE_DETECT) {
    if (pattern.test(h)) return role;
  }
  return 'ignore';
}

// Options shown in each column-role dropdown, in display order.
const ROLE_OPTIONS = [
  { value: 'ignore', label: '-' },
  { value: 'fn',     label: 'FN' },
  { value: 'ipn',    label: 'IPN' },
  { value: 'mpn',    label: 'MPN' },
  { value: 'cpn',    label: 'CPN' },
  { value: 'refdes', label: 'Refdes' },
  { value: 'qty',    label: 'Qty' },
];

// --------------------------------------------------------------------------
// BOM import
// "Load BOM" button triggers a hidden file input. Drag-and-drop anywhere on
// the page also works. SheetJS reads sheet 1, then the column-mapping modal
// is shown.
// --------------------------------------------------------------------------

// Stored while the modal is open; cleared on cancel or confirm.
// All raw rows from the file (not pre-split); header row is chosen by the user.
let _pendingAllRows  = null;
let _pendingPanelId  = null;
let _pendingFilename = null;

// --------------------------------------------------------------------------
// handleBomFile(file, panelId)
// Reads a File object and dispatches to the appropriate parser.
// XLSX files open the column-mapping modal; ISS and MMD are parsed directly.
// --------------------------------------------------------------------------
function handleBomFile(file, panelId) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'xlsx') {
    const reader = new FileReader();
    reader.onload = e => {
      const workbook = XLSX.read(e.target.result, { type: 'array' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      // header:1 gives array-of-arrays; defval:'' keeps empty cells in place
      const allRows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      _pendingPanelId  = panelId;
      _pendingFilename = file.name;
      showMappingModal(allRows);
    };
    reader.readAsArrayBuffer(file);

  } else if (ext === 'iss') {
    const reader = new FileReader();
    reader.onload = e => {
      const errors          = [];
      const { meta, rows }  = parseIssFile(e.target.result, errors);
      const panel           = panels.find(p => p.id === panelId);
      if (panel) {
        panel.bomRows     = rows;
        panel.meta        = meta;
        panel.parseErrors = errors;
        panel.sourceType  = 'juki';
        panel.filename    = file.name;
      }
      runComparison();
    };
    reader.readAsText(file);

  } else if (ext === 'mmd') {
    const reader = new FileReader();
    reader.onload = e => {
      const errors          = [];
      const { meta, rows }  = parseMmdFile(e.target.result, errors);
      const panel           = panels.find(p => p.id === panelId);
      if (panel) {
        panel.bomRows     = rows;
        panel.meta        = meta;
        panel.parseErrors = errors;
        panel.sourceType  = 'mmd';
        panel.filename    = file.name;
      }
      runComparison();
    };
    reader.readAsText(file);
  }
}

function initBomImport() {
  // Wire mapping modal close/cancel/confirm — these buttons live in static HTML
  document.getElementById('bom-header-row').addEventListener('change', e => {
    const idx = Math.max(0, parseInt(e.target.value, 10) - 1);
    e.target.value = idx + 1;
    repopulateMappingTable(idx);
  });

  document.getElementById('btn-modal-close').addEventListener('click',   closeMappingModal);
  document.getElementById('btn-modal-cancel').addEventListener('click',  closeMappingModal);
  document.getElementById('btn-modal-confirm').addEventListener('click', confirmMapping);
}

// --------------------------------------------------------------------------
// showMappingModal(allRows)
// Stores all rows from the file and opens the column-mapping modal.
// The user picks which row contains the headers via the number input;
// repopulateMappingTable() rebuilds the column table whenever that changes.
// --------------------------------------------------------------------------
function showMappingModal(allRows) {
  _pendingAllRows = allRows;

  const headerRowInput = document.getElementById('bom-header-row');
  headerRowInput.max   = allRows.length;
  headerRowInput.value = '1';

  repopulateMappingTable(0); // row 1 → index 0

  document.getElementById('bom-modal').removeAttribute('hidden');
}

// --------------------------------------------------------------------------
// repopulateMappingTable(headerRowIdx)
// Rebuilds the mapping table using the given row (0-based) as column headers.
// Auto-detects roles from the header text.
// --------------------------------------------------------------------------
function repopulateMappingTable(headerRowIdx) {
  const headers = (_pendingAllRows[headerRowIdx] || []).map(String);

  const tbody = document.querySelector('#modal-mapping-table tbody');
  tbody.innerHTML = '';

  headers.forEach((header, colIdx) => {
    const detectedRole = detectRole(header);

    const optionsHtml = ROLE_OPTIONS
      .map(opt => `<option value="${opt.value}"${opt.value === detectedRole ? ' selected' : ''}>${opt.label}</option>`)
      .join('');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="modal-col-header">${header || '(empty)'}</td>
      <td><select class="modal-role-select" data-col="${colIdx}">${optionsHtml}</select></td>
    `;
    tbody.appendChild(tr);
  });
}

function closeMappingModal() {
  document.getElementById('bom-modal').setAttribute('hidden', '');
  _pendingAllRows  = null;
  _pendingPanelId  = null;
  _pendingFilename = null;
}

// --------------------------------------------------------------------------
// confirmMapping()
// Reads role assignments from the modal dropdowns, builds rows, and stores
// them on the target panel.
// --------------------------------------------------------------------------
function confirmMapping() {
  // Build colIndex → role mapping from the dropdown selections
  const mapping = {};
  document.querySelectorAll('.modal-role-select').forEach(sel => {
    mapping[parseInt(sel.dataset.col, 10)] = sel.value;
  });

  // Data rows are everything after the selected header row
  const headerRowIdx = Math.max(0, parseInt(document.getElementById('bom-header-row').value, 10) - 1);
  const dataRows     = _pendingAllRows.slice(headerRowIdx + 1);

  // Build typed BOM rows and store on the target panel
  const panel = panels.find(p => p.id === _pendingPanelId);
  if (panel) {
    panel.bomRows    = buildBomRows(dataRows, mapping);
    panel.sourceType = 'bom';
    panel.filename   = _pendingFilename;
  }

  closeMappingModal();
  runComparison();
}

// --------------------------------------------------------------------------
// buildBomRows(rawRows, mapping)
// Converts SheetJS array-of-arrays rows into typed row objects.
//   rawRows: array of arrays (data rows only, header row excluded)
//   mapping: { colIndex: role, ... }
// Refdes cells are pre-parsed through parseRefdesList().
// All other values are uppercased strings.
// Empty rows (no non-ignore cells) are skipped.
// --------------------------------------------------------------------------
function buildBomRows(rawRows, mapping) {
  const result = [];

  for (const rawRow of rawRows) {
    const row = {};

    for (const [colIdxStr, role] of Object.entries(mapping)) {
      if (role === 'ignore') continue;
      const colIdx    = parseInt(colIdxStr, 10);
      const cellValue = String(rawRow[colIdx] ?? '').trim();
      if (!cellValue) continue;

      if (role === 'refdes') {
        // Refdes cells may contain ranges or delimited lists — pre-parse them
        row.refdes = parseRefdesList(cellValue);
      } else {
        row[role] = cellValue.toUpperCase();
      }
    }

    if (Object.keys(row).length > 0) result.push(row);
  }

  return result;
}

// --------------------------------------------------------------------------
// Session persistence — not yet implemented
// --------------------------------------------------------------------------
function loadState() {}

function clearState() {
  syncConfigBarUI();
  runComparison();
}

// --------------------------------------------------------------------------
// Full-table modal
// openTableModal(panel): populates and shows the modal for the given panel.
// If panel.bomRows is empty, shows a placeholder message.
// Once real data is available, renders a <table> with one column per BOM key.
// --------------------------------------------------------------------------
function openTableModal(panel) {
  document.getElementById('table-modal-title').textContent = panel.label;
  const body = document.getElementById('table-modal-body');

  if (!panel.bomRows || panel.bomRows.length === 0) {
    body.innerHTML = '<p class="table-modal-empty">(no data loaded)</p>';
  } else {
    let html = '';

    // Metadata section — only rendered when panel.meta has non-empty values
    if (panel.meta) {
      const META_LABELS = [
        { key: 'assemblyName',    label: 'Assembly' },
        { key: 'lineName',        label: 'Line' },
        { key: 'lastEdit',        label: 'Last edit' },
        { key: 'totalPlacements', label: 'Total placements' },
        { key: 'fiducialCount',   label: 'Fiducials' },
      ];
      const metaRows = META_LABELS
        .filter(({ key }) => panel.meta[key])
        .map(({ key, label }) => `<dt>${escAttr(label)}</dt><dd>${escAttr(panel.meta[key])}</dd>`)
        .join('');
      if (metaRows) {
        html += `<dl class="table-modal-meta">${metaRows}</dl>`;
      }
    }

    // Rows table — collect all unique keys across all rows (preserves insertion order)
    const keys  = [...new Set(panel.bomRows.flatMap(row => Object.keys(row)))];
    const thead = keys.map(k => `<th>${escAttr(k.toUpperCase())}</th>`).join('');
    const tbody = panel.bomRows.map(row => {
      const cells = keys.map(k => {
        const val  = row[k];
        const text = Array.isArray(val) ? val.join(', ') : String(val ?? '');
        return `<td>${escAttr(text)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    html += `<table class="full-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;

    body.innerHTML = html;
  }

  document.getElementById('table-modal').removeAttribute('hidden');
}

function closeTableModal() {
  document.getElementById('table-modal').setAttribute('hidden', '');
}

function initTableModal() {
  document.getElementById('btn-table-modal-close').addEventListener('click', closeTableModal);
  // Close when clicking the backdrop (outside the modal box)
  document.getElementById('table-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('table-modal')) closeTableModal();
  });
}


// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
loadState();
initConfigBar();
syncConfigBarUI();
initBomImport();
initTableModal();
initPageDropZone();
runComparison();

const _addFileInput = document.getElementById('file-input-add');
document.getElementById('btn-add-file').addEventListener('click', () => _addFileInput.click());
_addFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  _addFileInput.value = '';
  const panelId = getDropTargetPanelId();
  if (panelId) handleBomFile(file, panelId);
});
// Two-click confirmation: first click arms the button; second click within
// 2 seconds executes. Clicking elsewhere or waiting resets it.
(function () {
  const btn = document.getElementById('btn-clear');
  let armed = false;
  let timer = null;

  function disarm() {
    armed = false;
    btn.textContent = 'Clear everything';
    btn.classList.remove('btn-clear-armed');
  }

  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Sure?';
      btn.classList.add('btn-clear-armed');
      timer = setTimeout(disarm, 2000);
    } else {
      clearTimeout(timer);
      disarm();
      clearState();
    }
  });

  // Clicking anywhere else disarms
  document.addEventListener('click', e => {
    if (armed && e.target !== btn) disarm();
  });
})();
