// bib-check live audit — pure browser port of bib_check Python package.
// Sources: OpenAlex (api.openalex.org) + Crossref (api.crossref.org). Both
// support CORS. No proxy needed.

// ========== BibTeX parser ==========

function parseBib(text) {
  const cleaned = text.replace(/^%.*$/gm, "");
  const headerRe = /@(\w+)\s*\{([^,\s]+)\s*,/gm;
  const entries = [];
  let m;
  let idx = 0;
  while ((m = headerRe.exec(cleaned)) !== null) {
    const entryType = m[1].toLowerCase();
    if (entryType === "comment" || entryType === "string" || entryType === "preamble") continue;
    idx += 1;
    const key = m[2].trim();
    const bodyStart = headerRe.lastIndex;
    let depth = 1, j = bodyStart;
    while (j < cleaned.length && depth > 0) {
      const c = cleaned[j];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
      j++;
    }
    const body = cleaned.slice(bodyStart, j);
    const lineNumber = cleaned.slice(0, m.index).split("\n").length;
    const raw = cleaned.slice(m.index, j + 1);
    entries.push({
      citeKey: key,
      entryType,
      fields: parseFields(body),
      lineNumber,
      index: idx,
      raw,
    });
    headerRe.lastIndex = j + 1;
  }
  return entries;
}

function parseFields(body) {
  const fields = {};
  const fieldRe = /(\w+)\s*=\s*/gm;
  const matches = [];
  let mm;
  while ((mm = fieldRe.exec(body)) !== null) matches.push({ name: mm[1].toLowerCase(), end: fieldRe.lastIndex, start: mm.index });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].start : body.length;
    const chunk = body.slice(start, end).trim();
    const v = extractValue(chunk);
    if (v != null) fields[matches[i].name] = normalizeWhitespace(v);
  }
  return fields;
}

function extractValue(chunk) {
  if (!chunk) return null;
  if (chunk[0] === "{") {
    let depth = 0;
    for (let k = 0; k < chunk.length; k++) {
      const c = chunk[k];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return chunk.slice(1, k); }
    }
    return chunk.slice(1);
  }
  if (chunk[0] === '"') {
    const end = chunk.indexOf('"', 1);
    return chunk.slice(1, end === -1 ? chunk.length : end);
  }
  return chunk.replace(/[,}]+\s*$/, "").trim();
}

function normalizeWhitespace(v) {
  return v.replace(/\s+/g, " ").trim().replace(/,$/, "").trim();
}

// ========== Normalizer ==========

const FORBIDDEN_FIELDS = new Set([
  "doi", "url", "eprint", "eprinttype", "archiveprefix", "biburl", "bibsource",
  "timestamp", "issn", "isbn", "abstract", "keywords", "month", "note",
]);

const ARXIV_VENUE_HINTS = ["corr", "arxiv", "preprint", "techrxiv", "authorea", "ssrn"];

