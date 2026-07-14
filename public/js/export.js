// export.js — evidence-trail exports (CSV / BibTeX) + cite-this permalink
// (Task 9.5), extracted from legacy.js. Reads state.currentRep/currentEvidence.
import { state } from "./state.js";

// ── Export the evidence trail (CSV / BibTeX) + cite-this permalink ──
function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function slugify(s) { return (s || "rep").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function csvCell(s) { s = String(s ?? ""); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportEvidenceCsv() {
  if (!state.currentEvidence.length) return;
  const rows = [["#", "Date", "Type", "Title", "URL", "Summary"]];
  state.currentEvidence.forEach((e, i) => rows.push([i + 1, e.date ?? "", e.admissible ? "official record" : "news lead", e.title ?? "", e.url ?? "", e.summary ?? ""]));
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  downloadFile(`${slugify(state.currentRep?.name)}-sources.csv`, csv, "text/csv;charset=utf-8");
}
function exportEvidenceBibtex() {
  if (!state.currentEvidence.length) return;
  const name = slugify(state.currentRep?.name);
  const bib = state.currentEvidence.map((e, i) => {
    const year = (e.date || "").match(/\d{4}/)?.[0] || "";
    return `@online{${name}-src${i + 1},\n  title = {${(e.title || "Untitled source").replace(/[{}]/g, "")}},\n  url = {${e.url || ""}},\n  note = {${(e.summary || "").replace(/[{}]/g, "")}${e.admissible ? " [official record]" : " [news lead]"}},${year ? `\n  year = {${year}},` : ""}\n  urldate = {${new Date().toISOString().slice(0, 10)}}\n}`;
  }).join("\n\n");
  downloadFile(`${name}-sources.bib`, bib, "application/x-bibtex;charset=utf-8");
}
async function copyCiteLink(btn) {
  const url = location.href;
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "✓ Link copied";
  } catch {
    // Fallback: select-and-copy via a temp input
    const t = document.createElement("input"); t.value = url; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); btn.textContent = "✓ Link copied"; } catch { btn.textContent = "Copy failed"; }
    t.remove();
  }
  setTimeout(() => { btn.textContent = label; }, 1800);
}

export { downloadFile, slugify, csvCell, exportEvidenceCsv, exportEvidenceBibtex, copyCiteLink };
