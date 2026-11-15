
// ===== CONSTANTS & RULES =====
const RULE_LABELS = {
  "1_2s": { label: "1₂s", desc: "Warning — one control beyond ±2SD", kind: "warning" },
  "1_3s": { label: "1₃s", desc: "Reject — one control beyond ±3SD", kind: "reject" },
  "2_2s": { label: "2₂s", desc: "Reject — two consecutive controls beyond same ±2SD", kind: "reject" },
  "R_4s": { label: "R₄s", desc: "Reject — range between consecutive controls exceeds 4SD", kind: "reject" },
  "4_1s": { label: "4₁s", desc: "Reject — four consecutive controls beyond same ±1SD", kind: "reject" },
  "10x":  { label: "10x̄", desc: "Reject — ten consecutive controls on same side of mean", kind: "reject" },
};
const REJECT_RULES = ["1_3s", "2_2s", "R_4s", "4_1s", "10x"];
const STORAGE_KEY = "qc-data-v2";
const UID = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2,10) + Date.now().toString(36);
const FMT_DATE = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, {month:"short",day:"numeric"});

// ===== WESTGARD EVALUATION =====
function evaluateSeries(zScores) {
  return zScores.map((_, i) => {
    const upTo = zScores.slice(0, i + 1);
    const last = upTo[upTo.length - 1];
    const flags = [];
    if (Math.abs(last) > 3) flags.push("1_3s");
    if (Math.abs(last) > 2) flags.push("1_2s");
    if (upTo.length >= 2) {
      const prev = upTo[upTo.length - 2];
      if (Math.abs(last) > 2 && Math.abs(prev) > 2 && Math.sign(last) === Math.sign(prev)) flags.push("2_2s");
      if (Math.abs(last - prev) > 4) flags.push("R_4s");
    }
    if (upTo.length >= 4) {
      const last4 = upTo.slice(-4);
      if (last4.every(z => z > 1) || last4.every(z => z < -1)) flags.push("4_1s");
    }
    if (upTo.length >= 10) {
      const last10 = upTo.slice(-10);
      if (last10.every(z => z > 0) || last10.every(z => z < 0)) flags.push("10x");
    }
    const isReject = flags.some(f => REJECT_RULES.includes(f));
    const status = isReject ? "reject" : flags.includes("1_2s") ? "warning" : "accept";
    return { flags, status };
  });
}

// ===== UNIT CONVERSION TABLE =====
const CONVERSIONS = {
  "Glucose": { from: "mg/dL", to: "mmol/L", factor: 0.0555, reverse: 18.018 },
  "Cholesterol (Total/HDL/LDL)": { from: "mg/dL", to: "mmol/L", factor: 0.02586, reverse: 38.67 },
  "Triglycerides": { from: "mg/dL", to: "mmol/L", factor: 0.01129, reverse: 88.57 },
  "Bilirubin (Total/Direct)": { from: "mg/dL", to: "µmol/L", factor: 17.1, reverse: 0.0585 },
  "Creatinine": { from: "mg/dL", to: "µmol/L", factor: 88.4, reverse: 0.0113 },
  "Urea / BUN": { from: "mg/dL", to: "mmol/L", factor: 0.357, reverse: 2.8 },
  "Hemoglobin": { from: "g/dL", to: "g/L", factor: 10, reverse: 0.1 },
  "Calcium": { from: "mg/dL", to: "mmol/L", factor: 0.2495, reverse: 4.008 },
  "Sodium / Potassium / Chloride": { from: "mEq/L", to: "mmol/L", factor: 1, reverse: 1 },
};

// ===== STATE =====
let state = {
  tests: [],
  runs: [],
  selectedTestId: null,
  loaded: false,
  saveState: "idle",
  showNewTest: false,
  pendingDelete: null,
  activeTab: "chart", // chart | log
  sidebarTab: "tests", // tests | convert | settings
};

// ===== DOM REFERENCES =====
const app = document.getElementById("app");
const mainContent = document.getElementById("mainContent");
const sidebarGroups = document.getElementById("sidebarGroups");
const saveBadge = document.getElementById("saveBadge");
const btnNewTest = document.getElementById("btnNewTest");

// ===== STORAGE (localStorage with fallback) =====
const storage = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error("Storage write failed:", e);
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch {}
  }
};

// ===== RENDER HELPERS =====
function setSaveStatus(s) {
  state.saveState = s;
  saveBadge.textContent = s === "saving" ? "SAVING…" : s === "error" ? "SAVE FAILED" : "SAVED";
  saveBadge.className = "badge " +
    (s === "saving" ? "badge-info" : s === "error" ? "badge-reject" : "badge-accept");
}

function badge(status, text) {
  const cls = status === "reject" ? "badge-reject" : status === "warning" ? "badge-warning" : "badge-accept";
  return `<span class="badge ${cls}">${text}</span>`;
}

function flagBadges(flags) {
  if (!flags.length) return '<span style="color:var(--ink-faint)">—</span>';
  return flags.map(f => {
    const r = RULE_LABELS[f];
    const cls = r.kind === "reject" ? "badge-reject" : "badge-warning";
    return `<span class="badge ${cls}">${r.label}</span>`;
  }).join("");
}

function statusColor(status) {
  return status === "reject" ? "var(--reject)" : status === "warning" ? "var(--warn)" : "var(--accent)";
}