const VENUE_FULL_NAME = {
  neurips: "Advances in Neural Information Processing Systems",
  nips: "Advances in Neural Information Processing Systems",
  icml: "International Conference on Machine Learning",
  iclr: "International Conference on Learning Representations",
  acl: "Annual Meeting of the Association for Computational Linguistics",
  emnlp: "Conference on Empirical Methods in Natural Language Processing",
  naacl: "Conference of the North American Chapter of the Association for Computational Linguistics",
  aaai: "AAAI Conference on Artificial Intelligence",
  ijcai: "International Joint Conference on Artificial Intelligence",
  colm: "Conference on Language Modeling",
  cvpr: "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
  iccv: "IEEE/CVF International Conference on Computer Vision",
  eccv: "European Conference on Computer Vision",
  osdi: "USENIX Symposium on Operating Systems Design and Implementation",
  sosp: "ACM Symposium on Operating Systems Principles",
  nsdi: "USENIX Symposium on Networked Systems Design and Implementation",
  atc: "USENIX Annual Technical Conference",
  eurosys: "European Conference on Computer Systems",
  asplos: "International Conference on Architectural Support for Programming Languages and Operating Systems",
  isca: "International Symposium on Computer Architecture",
  micro: "IEEE/ACM International Symposium on Microarchitecture",
  hpca: "IEEE International Symposium on High-Performance Computer Architecture",
  fast: "USENIX Conference on File and Storage Technologies",
  vldb: "International Conference on Very Large Data Bases",
  sigmod: "ACM SIGMOD International Conference on Management of Data",
  kdd: "ACM SIGKDD Conference on Knowledge Discovery and Data Mining",
  www: "ACM Web Conference",
  sigir: "ACM SIGIR Conference on Research and Development in Information Retrieval",
  ccs: "ACM SIGSAC Conference on Computer and Communications Security",
  ndss: "Network and Distributed System Security Symposium",
  uss: "USENIX Security Symposium",
  sp: "IEEE Symposium on Security and Privacy",
  icse: "International Conference on Software Engineering",
  fse: "ACM Joint European Software Engineering Conference and Symposium on the Foundations of Software Engineering",
  ase: "IEEE/ACM International Conference on Automated Software Engineering",
  issta: "International Symposium on Software Testing and Analysis",
  pldi: "ACM SIGPLAN Conference on Programming Language Design and Implementation",
  popl: "ACM SIGPLAN Symposium on Principles of Programming Languages",
  oopsla: "ACM SIGPLAN International Conference on Object-Oriented Programming, Systems, Languages, and Applications",
  uist: "ACM Symposium on User Interface Software and Technology",
  chi: "ACM CHI Conference on Human Factors in Computing Systems",
  tacl: "Transactions of the Association for Computational Linguistics",
};

function expandVenueAcronym(venue) {
  const v = venue.trim();
  const m = /^([A-Za-z]{2,8})(\s+\d{4})?$/.exec(v);
  if (!m) return venue;
  return VENUE_FULL_NAME[m[1].toLowerCase()] ?? venue;
}

const ARXIV_VOLUME_RE = /^\s*abs\/\d{4}\.\d{4,5}\s*$/i;

function looksLikeArxiv(venue) {
  const v = (venue || "").toLowerCase();
  return ARXIV_VENUE_HINTS.some(h => v.includes(h));
}

function looksAbbreviated(v) {
  v = v.trim();
  if (v.length <= 12) return true;
  if (/\b[A-Z]{3,}\b/.test(v) && !v.includes("Conference") && !v.includes("Proceedings")) return true;
  if ((v.match(/\./g) || []).length >= 2) return true;
  return false;
}

function hasEtal(author) {
  const a = author.toLowerCase();
  return /\bet\.?\s*al\.?\b/.test(a) || a.includes("and others") || a.includes("the others");
}

const NAME_PARTICLES = new Set(["de", "del", "della", "der", "den", "van", "von", "la", "le", "di", "da", "du"]);

