// Partser — app.js

// --------------------------------------------------------------------------
// Panel state
// Panels are objects with id, label, tokens[], and raw text.
// Adding/removing panels means mutating this array, then calling
// renderPanels() + runComparison().
// --------------------------------------------------------------------------
const PANEL_IDS = ['a', 'b', 'c', 'd']; // max 4 panels, fixed slot order

const panels = [
  { id: 'a', label: 'Panel A', tokens: [], sourceType: 'text', bomRows: [], parseErrors: [], raw: '', interpretAs: 'refdes' },
  { id: 'b', label: 'Panel B', tokens: [], sourceType: 'text', bomRows: [], parseErrors: [], raw: '', interpretAs: 'refdes' },
];

// --------------------------------------------------------------------------
// Config state
// --------------------------------------------------------------------------
const config = {
  comparisonField: 'refdes',
};

// --------------------------------------------------------------------------
// escAttr(s) — escapes a string for safe use in an HTML attribute value.
// --------------------------------------------------------------------------
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// --------------------------------------------------------------------------
// Config bar wiring
// initConfigBar: wires event listeners (called once at startup).
// syncConfigBarUI: sets UI elements to match config (called after any config reset).
// TODO: rewrite for new app — add global comparisonField selector wiring;
//   remove Partial wiring (chk-partial removed from HTML).
// --------------------------------------------------------------------------
function initConfigBar() {
  // TODO: rewrite for new app
}

function syncConfigBarUI() {
  // TODO: rewrite for new app
}

// --------------------------------------------------------------------------
// Panel rendering
// Rebuilds panel DOM from the panels array. Each panel contains:
//   - Editable label + delete button
//   - Source type dropdown (Textbox / Juki / BOM / MMD)
//   - Browse button + per-panel drag-and-drop zone (always visible)
//   - Textarea + interpret-as dropdown (only when sourceType === 'text')
//   - Parsed output area with copy button
//   - Footer: error expando trigger, View Full Table button, item count
// Stores element refs (parsedEl, footerEl, errorTriggerEl, errorDetailEl) on
// each panel object so runComparison() can update them without re-querying.
// --------------------------------------------------------------------------