// ===== COMPONENT RENDERERS =====
function renderSidebar() {
  const { tests, runs, selectedTestId, pendingDelete, sidebarTab } = state;
  const grouped = {};
  tests.forEach(t => { (grouped[t.analyte] = grouped[t.analyte] || []).push(t); });

  const tabButtons = `
    <div class="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
      <button class="sidebar-tab ${sidebarTab==="tests"?"active":""}" role="tab" aria-selected="${sidebarTab==="tests"}" data-sidebartab="tests">
        <svg class="icon icon-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M8 13h8"/><path d="M10 11h4"/></svg>
        <span>Tests</span>
      </button>
      <button class="sidebar-tab ${sidebarTab==="convert"?"active":""}" role="tab" aria-selected="${sidebarTab==="convert"}" data-sidebartab="convert">
        <svg class="icon icon-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 1 1 2.12 9.36L1 14"/></svg>
        <span>Converter</span>
      </button>
      <button class="sidebar-tab ${sidebarTab==="settings"?"active":""}" role="tab" aria-selected="${sidebarTab==="settings"}" data-sidebartab="settings">
        <svg class="icon icon-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        <span>Settings</span>
      </button>
    </div>
  `;

  if (sidebarTab === "convert") {
    sidebarGroups.innerHTML = tabButtons + renderConvertPanel();
    bindSidebarTabs();
    bindConvertPanel();
    return;
  }
  if (sidebarTab === "settings") {
    sidebarGroups.innerHTML = tabButtons + renderSettingsPanel(tests.find(t => t.id === selectedTestId) || null);
    bindSidebarTabs();
    bindSettingsPanel(tests.find(t => t.id === selectedTestId) || null);
    return;
  }

  // Tests tab
  if (!tests.length) {
    sidebarGroups.innerHTML = tabButtons + `
      <p style="font-size:var(--fs-sm);color:var(--ink-faint);padding:8px 4px;line-height:1.5">
        No QC tests defined yet. Add an analyte and control level to start charting.
      </p>`;
    bindSidebarTabs();
    return;
  }

  sidebarGroups.innerHTML = tabButtons + Object.entries(grouped).map(([analyte, list]) => `
    <div class="sidebar-group">
      <div class="sidebar-label">${analyte}</div>
      ${list.map(t => {
        const nRuns = runs.filter(r => r.testId === t.id).length;
        const confirming = pendingDelete && pendingDelete.type === "test" && pendingDelete.id === t.id;
        const active = selectedTestId === t.id;
        const safeAnalyte = escapeHtml(t.analyte);
        const safeLevel = escapeHtml(t.level);
        const safeUnit = escapeHtml(t.unit || "—");
        return `
          <div class="test-item ${active ? "active" : ""}" data-test-id="${t.id}" tabindex="0" role="button" aria-pressed="${active}" aria-label="${safeAnalyte} ${safeLevel}, ${nRuns} runs">
            <div class="test-item-info">
              <div class="test-item-level">${safeLevel}</div>
              <div class="test-item-meta">${nRuns} run${nRuns===1?"":"s"} · ${safeUnit}</div>
            </div>
            <div class="test-item-actions">
              ${!confirming ? `
                <button class="btn-ghost" data-action="delete-test" data-id="${t.id}" aria-label="Delete ${safeAnalyte} ${safeLevel}" title="Delete">
                  <svg class="icon icon-13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              ` : `
                <div class="confirm-delete">
                  <button class="btn-danger" data-action="confirm-delete-test" data-id="${t.id}" aria-label="Confirm delete" title="Confirm"><svg class="icon icon-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
                  <button class="btn-ghost" data-action="cancel-delete" aria-label="Cancel delete" title="Cancel"><svg class="icon icon-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
              `}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `).join("");

  bindSidebarTabs();
  // Bind test item events
  sidebarGroups.querySelectorAll(".test-item").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.closest("button")) return;
      state.selectedTestId = el.dataset.testId;
      state.activeTab = "chart";
      renderAll();
    });
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        state.selectedTestId = el.dataset.testId;
        state.activeTab = "chart";
        renderAll();
      }
    });
  });
  sidebarGroups.querySelectorAll("[data-action='delete-test']").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    state.pendingDelete = { type: "test", id: b.dataset.id };
    renderSidebar();
  }));
  sidebarGroups.querySelectorAll("[data-action='confirm-delete-test']").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    deleteTest(b.dataset.id);
  }));
  sidebarGroups.querySelectorAll("[data-action='cancel-delete']").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    state.pendingDelete = null;
    renderSidebar();
  }));
}

function bindSidebarTabs() {
  sidebarGroups.querySelectorAll(".sidebar-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      state.sidebarTab = btn.dataset.sidebartab;
      renderSidebar();
    });
  });
}

function renderMain() {
  const { tests, selectedTestId, showNewTest, activeTab } = state;
  const selectedTest = tests.find(t => t.id === selectedTestId) || null;

  if (showNewTest) {
    mainContent.innerHTML = renderNewTestForm();
    bindNewTestForm();
    return;
  }
  if (!selectedTest) {
    mainContent.innerHTML = renderEmptyState(tests.length > 0);
    document.getElementById("btnEmptyNewTest")?.addEventListener("click", () => {
      state.showNewTest = true; renderAll();
    });
    return;
  }

  // Tabs (only Chart and Log now)
  mainContent.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Views">
      <button class="tab ${activeTab==="chart"?"active":""}" role="tab" aria-selected="${activeTab==="chart"}" data-tab="chart">Levey–Jennings Chart</button>
      <button class="tab ${activeTab==="log"?"active":""}" role="tab" aria-selected="${activeTab==="log"}" data-tab="log">Run Log</button>
    </div>
    <div class="tab-panel" id="panel-chart" role="tabpanel" ${activeTab!=="chart"?"hidden":""}>${renderChartPanel(selectedTest)}</div>
    <div class="tab-panel" id="panel-log" role="tabpanel" ${activeTab!=="log"?"hidden":""}>${renderLogPanel(selectedTest)}</div>
  `;

  // Tab switching
  mainContent.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      renderMain();
    });
  });

  // Bind panel-specific events
  if (activeTab === "chart") bindChartPanel(selectedTest);
  if (activeTab === "log") bindLogPanel(selectedTest);
}