function normalizeOneName(name) {
  name = name.trim();
  if (!name) return name;
  if (name.includes(",")) return name;
  const parts = name.split(/\s+/);
  if (parts.length < 2) return name;
  let i = parts.length - 1;
  while (i > 0 && NAME_PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  const given = parts.slice(0, i).join(" ");
  const family = parts.slice(i).join(" ");
  if (!given || !family) return name;
  return `${family}, ${given}`;
}

function normalizeAuthors(authorField) {
  return authorField.split(/\s+and\s+/).map(p => p.trim()).filter(Boolean).map(normalizeOneName).join(" and ");
}

function detectIssues(entry) {
  const issues = [];
  const f = entry.fields;
  const author = (f.author || "").trim();
  if (!author) issues.push({ severity: "error", field: "author", message: "missing author" });
  else if (hasEtal(author)) issues.push({ severity: "error", field: "author", message: "author list contains et al./others" });
  if (!f.title) issues.push({ severity: "error", field: "title", message: "missing title" });
  if (!f.year) issues.push({ severity: "error", field: "year", message: "missing year" });
  const venue = (f.booktitle || f.journal || "").trim();
  if (!venue) issues.push({ severity: "error", field: "venue", message: "missing booktitle/journal" });
  else if (looksLikeArxiv(venue)) {
    issues.push({ severity: "warning", field: "journal", message: `venue looks like a preprint server ('${venue}'); search for the published version` });
  } else if (entry.entryType === "inproceedings" && looksAbbreviated(venue)) {
    if (expandVenueAcronym(venue) === venue) {
      issues.push({ severity: "warning", field: "booktitle", message: `booktitle may be abbreviated ('${venue}'); use full conference name` });
    }
  }
  if (entry.entryType === "article" && !looksLikeArxiv(venue)) {
    for (const k of ["volume", "number", "pages"]) {
      if (!f[k]) issues.push({ severity: "warning", field: k, message: `missing ${k}` });
    }
  }
  return issues;
}

function rewrite(entry, scholar) {
  const src = { ...entry.fields };
  let scholarEntryType = null;
  if (scholar) {
    for (const k of ["author", "title", "year", "volume", "number", "pages", "publisher"]) {
      if (scholar[k]) src[k] = scholar[k];
    }
    if (scholar.venue && scholar.venueKind) {
      const other = scholar.venueKind === "booktitle" ? "journal" : "booktitle";
      src[scholar.venueKind] = scholar.venue;
      delete src[other];
    }
    scholarEntryType = scholar.entryType ?? null;
  }
  for (const k of FORBIDDEN_FIELDS) delete src[k];
  if (src.booktitle) src.booktitle = expandVenueAcronym(src.booktitle);
  if (src.journal) src.journal = expandVenueAcronym(src.journal);
  if (src.author) src.author = normalizeAuthors(src.author);
  const journal = src.journal || "";
  if (journal && looksLikeArxiv(journal)) {
    if (src.volume && ARXIV_VOLUME_RE.test(src.volume)) delete src.volume;
    delete src.number; delete src.pages; delete src.publisher;
  }
  let entryType;
  if (["article", "inproceedings", "book", "incollection", "techreport"].includes(scholarEntryType)) entryType = scholarEntryType;
  else if (src.booktitle && !src.journal) entryType = "inproceedings";
  else if (src.journal && !src.booktitle) entryType = "article";
  else entryType = entry.entryType;
  const order = entryType === "article"
    ? ["author", "title", "journal", "volume", "number", "pages", "year", "publisher"]
    : ["author", "title", "booktitle", "pages", "year", "address", "publisher", "organization"];
  const lines = [`@${entryType}{${entry.citeKey},`];
  const seen = new Set();
  for (const k of order) {
    if (src[k]) { lines.push(`  ${k.padEnd(10)}= {${src[k]}},`); seen.add(k); }
  }
  for (const [k, v] of Object.entries(src)) {
    if (seen.has(k) || FORBIDDEN_FIELDS.has(k) || !v) continue;
    lines.push(`  ${k.padEnd(10)}= {${v}},`);
  }
  if (lines[lines.length - 1].endsWith(",")) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
  lines.push("}");
  return lines.join("\n");
}

// ========== Title-match (token sort ratio) ==========

function tokenize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al) return bl; if (!bl) return al;
  let prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    let cur = [i];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = cur;
  }
  return prev[bl];
}

function tokenSortRatio(a, b) {
  const sa = tokenize(a).sort().join(" ");
  const sb = tokenize(b).sort().join(" ");
  if (!sa && !sb) return 100;
  const dist = levenshtein(sa, sb);
  const len = Math.max(sa.length, sb.length);
  return (1 - dist / len) * 100;
}

function tokenSetRatio(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const common = [...ta].filter(x => tb.has(x)).sort().join(" ");
  const onlyA = [...ta].filter(x => !tb.has(x)).sort().join(" ");
  const onlyB = [...tb].filter(x => !ta.has(x)).sort().join(" ");
  const s1 = (common + " " + onlyA).trim();
  const s2 = (common + " " + onlyB).trim();
  const r = (x, y) => {
    if (!x && !y) return 100;
    return (1 - levenshtein(x, y) / Math.max(x.length, y.length)) * 100;
  };
  return Math.max(r(common, s1), r(common, s2), r(s1, s2));
}

