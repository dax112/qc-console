# Levey–Jennings QC Console

A lightweight, browser-based **quality control console** for laboratory monitoring using **Levey–Jennings charts** and **Westgard multirule evaluation**.

Built for clinical labs, biotech, and research — runs entirely in the browser, no server required.

---

## ✨ Features

- **Levey–Jennings charts** — real-time control chart plotting with mean ± 1/2/3 SD zones
- **Westgard multirules** — automatic violation detection (1-2s, 1-3s, 2-2s, R-4s, 4-1s, 10x, etc.)
- **Interactive data entry** — paste or type QC values, see instant flagging
- **Visual rule violations** — color-coded alerts (warning / reject) on the chart
- **Export / import** — JSON export of runs, CSV-friendly copy-paste
- **Responsive UI** — works on desktop and tablet
- **Zero dependencies** — pure HTML/CSS/JS, no build step
- **Netlify-ready** — deploy in one click

---

## 🚀 Quick Start

### Option 1: Run locally
```bash
# Just open index.html in a browser, or:
npx serve .
```

### Option 2: Deploy to Netlify
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/dax112/qc-console)

---

## 📖 Usage

1. **Enter control data** — paste values (one per line or comma-separated) into the input panel
2. **Set parameters** — mean, SD, control lot/name, units
3. **View chart** — Levey–Jennings plot renders instantly with Westgard zones
4. **Check flags** — violations highlight automatically with rule codes
5. **Export** — download run as JSON or copy CSV for LIMS import

---

## 📋 Westgard Rules Implemented

| Rule | Description | Action |
|------|-------------|--------|
| 1-2s | Single point beyond ±2 SD | **Warning** |
| 1-3s | Single point beyond ±3 SD | **Reject** |
| 2-2s | Two consecutive points beyond ±2 SD (same side) | **Reject** |
| R-4s | Two consecutive points beyond ±2 SD (opposite sides) | **Reject** |
| 4-1s | Four consecutive points beyond ±1 SD (same side) | **Reject** |
| 10x | Ten consecutive points on same side of mean | **Reject** |

---

## 🏗 Project Structure

```
qc-console/
├── index.html      # Main app (HTML + embedded CSS + JS)
├── script.js       # Core logic (chart, rules, state)
├── style.css       # Additional styles (theme tokens)
├── netlify.toml    # Netlify deploy config (headers, CSP, HTTPS)
├── _redirects      # SPA fallback
└── .gitignore
```

---

## 🔒 Security Notes

- **Content Security Policy** configured in `netlify.toml` (strict, allows Google Fonts only)
- **No external scripts** — all logic is local
- **HTTPS enforced** in production
- **No data leaves the browser** — runs 100% client-side

---

## 📄 License

MIT — free to use, modify, and distribute.

---

## 🙋‍♂️ Author

**dax112** — Molecular Medicine / Genomics researcher
- Built for daily QC workflow in clinical lab settings
- Feedback & contributions welcome