function renderPanels() {
  const container = document.getElementById('panel-container');
  container.innerHTML = '';

  for (const panel of panels) {
    const col = document.createElement('div');
    col.className = 'panel';
    col.dataset.panelId = panel.id;

    col.innerHTML = `
      <div class="panel-header">
        <input type="text" class="panel-label" value="${escAttr(panel.label)}">
        <button class="btn-fade btn-panel-icon btn-danger btn-delete-panel" tabindex="-1" title="Remove panel">×</button>
      </div>

      <div class="drop-zone">
        <input type="file" class="file-input-hidden" accept=".xlsx,.iss,.mmd" hidden>
        <button class="btn-browse" tabindex="-1">Browse</button>
        <span class="drop-zone-label">or drag &amp; drop a file</span>
        <span class="drop-zone-filename"></span>
      </div>

      <div class="text-input-area">
        <textarea class="raw-input" placeholder="Paste list here..."></textarea>
        <div class="identifier-row">
          <span class="identifier-label">Interpret as</span>
          <select class="panel-interpret-as" tabindex="-1">
            <option value="refdes"${panel.interpretAs === 'refdes' ? ' selected' : ''}>Refdes</option>
            <option value="fn"${panel.interpretAs === 'fn' ? ' selected' : ''}>FN</option>
            <option value="ipn"${panel.interpretAs === 'ipn' ? ' selected' : ''}>IPN</option>
            <option value="mpn"${panel.interpretAs === 'mpn' ? ' selected' : ''}>MPN</option>
            <option value="cpn"${panel.interpretAs === 'cpn' ? ' selected' : ''}>CPN</option>
          </select>
        </div>
      </div>

      <div class="panel-footer">
        <span class="footer-errors"></span>
        <button class="btn-fade btn-view-table" tabindex="-1">View Full Table</button>
        <span class="footer-label">0 items</span>
      </div>
      <div class="error-detail" hidden></div>
    `;

    // Store element refs for use in runComparison() and renderErrorExpando()
    panel.footerEl       = col.querySelector('.footer-label');
    panel.errorTriggerEl = col.querySelector('.footer-errors');
    panel.errorDetailEl  = col.querySelector('.error-detail');

    // Editable label
    const labelInput = col.querySelector('.panel-label');
    labelInput.addEventListener('input', () => { panel.label = labelInput.value; saveState(); });
    labelInput.addEventListener('focus', () => labelInput.select());

    // Browse button → hidden file input
    const fileInput = col.querySelector('.file-input-hidden');
    col.querySelector('.btn-browse').addEventListener('click', () => fileInput.click());

    // File input: load file, clear any textbox text
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      fileInput.value = ''; // allow re-selecting the same file later
      col.querySelector('.drop-zone-filename').textContent = file.name;
      col.querySelector('.raw-input').value = '';
      panel.raw = '';
      handleBomFile(file, panel.id);
    });

    // Per-panel drag-and-drop onto the drop zone.
    // relatedTarget check avoids flicker when cursor crosses child element boundaries.
    const dropZone = col.querySelector('.drop-zone');
    dropZone.addEventListener('dragenter', e => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', e => {
      if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
    });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (!file) return;
      col.querySelector('.drop-zone-filename').textContent = file.name;
      col.querySelector('.raw-input').value = '';
      panel.raw = '';
      handleBomFile(file, panel.id);
    });

    // Textarea: update panel.raw, clear any loaded file data
    const textarea = col.querySelector('.raw-input');
    textarea.value = panel.raw || '';
    textarea.addEventListener('input', () => {
      panel.raw = textarea.value;
      col.querySelector('.drop-zone-filename').textContent = '';
      panel.bomRows = [];
      runComparison();
    });

    // Interpret-as dropdown
    col.querySelector('.panel-interpret-as').addEventListener('change', e => {
      panel.interpretAs = e.target.value;
      runComparison();
    });

    // Error expando: toggle detail div visibility on click
    panel.errorTriggerEl.addEventListener('click', () => {
      if (panel.errorDetailEl.hasAttribute('hidden')) {
        panel.errorDetailEl.removeAttribute('hidden');
      } else {
        panel.errorDetailEl.setAttribute('hidden', '');
      }
      renderErrorExpando(panel); // refresh ▶/▼ indicator
    });

    // View Full Table button
    col.querySelector('.btn-view-table').addEventListener('click', () => openTableModal(panel));

    // Delete button: disabled when only 1 panel remains
    const deleteBtn = col.querySelector('.btn-delete-panel');
    deleteBtn.disabled = panels.length <= 1;
    deleteBtn.addEventListener('click', () => deletePanel(panel.id));

    container.appendChild(col);
  }

  // Add button: disabled at the 4-panel cap
  document.getElementById('btn-add-panel').disabled = panels.length >= 4;
}

// --------------------------------------------------------------------------
// addPanel() / deletePanel(id)
// --------------------------------------------------------------------------
function addPanel() {
  if (panels.length >= 4) return;
  const usedIds = new Set(panels.map(p => p.id));
  const id      = PANEL_IDS.find(s => !usedIds.has(s));
  panels.push({ id, label: 'Panel ' + id.toUpperCase(), tokens: [], sourceType: 'text', bomRows: [], parseErrors: [], raw: '', interpretAs: 'refdes' });
  renderPanels();
  runComparison();
}

function deletePanel(id) {
  if (panels.length <= 1) return;
  panels.splice(panels.findIndex(p => p.id === id), 1);
  renderPanels();
  runComparison();
}

// --------------------------------------------------------------------------
// runComparison()
// Computes diff status across all panels and re-renders each one.
// Called whenever any panel input or config setting changes.
// TODO: rewrite for new app — tokens are extracted from panel.bomRows via
//   config.comparisonField instead of parsed from raw text.
// --------------------------------------------------------------------------
function runComparison() {
  // TODO: rewrite for new app
}

// --------------------------------------------------------------------------
// renderParsedOutput(panel, freq)
// TODO: rewrite for new app — output area removed from panel DOM for now;
//   will be re-added once comparison logic is implemented.
// --------------------------------------------------------------------------
function renderParsedOutput(panel, freq) {
  // TODO: rewrite for new app
}

// --------------------------------------------------------------------------
// parseInputTokens(rawText, interpretAs)
// Only used for freeform text panels in the new app.
// TODO: rewrite for new app — second param renamed to interpretAs;
//   only called when panel.sourceType === 'text'.
// --------------------------------------------------------------------------
function parseInputTokens(rawText, interpretAs) {
  // TODO: rewrite for new app
}