// Unified chart panel binding: form submit + tooltip
function bindChartPanel(test) {
  bindChartPanelForm(test);
  // Tooltip on SVG circles
  const wrap = mainContent.querySelector(".chart-wrap");
  const tooltip = wrap?.querySelector("#chartTooltip");
  const circles = wrap?.querySelectorAll("circle[data-tooltip]");
  circles?.forEach(c => {
    c.addEventListener("mouseenter", e => {
      const data = JSON.parse(c.dataset.tooltip);
      showTooltip(tooltip, e.clientX, e.clientY, data);
    });
    c.addEventListener("mousemove", e => {
      tooltip.style.left = (e.clientX + 12) + "px";
      tooltip.style.top = (e.clientY - 8) + "px";
    });
    c.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
  });
}

function renderEmptyState(hasTests) {
  return `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true">
        <svg class="icon icon-28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 21a3 3 0 0 1-3 3h-1v-9"/><path d="M21 12a3 3 0 0 0-3-3h-4"/><path d="M3 3v18h18"/><path d="M8 13h8"/><path d="M10 11h4"/></svg>
      </div>
      <p class="empty-state-text">${hasTests
        ? "Select an analyte and control level from the left to view its Levey–Jennings chart."
        : "Define your first analyte and control level to begin logging daily QC results."}</p>
      ${!hasTests ? `
        <button class="btn-primary" id="btnEmptyNewTest" style="width:auto">
          <svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add a test
        </button>
      ` : ""}
    </div>
  `;
}

function renderNewTestForm() {
  return `
    <form id="newTestForm" class="panel" style="max-width:440px;margin:0 auto">
      <div class="panel-header">
        <div style="font-size:var(--fs-lg);font-weight:700;margin-bottom:4px">New analyte / control level</div>
        <p style="font-size:var(--fs-sm);color:var(--ink-muted);margin:0;line-height:1.5">
          Establish the target mean and SD from ≥20 replicate measurements over ≥20 days
          (or take them from the control lot's assay sheet) before charting live results.
        </p>
      </div>
      <div class="panel-body">
        <div class="form-grid">
          <label class="field">Analyte<div><input type="text" name="analyte" placeholder="e.g. Glucose" required autocomplete="off"></div></label>
          <label class="field">Control level<div><input type="text" name="level" placeholder="e.g. Level 2" required autocomplete="off"></div></label>
          <label class="field">Unit<div><input type="text" name="unit" placeholder="mg/dL" autocomplete="off"></div></label>
          <label class="field">Lot number (optional)<div><input type="text" name="lot" placeholder="e.g. 48213" autocomplete="off"></div></label>
          <label class="field">Target mean<div><input type="number" step="any" name="mean" required></div></label>
          <label class="field">Target SD<div><input type="number" step="any" name="sd" required min="0.0001"></div></label>
        </div>
        <div class="modal-error" id="newTestError" hidden></div>
        <div class="form-actions">
          <button type="submit" class="btn-primary" style="width:auto;padding:8px 16px;font-size:var(--fs-sm);font-weight:600">
            <svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Save test
          </button>
          <button type="button" class="btn-secondary" id="btnCancelNewTest">Cancel</button>
        </div>
      </div>
    </form>
  `;
}

function bindNewTestForm() {
  const form = document.getElementById("newTestForm");
  const errorEl = document.getElementById("newTestError");
  form.addEventListener("submit", e => {
    e.preventDefault();
    const fd = new FormData(form);
    const analyte = fd.get("analyte").trim();
    const level = fd.get("level").trim();
    if (!analyte || !level) { showError(errorEl, "Analyte and level are required."); return; }
    const mean = parseFloat(fd.get("mean"));
    const sd = parseFloat(fd.get("sd"));
    if (isNaN(mean) || isNaN(sd) || sd <= 0) { showError(errorEl, "Enter a valid target mean and a positive SD."); return; }
    addTest({
      analyte, level,
      unit: fd.get("unit").trim(),
      lot: fd.get("lot").trim(),
      mean, sd
    });
  });
  document.getElementById("btnCancelNewTest").addEventListener("click", () => {
    state.showNewTest = false; renderAll();
  });
}

function renderChartPanel(test) {
  const series = getSeriesData(test);
  const observed = getObservedStats(test, series);

  if (!series.length) {
    return `
      <div class="chart-wrap">
        <div class="chart-empty">No runs logged yet for this level. Add today's control result below.</div>
        ${renderRunEntryForm(test)}
      </div>
    `;
  }

  // Chart data for Recharts-like rendering via SVG
  const chartSvg = renderChartSVG(test, series, observed);
  const safeAnalyte = escapeHtml(test.analyte);
  const safeLevel = escapeHtml(test.level);
  const safeUnit = escapeHtml(test.unit);
  const safeLot = test.lot ? escapeHtml(test.lot) : null;

  return `
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
      <div>
        <h2 style="font-size:var(--fs-xl);font-weight:700;margin:0">${safeAnalyte} · ${safeLevel}</h2>
        <div style="font-size:var(--fs-sm);color:var(--ink-muted);font-family:var(--font-mono);margin-top:2px">
          target ${test.mean} ± ${test.sd} ${safeUnit} ${safeLot ? `· lot ${safeLot}` : ""}
        </div>
      </div>
      ${observed.last ? badge(observed.last.status, observed.last.status.toUpperCase()) : ""}
    </div>

    ${observed ? `
    <div class="stat-row">
      <div class="stat-block"><div class="stat-label">Runs</div><div class="stat-value">${observed.n}</div></div>
      <div class="stat-block"><div class="stat-label">Observed mean</div><div class="stat-value">${observed.mean.toFixed(2)}</div><div class="stat-sub">target ${test.mean}</div></div>
      <div class="stat-block"><div class="stat-label">Observed SD</div><div class="stat-value">${observed.sd.toFixed(2)}</div><div class="stat-sub">target ${test.sd}</div></div>
      <div class="stat-block"><div class="stat-label">Observed CV</div><div class="stat-value">${observed.cv.toFixed(1)}%</div></div>
      <div class="stat-block"><div class="stat-label">In control</div><div class="stat-value">${observed.counts.accept}/${observed.n}</div></div>
      ${(observed.counts.reject>0||observed.counts.warning>0)?`<div class="stat-block"><div class="stat-label">Flagged</div><div class="stat-value">${observed.counts.reject}R / ${observed.counts.warning}W</div></div>`:""}
    </div>
    ` : ""}

    <div class="chart-wrap" style="position:relative">${chartSvg}</div>
    ${renderRunEntryForm(test)}
  `;
}