// ========== Author hint helpers ==========

function hintLastnames(hint) {
  if (!hint) return new Set();
  const out = new Set();
  for (const part of hint.split(/\s+and\s+/i)) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes(",")) {
      out.add(p.split(",")[0].trim().toLowerCase());
    } else {
      const tokens = p.split(/\s+/);
      out.add(tokens[tokens.length - 1].toLowerCase());
    }
  }
  return out;
}

function hintFirstLastname(hint) {
  if (!hint) return null;
  const first = hint.split(/\s+and\s+/i)[0].trim();
  if (!first) return null;
  if (first.includes(",")) return first.split(",")[0].trim().toLowerCase();
  const t = first.split(/\s+/);
  return t[t.length - 1].toLowerCase();
}

function authorLastname(name) {
  if (!name) return "";
  if (name.includes(",")) return name.split(",")[0].trim().toLowerCase();
  const t = name.trim().split(/\s+/);
  return t[t.length - 1].toLowerCase();
}

// ========== OpenAlex ==========

const OA_BASE = "https://api.openalex.org/works";
const PREPRINT_VENUE_HINTS = ["arxiv", "biorxiv", "ssrn", "techrxiv", "authorea", "medrxiv", "preprint", "corr"];

function isPreprint(r) { const v = (r?.venue || "").toLowerCase(); return PREPRINT_VENUE_HINTS.some(h => v.includes(h)); }

async function oaSearch(title) {
  const url = `${OA_BASE}?search=${encodeURIComponent(title)}&per-page=10`;
  const resp = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!resp.ok) throw new Error(`OpenAlex HTTP ${resp.status}`);
  const data = await resp.json();
  return data.results || [];
}

function oaVenueInfo(work) {
  const loc = work.primary_location || {};
  const src = loc.source || {};
  let display = src.display_name || "";
  if (display.toLowerCase().includes("arxiv")) display = "arXiv preprint";
  const t = (src.type || "").toLowerCase();
  let kind = null;
  if (t === "conference") kind = "booktitle";
  else if (t === "journal" || t === "book") kind = "journal";
  else if (t === "repository") kind = "journal";
  return { display, kind, srcType: t };
}

function oaToResult(work) {
  const authors = (work.authorships || []).map(a => a.author?.display_name).filter(Boolean);
  const v = oaVenueInfo(work);
  const b = work.biblio || {};
  const pages = (b.first_page && b.last_page) ? `${b.first_page}--${b.last_page}` : (b.first_page || "");
  const isPrep = (work.type || "") === "preprint" || v.srcType === "repository";
  return {
    title: work.display_name || work.title || "",
    authors,
    year: work.publication_year ?? null,
    venue: v.display,
    venueKind: v.kind,
    volume: b.volume || "",
    number: b.issue || "",
    pages,
    publisher: work.host_organization_name || "",
    entryType: v.kind === "booktitle" ? "inproceedings" : "article",
    rawMeta: `OpenAlex type='${work.type || "?"}' src_type='${v.srcType || "?"}' id=${work.id}`,
    isPreprint: isPrep,
  };
}

function authorOk(candidate, hint) {
  const candLast = new Set((candidate.authors || []).map(authorLastname).filter(Boolean));
  const first = hintFirstLastname(hint);
  if (first && !candLast.has(first)) return false;
  const hints = hintLastnames(hint);
  if (!hints.size) return true;
  for (const h of hints) if (candLast.has(h)) return true;
  return false;
}