// --------------------------------------------------------------------------
// renderErrorExpando(panel)
// Updates the error expando in the panel footer.
// Combines parse errors (bad input format) and BOM resolution failures into
// one list. Each entry is a human-readable line item.
// The click handler (wired in renderPanels) toggles the detail visibility;
// this function only refreshes the text content of both elements.
// --------------------------------------------------------------------------
function renderErrorExpando(panel) {
  const allErrors = panel.parseErrors || [];

  if (allErrors.length === 0) {
    panel.errorTriggerEl.textContent = '';
    panel.errorDetailEl.setAttribute('hidden', '');
    return;
  }

  const open = !panel.errorDetailEl.hasAttribute('hidden');
  panel.errorTriggerEl.textContent = `${allErrors.length} error${allErrors.length !== 1 ? 's' : ''} ${open ? '▼' : '▶'}`;
  panel.errorDetailEl.innerHTML    = allErrors.map(e => `<div>${e}</div>`).join('');
}


// --------------------------------------------------------------------------
// updateRangeToggleState()
// Range output is only meaningful for Refdes and FN comparison fields.
// TODO: rewrite for new app — check config.comparisonField instead of per-panel types.
// --------------------------------------------------------------------------
function updateRangeToggleState() {
  // TODO: rewrite for new app
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

// --------------------------------------------------------------------------
// handleBomFile(file, panelId)
// Reads a File object and opens the column-mapping modal for the given panel.
// TODO: rewrite for new app — add panelId param; store result in panel.bomRows
//   instead of global bom; will eventually dispatch to CSV/XML parsers too.
// --------------------------------------------------------------------------
function handleBomFile(file, panelId) {
  const reader = new FileReader();
  reader.onload = e => {
    const workbook = XLSX.read(e.target.result, { type: 'array' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    // header:1 gives array-of-arrays; defval:'' keeps empty cells in place
    const allRows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    _pendingPanelId = panelId;
    showMappingModal(allRows);
  };
  reader.readAsArrayBuffer(file);
}

// TODO: rewrite for new app — file import moves to per-panel (triggered by buttons
//   rendered in renderPanels). Keep drag-and-drop pattern and modal wiring.
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
  _pendingAllRows = null;
  _pendingPanelId = null;
}

// --------------------------------------------------------------------------
// confirmMapping()
// Reads role assignments from the modal dropdowns, builds rows, and stores
// them on the target panel.
// TODO: rewrite for new app — store result in panel.bomRows (by panelId)
//   instead of global bom; update panel source badge; call runComparison().
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
// updateBomStatus()
// TODO: rewrite for new app — status moves to per-panel source badge
//   rendered by renderPanels(); this function can be removed.
// --------------------------------------------------------------------------
function updateBomStatus() {
  // TODO: rewrite for new app
}

// --------------------------------------------------------------------------
// Session persistence
// Saves panels (data only) and config to sessionStorage on every
// runComparison(), and restores them at startup. DOM refs on panel objects
// (parsedEl, footerEl, etc.) are excluded — they're set by renderPanels().
// TODO: rewrite for new app — panel shape changes (sourceType, bomRows instead
//   of raw/inputType/outputType); config shape changes (comparisonField).
// --------------------------------------------------------------------------
const SESSION_KEY = 'partser_state';

function saveState() {
  // TODO: rewrite for new app
}

function loadState() {
  // TODO: rewrite for new app
}

function clearState() {
  // TODO: rewrite for new app
  syncConfigBarUI();
  renderPanels();
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
    // Collect all column keys across all rows (preserves insertion order)
    const keys = [...new Set(panel.bomRows.flatMap(row => Object.keys(row)))];
    const thead = keys.map(k => `<th>${escAttr(k.toUpperCase())}</th>`).join('');
    const tbody = panel.bomRows.map(row => {
      const cells = keys.map(k => {
        const val  = row[k];
        const text = Array.isArray(val) ? val.join(', ') : String(val ?? '');
        return `<td>${escAttr(text)}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    body.innerHTML = `<table class="full-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
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
// Help modal
// --------------------------------------------------------------------------
function initHelpModal() {
  const modal = document.getElementById('help-modal');

  document.getElementById('btn-help').addEventListener('click', () => {
    modal.removeAttribute('hidden');
  });

  document.getElementById('btn-help-close').addEventListener('click', () => {
    modal.setAttribute('hidden', '');
  });

  // Close when clicking the backdrop (outside the modal box)
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.setAttribute('hidden', '');
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
initHelpModal();
renderPanels();
runComparison();
document.getElementById('btn-add-panel').addEventListener('click', addPanel);
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