function renderChartSVG(test, series, observed) {
  const { mean, sd } = test;
  const n = series.length;
  const width = 900; // logical width, scales via viewBox
  const height = 340;
  const margin = { top: 24, right: 120, bottom: 40, left: 60 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  // Y domain: mean ± 3.5 SD + padding
  const yPad = sd * 0.7;
  const yMin = mean - 3.5 * sd - yPad;
  const yMax = mean + 3.5 * sd + yPad;
  const yScale = v => margin.top + innerH * (1 - (v - yMin) / (yMax - yMin));
  const xScale = (seq) => margin.left + innerW * (seq - 1) / Math.max(1, n - 1);

  // Grid lines (horizontal)
  const gridLines = [];
  const majorTicks = [mean - 3*sd, mean - 2*sd, mean - 1*sd, mean, mean + 1*sd, mean + 2*sd, mean + 3*sd];
  majorTicks.forEach(v => {
    const y = yScale(v);
    if (y >= margin.top && y <= margin.top + innerH) {
      gridLines.push(`<line x1="${margin.left}" y1="${y}" x2="${margin.left+innerW}" y2="${y}" stroke="var(--grid)" stroke-width="1" stroke-dasharray="${v===mean?'0':v===mean-2*sd||v===mean+2*sd?'0':'3,3'}" />`);
      // Label on right
      const label = v === mean ? "mean" : v > mean ? `+${((v-mean)/sd).toFixed(0)}SD` : `${((v-mean)/sd).toFixed(0)}SD`;
      gridLines.push(`<text x="${width-10}" y="${y+3}" font-family="var(--font-mono)" font-size="9" fill="var(--ink-faint)" text-anchor="end">${label}</text>`);
    }
  });

  // Zone backgrounds
  const zones = [
    { y1: mean + 2*sd, y2: mean + 3*sd, fill: "var(--warn)", opacity: 0.06 },
    { y1: mean - 3*sd, y2: mean - 2*sd, fill: "var(--warn)", opacity: 0.06 },
    { y1: mean - 2*sd, y2: mean + 2*sd, fill: "var(--accent)", opacity: 0.05 },
  ];
  const zoneRects = zones.map(z => {
    const y1 = yScale(z.y1), y2 = yScale(z.y2);
    const top = Math.min(y1, y2), h = Math.abs(y2 - y1);
    return `<rect x="${margin.left}" y="${top}" width="${innerW}" height="${h}" fill="${z.fill}" fill-opacity="${z.opacity}" />`;
  }).join("");

  // Mean line
  const meanY = yScale(mean);
  const meanLine = `<line x1="${margin.left}" y1="${meanY}" x2="${margin.left+innerW}" y2="${meanY}" stroke="var(--accent-deep)" stroke-width="1.4" />`;

  // Connecting line
  const linePath = series.map((d,i) => `${i===0?"M":"L"} ${xScale(d.seq)} ${yScale(d.value)}`).join(" ");
  const lineEl = `<path d="${linePath}" fill="none" stroke="var(--ink-faint)" stroke-width="1" />`;

  // Dots
  const dots = series.map(d => {
    const cx = xScale(d.seq), cy = yScale(d.value);
    const r = d.status === "reject" ? 4.5 : 3.5;
    const fill = statusColor(d.status);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="var(--panel)" stroke-width="1.2" data-tooltip="${escapeHtml(JSON.stringify({...d, test}))}" />`;
  }).join("");

  // X axis ticks (dates)
  const xTicks = series.map(d => {
    const x = xScale(d.seq);
    return `<text x="${x}" y="${height - 18}" font-family="var(--font-mono)" font-size="10" fill="var(--ink-muted)" text-anchor="middle" dominant-baseline="hanging">${d.dateLabel}</text>`;
  }).join("");

  // Y axis ticks (values)
  const yTicks = [];
  const tickVals = [];
  for (let v = Math.ceil(yMin); v <= yMax; v += sd) {
    if (v >= yMin && v <= yMax) tickVals.push(v);
  }
  tickVals.forEach(v => {
    const y = yScale(v);
    yTicks.push(`<line x1="${margin.left-6}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="var(--border)" />`);
    yTicks.push(`<text x="${margin.left-10}" y="${y+3}" font-family="var(--font-mono)" font-size="10" fill="var(--ink-muted)" text-anchor="end">${v.toFixed(test.sd<1?2:1)}</text>`);
  });

  // Axis lines
  const axes = `
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top+innerH}" stroke="var(--border)" />
    <line x1="${margin.left}" y1="${margin.top+innerH}" x2="${margin.left+innerW}" y2="${margin.top+innerH}" stroke="var(--border)" />
  `;

  const safeChartLabel = escapeHtml(test.analyte) + " " + escapeHtml(test.level);
  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block" role="img" aria-label="Levey–Jennings chart for ${safeChartLabel}">
      <defs>
        <clipPath id="chartClip"><rect x="${margin.left}" y="${margin.top}" width="${innerW}" height="${innerH}" /></clipPath>
      </defs>
      ${zoneRects.join("")}
      ${gridLines.join("")}
      ${meanLine}
      <g clip-path="url(#chartClip)">
        ${lineEl}
        ${dots}
      </g>
      ${axes}
      ${xTicks}
      ${yTicks.join("")}
    </svg>
    <div id="chartTooltip" style="position:absolute;pointer-events:none;z-index:10;display:none"></div>
  `;
}

function renderRunEntryForm(test) {
  return `
    <form id="runEntryForm" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-top:14px">
      <label class="field" style="margin:0"><div><input type="date" name="date" id="runDate" required></div></label>
      <label class="field" style="margin:0;min-width:130px"><div><input type="number" step="any" name="value" id="runValue" placeholder="0.00" required style="width:100%"></div></label>
      <label class="field" style="margin:0;min-width:130px"><div><input type="text" name="operator" id="runOperator" placeholder="optional"></div></label>
      <label class="field" style="margin:0;min-width:200px;flex:1"><div><input type="text" name="comment" id="runComment" placeholder="optional"></div></label>
      <button type="submit" class="btn-primary" style="margin-bottom:12px;padding:9px 16px;font-size:var(--fs-sm);font-weight:600">
        <svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Log run
      </button>
    </form>
    <div id="runEntryError" style="font-size:var(--fs-sm);color:var(--reject);margin-top:6px;display:none"></div>
  `;
}

function bindChartPanelForm(test) {
  const form = document.getElementById("runEntryForm");
  const errorEl = document.getElementById("runEntryError");
  const today = new Date().toISOString().slice(0,10);
  form.date.value = today;
  form.addEventListener("submit", e => {
    e.preventDefault();
    const v = parseFloat(form.value.value);
    if (isNaN(v)) { showError(errorEl, "Enter a numeric result."); return; }
    if (!form.date.value) { showError(errorEl, "Pick a date."); return; }
    addRun({
      testId: test.id,
      date: form.date.value,
      value: v,
      operator: form.operator.value.trim(),
      comment: form.comment.value.trim()
    });
    form.value.value = ""; form.comment.value = ""; hideError(errorEl);
  });
}

function renderLogPanel(test) {
  const series = getSeriesData(test);
  if (!series.length) {
    return `<div class="chart-empty">No runs logged yet.</div>`;
  }
  const rows = series.slice().reverse().map(d => `
    <div class="run-row" data-run-id="${d.id}" style="border-left-color:${statusColor(d.status)}">
      <span class="run-date">${d.dateLabel}</span>
      <span class="run-value">${d.value} ${test.unit}</span>
      <span class="run-z" style="color:${statusColor(d.status)}">${d.z>=0?"+":""}${d.z.toFixed(2)}SD</span>
      <span class="run-flags">${flagBadges(d.flags)}</span>
      ${d.operator ? `<span class="run-operator">${escapeHtml(d.operator)}</span>` : ""}
      <div class="run-actions">
        <button class="btn-ghost" data-action="delete-run" data-id="${d.id}" aria-label="Delete run" title="Delete"><svg class="icon icon-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
    </div>
  `).join("");
  return `<div class="run-log-table">${rows}</div>`;
}

function bindLogPanel(test) {
  mainContent.querySelectorAll("[data-action='delete-run']").forEach(b => {
    b.addEventListener("click", e => {
      e.stopPropagation();
      state.pendingDelete = { type: "run", id: b.dataset.id };
      renderLogPanel(test); // re-render just log panel with confirm
      bindLogPanelConfirm(test);
    });
  });
}

function bindLogPanelConfirm(test) {
  mainContent.querySelectorAll("[data-action='confirm-delete-run']").forEach(b => {
    b.addEventListener("click", e => { e.stopPropagation(); deleteRun(b.dataset.id); });
  });
  mainContent.querySelectorAll("[data-action='cancel-delete']").forEach(b => {
    b.addEventListener("click", e => { e.stopPropagation(); state.pendingDelete = null; renderMain(); });
  });
}

function renderConvertPanel() {
  const cards = Object.entries(CONVERSIONS).map(([name, cfg]) => `
    <div class="conv-card">
      <h4><svg class="icon icon-18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 1 1 2.12 9.36L1 14"/></svg> ${escapeHtml(name)}</h4>
      <div class="conv-row">
        <input type="number" step="any" class="conv-input" data-dir="forward" data-factor="${cfg.factor}" placeholder="Enter ${cfg.from}" aria-label="Input ${cfg.from}">
        <span class="conv-arrow">→</span>
        <input type="text" class="conv-output" readonly placeholder="${cfg.to}" aria-label="Output ${cfg.to}">
        <span class="conv-unit">${cfg.to}</span>
      </div>
      <div class="conv-row">
        <input type="number" step="any" class="conv-input" data-dir="reverse" data-factor="${cfg.reverse}" placeholder="Enter ${cfg.to}" aria-label="Input ${cfg.to}">
        <span class="conv-arrow">→</span>
        <input type="text" class="conv-output" readonly placeholder="${cfg.from}" aria-label="Output ${cfg.from}">
        <span class="conv-unit">${cfg.from}</span>
      </div>
    </div>
  `).join("");

  // Custom converter
  return `
    <div style="max-width:900px">
      ${cards}
      <div class="conv-card">
        <h4><svg class="icon icon-18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M2 12h20"/></svg> Calcium correction (Hypo-/Hyperalbuminemia)</h4>
        <p style="font-size:var(--fs-xs);color:var(--ink-muted);margin:0 0 10px">Corrected Ca = Measured Ca + 0.8 × (4.0 - Albumin) — all in mg/dL & g/dL</p>
        <div class="conv-row">
          <input type="number" step="0.01" id="caMeasured" class="conv-input" placeholder="Measured Ca (mg/dL)" aria-label="Measured calcium mg/dL" style="max-width:180px">
          <span class="conv-arrow">+</span>
          <input type="number" step="0.1" id="albValue" class="conv-input" placeholder="Albumin (g/dL)" aria-label="Albumin g/dL" style="max-width:140px">
          <span class="conv-arrow">=</span>
          <input type="text" id="caCorrected" class="conv-output" readonly aria-label="Corrected calcium mg/dL" style="min-width:120px">
        </div>
        <div class="conv-row" style="margin-top:8px">
          <input type="number" step="0.01" id="caMeasuredMmol" class="conv-input" placeholder="Measured Ca (mmol/L)" aria-label="Measured calcium mmol/L" style="max-width:180px">
          <span class="conv-arrow">+</span>
          <input type="number" step="1" id="albValueG" class="conv-input" placeholder="Albumin (g/L)" aria-label="Albumin g/L" style="max-width:140px">
          <span class="conv-arrow">=</span>
          <input type="text" id="caCorrectedMmol" class="conv-output" readonly aria-label="Corrected calcium mmol/L" style="min-width:120px">
        </div>
      </div>
      <div class="conv-card">
        <h4><svg class="icon icon-18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Custom converter</h4>
        <div class="conv-row">
          <input type="number" step="any" id="customFactor" class="conv-input" placeholder="Multiply by" style="max-width:140px" value="1">
          <span class="conv-arrow">×</span>
          <input type="number" step="any" id="customInput" class="conv-input" placeholder="Input value" aria-label="Input value">
          <span class="conv-arrow">=</span>
          <input type="text" id="customOutput" class="conv-output" readonly aria-label="Output value">
        </div>
        <div class="conv-row" style="margin-top:8px">
          <input type="number" step="any" id="customDivInput" class="conv-input" placeholder="Input value" aria-label="Input value">
          <span class="conv-arrow">÷</span>
          <input type="number" step="any" id="customDivFactor" class="conv-input" placeholder="Divide by" style="max-width:140px" value="1">
          <span class="conv-arrow">=</span>
          <input type="text" id="customDivOutput" class="conv-output" readonly aria-label="Output value">
        </div>
      </div>
    </div>
  `;
}

function bindConvertPanel() {
  // Standard converters
  document.querySelectorAll(".conv-input[data-dir]").forEach(inp => {
    inp.addEventListener("input", () => {
      const factor = parseFloat(inp.dataset.factor);
      const val = parseFloat(inp.value);
      const row = inp.closest(".conv-row");
      const out = row.querySelector(".conv-output");
      out.value = isNaN(val) ? "" : (val * factor).toFixed(4).replace(/\.?0+$/,"");
    });
  });
  // Calcium correction (mg/dL)
  const caMeasured = document.getElementById("caMeasured");
  const albValue = document.getElementById("albValue");
  const caCorrected = document.getElementById("caCorrected");
  [caMeasured, albValue].forEach(el => el?.addEventListener("input", () => {
    const ca = parseFloat(caMeasured.value);
    const alb = parseFloat(albValue.value);
    caCorrected.value = (isNaN(ca)||isNaN(alb)) ? "" : (ca + 0.8 * (4.0 - alb)).toFixed(2).replace(/\.?0+$/,"");
  }));
  // Calcium correction (mmol/L)
  const caMeasuredMmol = document.getElementById("caMeasuredMmol");
  const albValueG = document.getElementById("albValueG");
  const caCorrectedMmol = document.getElementById("caCorrectedMmol");
  [caMeasuredMmol, albValueG].forEach(el => el?.addEventListener("input", () => {
    const ca = parseFloat(caMeasuredMmol.value);
    const alb = parseFloat(albValueG.value);
    // Formula: Corrected Ca = Measured Ca + 0.02 × (40 - Albumin in g/L)
    caCorrectedMmol.value = (isNaN(ca)||isNaN(alb)) ? "" : (ca + 0.02 * (40 - alb)).toFixed(2).replace(/\.?0+$/,"");
  }));
  // Custom multiply
  const mulIn = document.getElementById("customInput");
  const mulFactor = document.getElementById("customFactor");
  const mulOut = document.getElementById("customOutput");
  [mulIn, mulFactor].forEach(el => el?.addEventListener("input", () => {
    const a = parseFloat(mulIn.value), b = parseFloat(mulFactor.value);
    mulOut.value = (isNaN(a)||isNaN(b)) ? "" : (a*b).toFixed(4).replace(/\.?0+$/,"");
  }));
  // Custom divide
  const divIn = document.getElementById("customDivInput");
  const divFactor = document.getElementById("customDivFactor");
  const divOut = document.getElementById("customDivOutput");
  [divIn, divFactor].forEach(el => el?.addEventListener("input", () => {
    const a = parseFloat(divIn.value), b = parseFloat(divFactor.value);
    divOut.value = (isNaN(a)||isNaN(b)||b===0) ? "" : (a/b).toFixed(4).replace(/\.?0+$/,"");
  }));
}

function renderSettingsPanel(test) {
  return `
    <div style="max-width:700px">
      <div class="panel" style="margin-bottom:var(--gap)">
        <div class="panel-header">
          <div style="font-size:var(--fs-lg);font-weight:700">Data Management</div>
          <p style="font-size:var(--fs-sm);color:var(--ink-muted);margin:0">Export, import, or reset all QC data.</p>
        </div>
        <div class="panel-body" style="display:flex;gap:12px;flex-wrap:wrap">
          <button class="btn-primary" id="btnExportJSON" style="width:auto"><svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export All Data (JSON)</button>
          <button class="btn-primary" id="btnExportCSV" style="width:auto"><svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export Runs (CSV)</button>
          <label class="btn-secondary" style="width:auto;display:flex;align-items:center;justify-content:center;cursor:pointer">
            <svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 10 12 15 7 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Import Data (JSON)
            <input type="file" id="importFile" accept=".json" hidden style="position:absolute;opacity:0">
          </label>
          <button class="btn-secondary" id="btnSeedSample" style="width:auto"><svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Load Sample Data</button>
          <button class="btn-secondary" id="btnClearAll" style="width:auto;color:var(--reject);border-color:var(--reject)"><svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Clear All Data</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div style="font-size:var(--fs-lg);font-weight:700">Current Test: ${test ? `${escapeHtml(test.analyte)} · ${escapeHtml(test.level)}` : "—"}</div>
          <p style="font-size:var(--fs-sm);color:var(--ink-muted);margin:0">Test-specific actions.</p>
        </div>
        <div class="panel-body" style="display:flex;gap:12px;flex-wrap:wrap">
          ${test ? `
            <button class="btn-secondary" id="btnExportTestCSV" style="width:auto"><svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export This Test Runs (CSV)</button>
            <button class="btn-secondary" id="btnDeleteTestRuns" style="width:auto;color:var(--reject);border-color:var(--reject)"><svg class="icon icon-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete All Runs for This Test</button>
          ` : ""}
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div style="font-size:var(--fs-lg);font-weight:700">Westgard Rules Reference</div>
        </div>
        <div class="panel-body">
          <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
            <thead><tr style="text-align:left;border-bottom:1px solid var(--border)"><th style="padding:8px;color:var(--ink-muted)">Rule</th><th style="padding:8px;color:var(--ink-muted)">Description</th><th style="padding:8px;color:var(--ink-muted)">Type</th></tr></thead>
            <tbody>
              ${Object.entries(RULE_LABELS).map(([k,v])=>`<tr style="border-bottom:1px solid var(--border)"><td style="padding:8px;font-family:var(--font-mono)">${v.label}</td><td style="padding:8px">${v.desc}</td><td style="padding:8px">${badge(v.kind, v.kind.toUpperCase())}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function bindSettingsPanel(test) {
  document.getElementById("btnExportJSON")?.addEventListener("click", exportAllJSON);
  document.getElementById("btnExportCSV")?.addEventListener("click", exportAllCSV);
  document.getElementById("importFile")?.addEventListener("change", importJSON);
  document.getElementById("btnSeedSample")?.addEventListener("click", seedSampleData);
  document.getElementById("btnClearAll")?.addEventListener("click", confirmClearAll);
  document.getElementById("btnExportTestCSV")?.addEventListener("click", () => exportTestCSV(test));
  document.getElementById("btnDeleteTestRuns")?.addEventListener("click", () => confirmDeleteTestRuns(test));
}

// ===== DATA ACCESS =====
function getSeriesData(test) {
  if (!test) return [];
  const list = state.runs
    .filter(r => r.testId === test.id)
    .slice()
    .sort((a,b) => a.date === b.date ? a.createdAt - b.createdAt : a.date.localeCompare(b.date));
  const zScores = list.map(r => (r.value - test.mean) / test.sd);
  const evals = evaluateSeries(zScores);
  return list.map((r,i) => ({
    ...r,
    seq: i+1,
    z: zScores[i],
    dateLabel: FMT_DATE(r.date),
    ...evals[i]
  }));
}

function getObservedStats(test, series) {
  if (!series.length) return null;
  const vals = series.map(d => d.value);
  const n = vals.length;
  const mean = vals.reduce((a,b)=>a+b,0)/n;
  const sd = n>1 ? Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/(n-1)) : 0;
  const cv = mean !== 0 ? (sd/mean)*100 : 0;
  const counts = series.reduce((acc,d)=>{acc[d.status]=(acc[d.status]||0)+1;return acc},{accept:0,warning:0,reject:0});
  return { n, mean, sd, cv, counts, last: series[series.length-1] };
}

// ===== STATE MUTATIONS =====
function addTest(t) {
  const test = { id: UID(), ...t };
  state.tests.push(test);
  state.selectedTestId = test.id;
  state.showNewTest = false;
  saveAndRender();
}

function deleteTest(id) {
  state.tests = state.tests.filter(t => t.id !== id);
  state.runs = state.runs.filter(r => r.testId !== id);
  if (state.selectedTestId === id) state.selectedTestId = state.tests[0]?.id || null;
  state.pendingDelete = null;
  saveAndRender();
}

function addRun(r) {
  state.runs.push({ id: UID(), createdAt: Date.now(), ...r });
  saveAndRender();
}

function deleteRun(id) {
  state.runs = state.runs.filter(r => r.id !== id);
  state.pendingDelete = null;
  saveAndRender();
}

function saveAndRender() {
  setSaveStatus("saving");
  const ok = storage.set(STORAGE_KEY, { tests: state.tests, runs: state.runs });
  setSaveStatus(ok ? "idle" : "error");
  renderAll();
}

function loadData() {
  const data = storage.get(STORAGE_KEY);
  if (data) {
    state.tests = data.tests || [];
    state.runs = data.runs || [];
    if (state.tests.length && !state.selectedTestId) state.selectedTestId = state.tests[0].id;
  }
  state.loaded = true;
  renderAll();
}

// ===== EXPORT / IMPORT =====
function exportAllJSON() {
  const data = { tests: state.tests, runs: state.runs, exportedAt: new Date().toISOString() };
  downloadFile(JSON.stringify(data, null, 2), "qc-backup.json", "application/json");
}

function exportAllCSV() {
  const rows = [["Test ID","Analyte","Level","Unit","Lot","Target Mean","Target SD","Date","Run Value","Operator","Comment","Z-Score","Flags","Status"]];
  state.runs.forEach(r => {
    const t = state.tests.find(x => x.id === r.testId);
    if (!t) return;
    const z = (r.value - t.mean) / t.sd;
    const evals = evaluateSeries([z]);
    rows.push([
      r.testId, t.analyte, t.level, t.unit, t.lot, t.mean, t.sd,
      r.date, r.value, r.operator, r.comment,
      z.toFixed(2), evals[0].flags.join(";"), evals[0].status
    ]);
  });
  downloadFile(rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n"), "qc-all-runs.csv", "text/csv");
}

function exportTestCSV(test) {
  const runs = state.runs.filter(r => r.testId === test.id);
  const rows = [["Date","Run Value","Operator","Comment","Z-Score","Flags","Status"]];
  runs.sort((a,b)=>a.date.localeCompare(b.date)).forEach((r,i) => {
    const z = (r.value - test.mean) / test.sd;
    const evals = evaluateSeries([z]);
    rows.push([r.date, r.value, r.operator, r.comment, z.toFixed(2), evals[0].flags.join(";"), evals[0].status]);
  });
  const safeFilename = `qc-${escapeHtml(test.analyte).replace(/[^a-z0-9_-]/gi,'_')}-${escapeHtml(test.level).replace(/[^a-z0-9_-]/gi,'_')}.csv`;
  downloadFile(rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n"), safeFilename, "text/csv");
}

function importJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  // Limit file size (2MB)
  if (file.size > 2 * 1024 * 1024) {
    alert("File too large (max 2MB).");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      // Strict schema validation
      if (!data || !Array.isArray(data.tests) || !Array.isArray(data.runs)) {
        alert("Invalid file format: missing tests[] or runs[].");
        e.target.value = "";
        return;
      }
      // Validate each test object
      const validTests = data.tests.filter(t =>
        t && typeof t.id === "string" &&
        typeof t.analyte === "string" && t.analyte.length <= 100 &&
        typeof t.level === "string" && t.level.length <= 50 &&
        typeof t.unit === "string" && t.unit.length <= 20 &&
        typeof t.mean === "number" && isFinite(t.mean) &&
        typeof t.sd === "number" && isFinite(t.sd) && t.sd > 0 &&
        (t.lot === undefined || (typeof t.lot === "string" && t.lot.length <= 50))
      );
      // Validate each run object
      const validRuns = data.runs.filter(r =>
        r && typeof r.id === "string" &&
        typeof r.testId === "string" &&
        typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
        typeof r.value === "number" && isFinite(r.value) &&
        (r.operator === undefined || (typeof r.operator === "string" && r.operator.length <= 50)) &&
        (r.comment === undefined || (typeof r.comment === "string" && r.comment.length <= 200)) &&
        (r.createdAt === undefined || typeof r.createdAt === "number")
      );
      if (validTests.length !== data.tests.length || validRuns.length !== data.runs.length) {
        alert("Some records were rejected due to invalid format.");
      }
      state.tests = validTests;
      state.runs = validRuns;
      state.selectedTestId = state.tests[0]?.id || null;
      saveAndRender();
      alert(`Imported ${validTests.length} tests, ${validRuns.length} runs.`);
    } catch { alert("Failed to parse JSON."); }
    e.target.value = "";
  };
  reader.readAsText(file);
}

function seedSampleData() {
  if (state.tests.length) {
    if (!confirm("This will add sample data alongside existing tests. Continue?")) return;
  }
  const sampleTests = [
    { analyte: "Glucose", level: "Level 1", unit: "mg/dL", mean: 90, sd: 3, lot: "GLC-2024-001" },
    { analyte: "Glucose", level: "Level 2", unit: "mg/dL", mean: 280, sd: 8, lot: "GLC-2024-002" },
    { analyte: "Cholesterol", level: "Level 1", unit: "mg/dL", mean: 150, sd: 5, lot: "CHOL-2024-001" },
    { analyte: "Creatinine", level: "Level 1", unit: "mg/dL", mean: 1.0, sd: 0.05, lot: "CREAT-2024-001" },
  ];
  sampleTests.forEach(t => state.tests.push({ id: UID(), ...t }));

  // Generate ~30 days of runs per test
  const today = new Date();
  state.tests.forEach(test => {
    for (let d = 29; d >= 0; d--) {
      const date = new Date(today);
      date.setDate(date.getDate() - d);
      const iso = date.toISOString().slice(0,10);
      // Simulate mostly in-control with occasional flags
      let val = test.mean + (Math.random()-0.5)*2*test.sd;
      if (Math.random() < 0.05) val = test.mean + (Math.random()>0.5?3.5:-3.5)*test.sd; // 1_3s
      else if (Math.random() < 0.08) val = test.mean + (Math.random()>0.5?2.5:-2.5)*test.sd; // 1_2s
      state.runs.push({ id: UID(), createdAt: date.getTime(), testId: test.id, date: iso, value: Number(val.toFixed(2)), operator: "Tech A", comment: "" });
    }
  });
  saveAndRender();
}

function confirmClearAll() {
  if (confirm("Delete ALL tests and runs? This cannot be undone.")) {
    state.tests = []; state.runs = []; state.selectedTestId = null;
    storage.remove(STORAGE_KEY);
    saveAndRender();
  }
}

function confirmDeleteTestRuns(test) {
  if (confirm(`Delete all runs for ${escapeHtml(test.analyte)} · ${escapeHtml(test.level)}?`)) {
    state.runs = state.runs.filter(r => r.testId !== test.id);
    saveAndRender();
  }
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.style.display = "none";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== MODAL HELPERS =====
function showError(el, msg) { el.textContent = msg; el.hidden = false; }
function hideError(el) { el.hidden = true; el.textContent = ""; }
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===== THEME HANDLING =====
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  updateThemeIcon();
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) {
    applyTheme(saved);
  } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    applyTheme("dark");
  }
}

function bindThemeToggle() {
  const btn = document.getElementById("btnThemeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      applyTheme(current === "dark" ? "light" : "dark");
    });
  }
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById("btnThemeToggle");
  if (!btn) return;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  btn.innerHTML = dark
    ? `<svg class="icon icon-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
    : `<svg class="icon icon-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
}

// ===== MAIN RENDER =====
function renderAll() {
  renderSidebar();
  renderMain();
  // Bind global buttons
  btnNewTest.onclick = () => { state.showNewTest = true; renderAll(); };
  bindThemeToggle();
}

// ===== INIT =====
initTheme();
loadData();