function pickBest(targetTitle, hits, hint, threshold) {
  let best = null;
  let bestScore = 0;
  for (const w of hits) {
    const candidate = oaToResult(w);
    const score = tokenSetRatio(targetTitle, candidate.title);
    if (score < threshold) continue;
    if (!authorOk(candidate, hint)) continue;
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

async function openalexLookup(title, hint) {
  try {
    const hits = await oaSearch(title);
    let r = pickBest(title, hits, hint, 75);
    if (!r) {
      // simplify: drop subtitle
      const colon = title.indexOf(":");
      if (colon > 10) {
        const hits2 = await oaSearch(title.slice(0, colon));
        r = pickBest(title.slice(0, colon), hits2, hint, 75);
      }
    }
    return r;
  } catch (e) {
    return { __error: e.message };
  }
}

// ========== Crossref ==========

const CR_BASE = "https://api.crossref.org/works";

async function crSearch(title) {
  const url = `${CR_BASE}?query.title=${encodeURIComponent(title)}&rows=10`;
  const resp = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!resp.ok) throw new Error(`Crossref HTTP ${resp.status}`);
  const data = await resp.json();
  return data.message?.items || [];
}

function crToResult(item) {
  const authors = (item.author || []).map(a => {
    const fam = a.family || ""; const given = a.given || "";
    return fam ? (given ? `${fam}, ${given}` : fam) : given;
  }).filter(Boolean);
  const t = (item.type || "").toLowerCase();
  let entryType = "article", venueKind = "journal";
  if (t === "proceedings-article") { entryType = "inproceedings"; venueKind = "booktitle"; }
  else if (t === "book-chapter") { entryType = "incollection"; venueKind = "booktitle"; }
  else if (t === "posted-content") { entryType = "article"; venueKind = "journal"; }
  const venue = (item["container-title"]?.[0]) || (item["short-container-title"]?.[0]) || "";
  let pages = item.page || "";
  if (pages && /^\d+\s*-\s*\d+$/.test(pages) && !pages.includes("--")) pages = pages.replace(/-/, "--");
  const year = item.issued?.["date-parts"]?.[0]?.[0] ?? null;
  return {
    title: (item.title?.[0] || "").trim(),
    authors,
    year,
    venue,
    venueKind,
    volume: item.volume || "",
    number: item.issue || "",
    pages,
    publisher: item.publisher || "",
    entryType,
    rawMeta: `Crossref type='${t}' DOI=${item.DOI}`,
    isPreprint: t === "posted-content",
  };
}

async function crossrefLookup(title, hint) {
  try {
    const items = await crSearch(title);
    let best = null, bestScore = 0;
    for (const item of items) {
      const r = crToResult(item);
      const score = tokenSetRatio(title, r.title);
      if (score < 88) continue;
      if (!authorOk(r, hint)) continue;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  } catch (e) {
    return { __error: e.message };
  }
}

// ========== Pipeline ==========

async function auditOne(entry, opts) {
  const issues = detectIssues(entry);
  const title = entry.fields.title || "";
  const hint = entry.fields.author || "";
  let match = null, source = "none";
  const errors = [];

  if (title && opts.useOpenalex) {
    const r = await openalexLookup(title, hint);
    if (r && r.__error) errors.push(`OpenAlex: ${r.__error}`);
    else if (r) { match = r; source = "openalex"; }
  }
  if (title && opts.useCrossref && (match === null || isPreprint(match))) {
    const cr = await crossrefLookup(title, hint);
    if (cr && cr.__error) errors.push(`Crossref: ${cr.__error}`);
    else if (cr && !isPreprint(cr)) {
      const score = tokenSortRatio(title, cr.title);
      if (score >= 92 || match === null) {
        if (score >= 88) {
          if (match && match.authors?.length) cr.authors = match.authors; // keep ordering
          match = cr; source = "crossref";
        }
      }
    }
  }
  for (const e of errors) issues.push({ severity: "warning", field: null, message: e });
  const scholar = match ? {
    author: match.authors?.join(" and ") || "",
    title: match.title,
    year: match.year ? String(match.year) : "",
    volume: match.volume,
    number: match.number,
    pages: match.pages,
    publisher: match.publisher,
    venue: match.venue,
    venueKind: match.venueKind,
    entryType: match.entryType,
  } : null;
  const rewritten = rewrite(entry, scholar);
  return { entry, issues, match, source, rewritten };
}

// ========== Renderer ==========

const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function diffLines(oldText, newText) {
  // Simple line-level diff: highlight lines that don't appear verbatim in the
  // other side. Good enough for visualizing field-level changes.
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines.map(l => l.trim()));
  const newSet = new Set(newLines.map(l => l.trim()));
  const renderOld = oldLines.map(l => newSet.has(l.trim()) ? escapeHtml(l) : `<span class="del">${escapeHtml(l)}</span>`).join("\n");
  const renderNew = newLines.map(l => oldSet.has(l.trim()) ? escapeHtml(l) : `<span class="add">${escapeHtml(l)}</span>`).join("\n");
  return { renderOld, renderNew };
}

function renderEntry(a) {
  const e = a.entry;
  const errs = a.issues.filter(i => i.severity === "error").length;
  const warns = a.issues.filter(i => i.severity === "warning").length;
  const visible = a.issues.filter(i => i.severity === "error" || i.severity === "warning");
  const badges = [];
  badges.push(`<span class="badge src-${a.source}">${a.source}</span>`);
  if (errs) badges.push(`<span class="badge err">${errs} err</span>`);
  if (warns) badges.push(`<span class="badge warn">${warns} warn</span>`);
  if (!errs && !warns) badges.push(`<span class="badge ok">clean</span>`);
  const { renderOld, renderNew } = diffLines(e.raw.trim(), a.rewritten);
  const matchHtml = a.match ? `
    <div class="section">
      <h4>Match (${a.source})</h4>
      <div class="match-meta">
        <div class="k">title</div><div>${escapeHtml(a.match.title)}</div>
        <div class="k">authors</div><div>${escapeHtml(a.match.authors?.join(", ") || "(none)")}</div>
        <div class="k">year</div><div>${escapeHtml(a.match.year ?? "?")}</div>
        <div class="k">venue</div><div>${escapeHtml(a.match.venue || "?")} <span style="color:var(--muted)">(${escapeHtml(a.match.venueKind || "?")})</span></div>
        <div class="k">vol/num/pp</div><div>${escapeHtml(a.match.volume || "-")} / ${escapeHtml(a.match.number || "-")} / ${escapeHtml(a.match.pages || "-")}</div>
        <div class="k">meta</div><div style="font-family:var(--mono);font-size:11px;color:var(--muted)">${escapeHtml(a.match.rawMeta || "")}</div>
      </div>
    </div>` : `<div class="section"><h4>Match</h4><p style="color:var(--muted)">No match found.</p></div>`;
  const issuesHtml = visible.length ? `
    <div class="section">
      <h4>Issues</h4>
      <ul>${visible.map(i => `<li><span class="badge ${i.severity === "error" ? "err" : "warn"}">${i.severity}</span> ${i.field ? `<code>${escapeHtml(i.field)}</code>: ` : ""}${escapeHtml(i.message)}</li>`).join("")}</ul>
    </div>` : "";
  return `
    <article class="entry" data-key="${escapeHtml(e.citeKey)}">
      <div class="head">
        <div class="title"><span class="idx">[${e.index}]</span><span class="key">${escapeHtml(e.citeKey)}</span><span style="color:var(--muted)">line ${e.lineNumber}</span></div>
        <div class="badges">${badges.join("")}</div>
      </div>
      <div class="body">
        ${issuesHtml}
        ${matchHtml}
        <div class="section">
          <h4>Original</h4>
          <pre class="bib">${renderOld}</pre>
        </div>
        <div class="section">
          <h4>Suggested <button class="copy-btn" data-copy="suggested">Copy</button></h4>
          <pre class="bib" data-suggested>${renderNew}</pre>
        </div>
      </div>
    </article>`;
}

function renderSummary(audited) {
  const total = audited.length;
  const oa = audited.filter(a => a.source === "openalex").length;
  const cr = audited.filter(a => a.source === "crossref").length;
  const none = audited.filter(a => a.source === "none").length;
  const clean = audited.filter(a => !a.issues.some(i => i.severity === "error" || i.severity === "warning")).length;
  $("#summary").classList.remove("hidden");
  $("#summary").innerHTML = `
    <div class="card"><div class="n">${total}</div><div class="l">total</div></div>
    <div class="card"><div class="n" style="color:var(--good)">${clean}</div><div class="l">clean</div></div>
    <div class="card"><div class="n" style="color:var(--accent)">${oa}</div><div class="l">via OpenAlex</div></div>
    <div class="card"><div class="n" style="color:var(--good)">${cr}</div><div class="l">via Crossref</div></div>
    <div class="card"><div class="n" style="color:var(--bad)">${none}</div><div class="l">unmatched</div></div>`;
}

function setStatus(msg, pct) {
  const el = $("#status");
  el.classList.remove("hidden");
  el.innerHTML = `${escapeHtml(msg)}<div class="bar"><i style="width:${pct}%"></i></div>`;
}

// ========== Wire-up ==========

function parseRange(s, max) {
  s = (s || "").trim();
  if (!s) return null;
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
  if (!m) return null;
  const a = Math.max(1, parseInt(m[1], 10));
  const b = Math.min(max, parseInt(m[2], 10));
  return { a, b };
}

async function runAudit() {
  const text = $("#bib").value;
  const entries = parseBib(text);
  if (!entries.length) { setStatus("No BibTeX entries found.", 100); return; }
  const range = parseRange($("#range").value, entries.length);
  const targets = range ? entries.filter(e => e.index >= range.a && e.index <= range.b) : entries;
  const opts = { useOpenalex: $("#useOpenalex").checked, useCrossref: $("#useCrossref").checked };
  $("#results").innerHTML = "";
  $("#summary").classList.add("hidden");
  const audited = [];
  for (let i = 0; i < targets.length; i++) {
    const e = targets[i];
    setStatus(`Auditing ${i + 1} / ${targets.length}: ${e.citeKey}`, ((i) / targets.length) * 100);
    const a = await auditOne(e, opts);
    audited.push(a);
    $("#results").insertAdjacentHTML("beforeend", renderEntry(a));
    // be polite to APIs
    await new Promise(r => setTimeout(r, 150));
  }
  setStatus(`Done. Audited ${audited.length} entries.`, 100);
  renderSummary(audited);
}

document.addEventListener("click", e => {
  const head = e.target.closest(".entry .head");
  if (head) head.parentElement.classList.toggle("open");
  const btn = e.target.closest(".copy-btn");
  if (btn) {
    const pre = btn.closest(".section").querySelector("[data-suggested]");
    navigator.clipboard.writeText(pre.textContent);
    btn.textContent = "Copied"; setTimeout(() => btn.textContent = "Copy", 1200);
  }
});

$("#run").addEventListener("click", runAudit);
$("#loadFile").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  $("#bib").value = await f.text();
});
$("#loadSample").addEventListener("click", () => {
  $("#bib").value = `@article{kaplan2020scaling,
  author = {Jared Kaplan and Sam McCandlish and Tom Henighan and Tom B. Brown and Benjamin Chess and Rewon Child and Scott Gray and Alec Radford and Jeffrey Wu and Dario Amodei},
  title = {Scaling Laws for Neural Language Models},
  journal = {CoRR},
  volume = {abs/2001.08361},
  year = {2020},
  url = {https://arxiv.org/abs/2001.08361}
}

@inproceedings{yao2023react,
  title = {{ReAct}: Synergizing Reasoning and Acting in Language Models},
  author = {Yao, Shunyu and Zhao, Jeffrey and Yu, Dian and Du, Nan and Shafran, Izhak and Narasimhan, Karthik and Cao, Yuan},
  booktitle = {ICLR},
  year = {2023}
}`;
});
