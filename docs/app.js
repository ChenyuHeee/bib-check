// bib-check live audit — pure browser port of bib_check Python package.
// Sources: OpenAlex (api.openalex.org) + Crossref (api.crossref.org). Both
// support CORS. No proxy needed.

// Surface module-load / runtime errors so a silent failure (e.g. a stale
// cached HTML missing a referenced element) is visible instead of leaving
// buttons unresponsive.
window.addEventListener("error", e => {
  const s = document.getElementById("status");
  if (s) { s.classList.remove("hidden"); s.textContent = `Script error: ${e.message}`; }
});
window.addEventListener("unhandledrejection", e => {
  const s = document.getElementById("status");
  if (s) { s.classList.remove("hidden"); s.textContent = `Promise error: ${e.reason?.message || e.reason}`; }
});

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

// Fields that the rewriter will silently strip. Kept empty by default: the
// user explicitly added every field, so destroying doi/url/abstract/keywords
// just because we have a "better" canonical version is too aggressive and
// pollutes the diff with deletions the user didn't ask for. Add fields here
// only if they are *guaranteed* noise.
const FORBIDDEN_FIELDS = new Set();

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

// Inline abbreviation dictionary borrowed from refchecker/utils/text_utils.py
// (CC-BY/MIT spirit: short factual mapping table). Used to *normalize* venue
// strings before fuzzy matching so e.g. "Phys. Rev. Lett." matches "Physical
// Review Letters".
const VENUE_ABBREVS = {
  // IEEE
  "robot.": "robotics", "autom.": "automation", "lett.": "letters",
  "trans.": "transactions", "syst.": "systems", "netw.": "networks",
  "learn.": "learning", "ind.": "industrial", "electron.": "electronics",
  "mechatron.": "mechatronics", "intell.": "intelligence",
  "transp.": "transportation", "contr.": "control", "mag.": "magazine",
  // General
  "int.": "international", "intl.": "international", "conf.": "conference",
  "j.": "journal", "proc.": "proceedings", "assoc.": "association",
  "comput.": "computing", "sci.": "science", "eng.": "engineering",
  "tech.": "technology", "artif.": "artificial", "mach.": "machine",
  "stat.": "statistics", "math.": "mathematics", "phys.": "physics",
  "chem.": "chemistry", "bio.": "biology", "med.": "medicine",
  "adv.": "advances", "ann.": "annual", "symp.": "symposium",
  "natl.": "national", "acad.": "academy", "rev.": "review",
  "worksh.": "workshop",
  // Physics multi-word (apply before single-word forms)
  "phys. rev. lett.": "physical review letters",
  "phys. rev. a": "physical review a", "phys. rev. b": "physical review b",
  "phys. rev. c": "physical review c", "phys. rev. d": "physical review d",
  "phys. rev. e": "physical review e", "phys. rev.": "physical review",
  "phys. lett. b": "physics letters b", "phys. lett.": "physics letters",
  "nucl. phys. a": "nuclear physics a", "nucl. phys. b": "nuclear physics b",
  "nucl. phys.": "nuclear physics",
  "j. phys.": "journal of physics", "ann. phys.": "annals of physics",
  "mod. phys. lett.": "modern physics letters",
  "eur. phys. j.": "european physical journal",
  "j. comput. neurosci.": "journal of computational neuroscience",
  "nature phys.": "nature physics", "sci. adv.": "science advances",
  "proc. natl. acad. sci.": "proceedings of the national academy of sciences",
  "pnas": "proceedings of the national academy of sciences",
  "neurips": "neural information processing systems",
};
const _VENUE_ABBREV_KEYS_SORTED = Object.keys(VENUE_ABBREVS)
  .sort((a, b) => b.length - a.length); // longest first
function expandVenueAbbrevs(text) {
  if (!text) return text;
  let out = text;
  for (const k of _VENUE_ABBREV_KEYS_SORTED) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = k.endsWith(".") ? new RegExp("\\b" + esc, "gi")
                               : new RegExp("\\b" + esc + "\\b", "gi");
    out = out.replace(re, VENUE_ABBREVS[k]);
  }
  return out;
}

// Strip LaTeX commands and braces before fuzzy comparison so "{B-ERT}" /
// "{\\\"u}ber" don't cause false mismatches against API-side "BERT" / "über".
const LATEX_ACCENTS = {
  '\\"a': "ä", "\\'a": "á", "\\`a": "à", "\\^a": "â", "\\~a": "ã",
  '\\"o': "ö", "\\'o": "ó", "\\`o": "ò", "\\^o": "ô", "\\~o": "õ",
  '\\"u': "ü", "\\'u": "ú", "\\`u": "ù", "\\^u": "û",
  '\\"e': "ë", "\\'e": "é", "\\`e": "è", "\\^e": "ê",
  '\\"i': "ï", "\\'i": "í", "\\`i": "ì", "\\^i": "î",
  "\\ss": "ß", "\\&": "&",
};
function stripLatex(s) {
  if (!s) return s;
  let out = s;
  // Resolve common accent macros (with optional surrounding braces).
  for (const [k, v] of Object.entries(LATEX_ACCENTS)) {
    out = out.replaceAll("{" + k + "}", v).replaceAll(k, v);
  }
  // Remove generic \cmd[...]{...} or \cmd{...}: keep contents.
  out = out.replace(/\\[a-zA-Z]+\s*\*?\s*(\[[^\]]*\])?\s*\{([^{}]*)\}/g, "$2");
  // Remove leftover \cmd tokens with no args.
  out = out.replace(/\\[a-zA-Z]+\*?/g, "");
  // Remove dollar math toggles, tilde non-breaking spaces.
  out = out.replace(/[$~^_]/g, " ");
  // Drop remaining braces.
  out = out.replace(/[{}]/g, "");
  return out;
}

// Split BibTeX author field on " and " (preferred) or "; " (DBLP-style).
function splitAuthors(s) {
  if (!s) return [];
  const trimmed = s.trim();
  if (/\sand\s/i.test(trimmed)) return trimmed.split(/\s+and\s+/i).map(x => x.trim()).filter(Boolean);
  if (trimmed.includes(";")) return trimmed.split(/\s*;\s*/).map(x => x.trim()).filter(Boolean);
  return [trimmed];
}

// arXiv ID extraction (modern format only). Returns {id, version} or null.
const ARXIV_ID_RE = /(?:arxiv[:\s/]*|abs\/)?(\d{4}\.\d{4,5})(v(\d+))?/i;
function extractArxivId(entry) {
  const candidates = [entry.fields.eprint, entry.fields.url, entry.fields.howpublished, entry.fields.note, entry.fields.journal, entry.fields.volume];
  for (const c of candidates) {
    if (!c) continue;
    const m = ARXIV_ID_RE.exec(c);
    if (m) return { id: m[1], version: m[3] ? parseInt(m[3], 10) : null, raw: m[0] };
  }
  return null;
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
  return splitAuthors(authorField).map(normalizeOneName).join(" and ");
}

const ANON_PATTERNS = [
  /^anonymous$/i, /^\{?anonymous\}?$/i, /^et\s+al\.?$/i, /^others$/i, /^\{?\s*\}?$/,
];
const DOI_RE = /^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,}\/[^\s]+$/i;

// Count `{` vs `}` in a title field, ignoring escaped \{ \}.
function countBraces(s) {
  const t = (s || "").replace(/\\[{}]/g, "");
  return [(t.match(/\{/g) || []).length, (t.match(/\}/g) || []).length];
}

// Heuristic: is an author rendered as initials only? "Z. Li" / "L Zheng" /
// "Li, Z." — these are the OpenAlex/Crossref truncations the user complained
// about (e.g. "Zhuohan Li" -> "Z. Li").
function isTruncatedName(name) {
  const s = (name || "").trim();
  if (!s) return false;
  if (/^[A-Z]\.?\s+[A-Z][a-zA-Z\-']+$/.test(s)) return true;        // "Z. Li" or "L Zheng"
  if (/^[A-Z]\.?\s+[A-Z]\.?\s+[A-Z][a-zA-Z\-']+$/.test(s)) return true; // "J. M. Smith"
  if (/^[A-Z][a-zA-Z\-']+,\s*[A-Z]\.?(\s+[A-Z]\.?)*\s*$/.test(s)) return true; // "Li, Z."
  return false;
}
function hasTruncatedAuthors(authorStr) {
  return splitAuthors(authorStr || "").some(isTruncatedName);
}

// "Trusted" entry: hand-curated or DBLP-sourced. Used to suppress aggressive
// merges from OpenAlex/Crossref aggregators.
function entryIsTrusted(entry) {
  const f = entry.fields || {};
  if ((f.bibsource || "").toLowerCase().includes("dblp")) return true;
  if ((f.biburl || "").toLowerCase().includes("dblp.org")) return true;
  const authors = splitAuthors(f.author || "");
  // Multi-author entry with full first names = looks curated.
  if (authors.length >= 3 && !hasTruncatedAuthors(f.author || "")) return true;
  return false;
}

function detectIssues(entry) {
  const issues = [];
  const f = entry.fields;
  const author = (f.author || "").trim();
  if (!author) issues.push({ severity: "error", field: "author", message: "missing author" });
  else {
    if (hasEtal(author)) issues.push({ severity: "error", field: "author", message: "author list contains et al./others" });
    if (ANON_PATTERNS.some(re => re.test(author))) {
      issues.push({ severity: "warning", field: "author", message: `anonymous/placeholder author: '${author}'` });
    }
  }
  if (!f.title) issues.push({ severity: "error", field: "title", message: "missing title" });
  else {
    const [open, close] = countBraces(f.title);
    if (open !== close) {
      issues.push({ severity: "error", field: "title", message: `unbalanced braces in title (${open} '{' vs ${close} '}')` });
    }
    const letters = f.title.replace(/[^a-zA-Z]/g, "");
    if (letters.length > 10) {
      const upperRatio = (letters.match(/[A-Z]/g) || []).length / letters.length;
      if (upperRatio > 0.5 && !f.title.includes("{")) {
        issues.push({ severity: "warning", field: "title", message: `title has ${(upperRatio * 100).toFixed(0)}% capitals; protect with {Braces}` });
      }
    }
  }
  if (!f.year) issues.push({ severity: "error", field: "year", message: "missing year" });
  else {
    if (!/^\d{4}$/.test(f.year.trim())) {
      issues.push({ severity: "error", field: "year", message: `invalid year format: '${f.year}'` });
    } else {
      const y = parseInt(f.year, 10);
      if (y > new Date().getFullYear() + 1) {
        issues.push({ severity: "warning", field: "year", message: `year ${y} is in the future` });
      }
    }
  }
  if (f.pages) {
    const p = f.pages.trim();
    // Article-style page IDs (e.g. PACMHCI "3:1--3:9") are legitimate.
    const isArticleStyle = /^\d+:\d+--?\d+:\d+$/.test(p);
    const isSinglePage = /^[A-Za-z]?\d+$/.test(p);
    const isRange = /^\d+--?\d+$/.test(p);
    const isEnDashRange = /^\d+–\d+$/.test(p);  // U+2013 EN DASH (auto-fixed in rewrite)
    if (!isArticleStyle && !isSinglePage && !isRange && !isEnDashRange) {
      issues.push({ severity: "warning", field: "pages", message: `unusual page format: '${p}' (expected n--m)` });
    }
    if (isRange) {
      const m = /^(\d+)--?(\d+)$/.exec(p);
      if (m && parseInt(m[1], 10) > parseInt(m[2], 10)) {
        issues.push({ severity: "error", field: "pages", message: `reversed page range: ${p}` });
      }
    }
  }
  if (f.doi && !DOI_RE.test(f.doi.trim())) {
    issues.push({ severity: "warning", field: "doi", message: `DOI looks malformed: '${f.doi}'` });
  }
  // Venue requirements depend on entry type. BibTeX @book/@phdthesis/etc.
  // require publisher (or institution/school) but NOT booktitle/journal.
  // Reporting "missing booktitle/journal" for an @book is a false positive.
  const venue = (f.booktitle || f.journal || "").trim();
  const t = entry.entryType;
  const NEEDS_BOOKTITLE = new Set(["inproceedings", "incollection", "conference"]);
  const NEEDS_JOURNAL = new Set(["article"]);
  const NEEDS_PUBLISHER = new Set(["book", "booklet", "manual"]);
  const NEEDS_INSTITUTION = new Set(["phdthesis", "mastersthesis", "techreport"]);
  const VENUE_OPTIONAL = new Set(["misc", "online", "dataset", "software", "unpublished", "proceedings"]);
  if (NEEDS_BOOKTITLE.has(t) && !f.booktitle) {
    issues.push({ severity: "error", field: "booktitle", message: `@${t} missing booktitle` });
  } else if (NEEDS_JOURNAL.has(t) && !f.journal) {
    issues.push({ severity: "error", field: "journal", message: "@article missing journal" });
  } else if (NEEDS_PUBLISHER.has(t) && !f.publisher) {
    issues.push({ severity: "warning", field: "publisher", message: `@${t} missing publisher` });
  } else if (NEEDS_INSTITUTION.has(t) && !f.institution && !f.school) {
    issues.push({ severity: "warning", field: "institution", message: `@${t} missing institution/school` });
  }
  // Preprint / abbreviation warnings only apply when there IS a venue field.
  if (venue && looksLikeArxiv(venue)) {
    // Refined: only flag as preprint if it really lacks publication-specific
    // metadata. An @inproceedings entry whose journal/booktitle includes
    // arXiv but also has booktitle/pages/etc. is just a citation style choice.
    const isBareArticle = entry.entryType === "article"
      && !f.booktitle && !f.volume && !f.pages && !f.publisher;
    if (isBareArticle) {
      const url = scholarSearchURL(entry);
      issues.push({ severity: "warning", field: "journal", message: `venue looks like a preprint server ('${venue}'); search for published version: ${url}` });
    }
  } else if (venue && entry.entryType === "inproceedings" && looksAbbreviated(venue)) {
    if (expandVenueAcronym(venue) === venue) {
      issues.push({ severity: "warning", field: "booktitle", message: `booktitle may be abbreviated ('${venue}'); use full conference name` });
    }
  }
  if (entry.entryType === "article" && venue && !looksLikeArxiv(venue)) {
    for (const k of ["volume", "number", "pages"]) {
      if (!f[k]) issues.push({ severity: "warning", field: k, message: `missing ${k}` });
    }
  }
  // Hidden-venue check: @inproceedings/@misc with venue buried in note/howpublished.
  if (!f.booktitle && !f.journal) {
    const buried = `${f.note || ""} ${f.howpublished || ""}`.toLowerCase();
    if (/conference|workshop|proceedings|symposium|published in/i.test(buried)) {
      issues.push({ severity: "warning", field: "booktitle", message: "venue appears to be in note/howpublished; move to booktitle/journal" });
    }
  }
  // Entry-type inference vs declared type. Only suggest changes when the
  // declared type is generic (@misc) — never propose downgrading a richer type
  // such as @inproceedings or @book to @article based on field shape alone.
  const declaredType = entry.entryType;
  if (declaredType === "misc") {
    let inferred = null;
    if (f.journal && !f.booktitle) inferred = "article";
    else if (f.booktitle && !f.journal) inferred = "inproceedings";
    if (inferred) {
      issues.push({ severity: "info", field: null, message: `entry type @misc but fields suggest @${inferred}` });
    }
  }
  if (f.doi && /^10\.5281\/zenodo\./i.test(f.doi.trim()) && declaredType !== "misc" && declaredType !== "dataset") {
    issues.push({ severity: "warning", field: null, message: `Zenodo DOI but type is @${declaredType}; consider @misc` });
  }
  if (f.title && /^proceedings of/i.test(f.title.trim()) && declaredType === "article") {
    issues.push({ severity: "info", field: null, message: `title starts with 'Proceedings of' but type is @article; consider @proceedings or @inproceedings` });
  }
  return issues;
}

// Decide which author list to use when the original bib already has authors.
// Hard rule: never silently drop authors. Never replace full names with
// initials-only. Curated/DBLP entries always win.
function pickAuthors(entry, scholarStr) {
  const entryStr = entry.fields.author || "";
  const entryAuthors = splitAuthors(entryStr);
  const scholarAuthors = splitAuthors(scholarStr || "");
  if (!entryAuthors.length) return { value: scholarStr || "", action: "filled" };
  if (!scholarAuthors.length) return { value: entryStr, action: "kept" };
  if (entryIsTrusted(entry)) return { value: entryStr, action: "kept" };
  // Scholar has fewer authors → never overwrite.
  if (scholarAuthors.length < entryAuthors.length) return { value: entryStr, action: "kept" };
  // Scholar has any truncated name → keep entry (avoid "Z. Li" vs "Zhuohan Li").
  if (scholarAuthors.some(isTruncatedName) && !entryAuthors.every(isTruncatedName)) {
    return { value: entryStr, action: "kept" };
  }
  // Scholar strictly more authors with full names → replace.
  if (scholarAuthors.length > entryAuthors.length) return { value: scholarStr, action: "replaced" };
  // Equal count: prefer scholar only if it looks more complete (more total chars).
  const entryLen = entryAuthors.join("").length;
  const scholarLen = scholarAuthors.join("").length;
  if (scholarLen > entryLen * 1.15 && !scholarAuthors.some(isTruncatedName)) {
    return { value: scholarStr, action: "replaced" };
  }
  return { value: entryStr, action: "kept" };
}

// Decide which venue to use. Never overwrite an existing non-preprint venue
// with a preprint-style scholar venue (the user's #1 complaint).
function pickVenue(entry, scholar) {
  const f = entry.fields;
  const entryHasBooktitle = !!f.booktitle;
  const entryHasJournal = !!f.journal;
  const entryVenue = (f.booktitle || f.journal || "").trim();
  const entryIsPreprintVenue = entryVenue && looksLikeArxiv(entryVenue);
  const scholarVenue = (scholar?.venue || "").trim();
  const scholarKind = scholar?.venueKind;
  const scholarIsPreprintVenue = scholarVenue && looksLikeArxiv(scholarVenue);

  // No entry venue: fill from scholar regardless (better something than nothing).
  if (!entryHasBooktitle && !entryHasJournal && scholarVenue && scholarKind) {
    return { kind: scholarKind, value: scholarVenue, action: "filled" };
  }
  // Entry has a non-preprint venue → never replace.
  if (entryHasBooktitle || entryHasJournal) {
    if (entryIsPreprintVenue && scholarVenue && !scholarIsPreprintVenue) {
      return { kind: scholarKind, value: scholarVenue, action: "upgraded", from: entryVenue };
    }
    return { kind: entryHasBooktitle ? "booktitle" : "journal", value: entryVenue, action: "kept" };
  }
  return { kind: null, value: null, action: "none" };
}

// Fill-only rewrite: NEVER overwrite existing fields with lower-quality data.
// Returns { text, additions, kept, blockedDowngrade } so the caller can decide
// whether the suggested block is worth showing.
function rewrite(entry, scholar) {
  const src = { ...entry.fields };
  const additions = [];
  const blocked = [];
  let scholarEntryType = null;

  if (scholar) {
    // 1. AUTHOR
    const a = pickAuthors(entry, scholar.author);
    if (a.action === "filled" || a.action === "replaced") {
      if (src.author && a.action === "filled") additions.push("author");
      else if (a.action === "replaced") additions.push("author");
      src.author = a.value;
    } else if (scholar.author && a.action === "kept" && (entry.fields.author || "") !== scholar.author) {
      blocked.push("author (kept original; scholar version was truncated or shorter)");
    }
    // 2. TITLE — only fill, never overwrite (user formatting / brace protection).
    if (!src.title && scholar.title) { src.title = scholar.title; additions.push("title"); }
    // 3. YEAR — only fill.
    if (!src.year && scholar.year) { src.year = scholar.year; additions.push("year"); }
    // 4. VENUE
    const v = pickVenue(entry, scholar);
    if (v.action === "filled") {
      src[v.kind] = v.value;
      additions.push(v.kind);
    } else if (v.action === "upgraded") {
      // Replace preprint with published venue. Drop the other field.
      delete src.booktitle; delete src.journal;
      src[v.kind] = v.value;
      additions.push(`${v.kind} (upgraded from ${v.from})`);
    } else if (v.action === "kept" && scholar.venue && scholar.venue.trim() !== (entry.fields.booktitle || entry.fields.journal || "").trim()) {
      blocked.push(`venue (kept original; scholar suggested '${scholar.venue}')`);
    }
    // 5. vol/num/pages/publisher — only fill if missing AND scholar isn't preprint.
    const scholarUseful = scholar.venue && !looksLikeArxiv(scholar.venue);
    if (scholarUseful) {
      for (const k of ["volume", "number", "pages", "publisher"]) {
        if (!src[k] && scholar[k]) { src[k] = scholar[k]; additions.push(k); }
      }
    }
    scholarEntryType = scholar.entryType ?? null;
  }

  for (const k of FORBIDDEN_FIELDS) delete src[k];
  // Pages: autofix en-dash (–) -> double-hyphen (--) per BibTeX convention.
  // (This is the only auto-cosmetic we apply; everything else respects user
  // formatting so the diff stays signal-only.)
  if (src.pages && src.pages.includes("\u2013")) {
    src.pages = src.pages.replace(/\u2013/g, "--");
    additions.push("pages (en-dash → --)");
  }
  const journal = src.journal || "";
  if (journal && looksLikeArxiv(journal)) {
    if (src.volume && ARXIV_VOLUME_RE.test(src.volume)) delete src.volume;
    delete src.number; delete src.pages; delete src.publisher;
  }

  // Entry type: NEVER downgrade. Only promote @misc -> something specific
  // when we just filled in a venue; otherwise keep the user's declared type.
  let entryType = entry.entryType;
  if (entry.entryType === "misc") {
    if (src.booktitle && !src.journal) entryType = "inproceedings";
    else if (src.journal && !src.booktitle && !looksLikeArxiv(src.journal)) entryType = "article";
    else if (scholarEntryType && ["article", "inproceedings", "book", "incollection", "techreport"].includes(scholarEntryType)) entryType = scholarEntryType;
  }

  // ZERO-NOISE PATH: if we didn't actually add anything and the entry type
  // hasn't changed, return the user's original text verbatim. This avoids
  // diff noise from field reordering / quote-style changes / acronym
  // expansion on entries that were already complete.
  const typeChanged = entryType !== entry.entryType;
  if (!additions.length && !typeChanged) {
    return { text: entry.raw.trim(), additions: [], blocked };
  }

  // PRESERVE-ORDER PATH: emit fields in the order they appeared in the
  // source. Newly filled fields (tracked in `addedFieldNames`) are appended
  // at the end so they're easy to spot in the diff.
  const addedFieldNames = new Set();
  for (const a of additions) {
    // Strip parenthetical notes like "booktitle (upgraded from arxiv)".
    const name = a.replace(/\s*\(.*\)\s*$/, "").trim();
    addedFieldNames.add(name);
  }
  // Only normalize fields we actually touched; leave untouched fields alone.
  for (const name of addedFieldNames) {
    if (name === "booktitle" && src.booktitle) src.booktitle = expandVenueAcronym(src.booktitle);
    if (name === "journal" && src.journal) src.journal = expandVenueAcronym(src.journal);
    if (name === "author" && src.author) src.author = normalizeAuthors(src.author);
  }

  // Extract the original verbatim line (or block) for each existing field
  // from entry.raw, so untouched fields render byte-identical to the input
  // and don't appear as diff hunks just because of formatting.
  const rawFieldLines = extractRawFieldLines(entry.raw);

  const lines = [`@${entryType}{${entry.citeKey},`];
  const seen = new Set();
  // 1. Emit fields in the user's original order. If the field's value is
  //    unchanged AND we have its original raw text, reuse that verbatim.
  //    Otherwise re-emit with the canonical formatting.
  for (const k of Object.keys(entry.fields)) {
    if (FORBIDDEN_FIELDS.has(k) || !src[k]) continue;
    const valueChanged = src[k] !== entry.fields[k];
    if (!valueChanged && rawFieldLines[k]) {
      // Reuse the original raw text byte-for-byte (preserves whatever indent
      // the user had). Strip leading newlines (the extractor captures the
      // whitespace between fields, including the line break — but lines.join
      // adds its own newline, so leaving it in produces blank gaps).
      let raw = rawFieldLines[k].replace(/^\n+/, "").replace(/\s*$/, "");
      if (!raw.endsWith(",")) raw += ",";
      lines.push(raw);
    } else {
      lines.push(`  ${k.padEnd(10)}= {${src[k]}},`);
    }
    seen.add(k);
  }
  // 2. Append newly filled fields not in the original (always canonical).
  for (const [k, v] of Object.entries(src)) {
    if (seen.has(k) || FORBIDDEN_FIELDS.has(k) || !v) continue;
    lines.push(`  ${k.padEnd(10)}= {${v}},`);
  }
  if (lines[lines.length - 1].endsWith(",")) lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
  lines.push("}");
  return { text: lines.join("\n"), additions, blocked };
}

// Parse `entry.raw` into a map { fieldName: originalLineText } so the
// rewriter can re-emit untouched fields byte-for-byte. Handles values that
// span multiple lines by greedily matching balanced braces / quotes.
function extractRawFieldLines(raw) {
  const out = {};
  if (!raw) return out;
  // Strip the @type{key, prefix and trailing }.
  const inner = raw.replace(/^[\s\S]*?\{[^,]*,/, "").replace(/\}\s*$/, "");
  // Tokenize: walk char-by-char, tracking brace/quote depth so we know where
  // each field ends. Splitting on bare commas would break on `{a,b}`.
  let i = 0;
  while (i < inner.length) {
    // Capture leading whitespace as part of the field slice so the user's
    // original indent is preserved verbatim on reuse.
    const fieldStart = i;
    while (i < inner.length && /\s/.test(inner[i])) i++;
    if (i >= inner.length) break;
    if (inner[i] === ",") { i++; continue; }
    // Read field name: letters / digits / dashes up to '='.
    const eqMatch = /^([A-Za-z_][\w-]*)\s*=\s*/.exec(inner.slice(i));
    if (!eqMatch) { i++; continue; }
    const name = eqMatch[1].toLowerCase();
    i += eqMatch[0].length;
    // Read value: braced, quoted, or bare.
    if (inner[i] === "{") {
      let depth = 1; i++;
      while (i < inner.length && depth > 0) {
        if (inner[i] === "\\" && i + 1 < inner.length) { i += 2; continue; }
        if (inner[i] === "{") depth++;
        else if (inner[i] === "}") depth--;
        i++;
      }
    } else if (inner[i] === '"') {
      i++;
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === "\\" && i + 1 < inner.length) { i += 2; continue; }
        i++;
      }
      if (inner[i] === '"') i++;
    } else {
      while (i < inner.length && inner[i] !== ",") i++;
    }
    out[name] = inner.slice(fieldStart, i);
  }
  return out;
}

// ========== Title-match (token sort ratio) ==========

function tokenize(s) {
  // Strip LaTeX and expand venue abbreviations BEFORE lowercase tokenizing so
  // "{B-ERT}" -> "bert" and "Phys. Rev. Lett." -> "physical review letters".
  s = expandVenueAbbrevs(stripLatex(s || ""));
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
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

// Fetch with automatic retry on HTTP 429 (rate limit) AND on network-level
// TypeError ("Failed to fetch") which Semantic Scholar in particular emits
// when it drops a connection under load. Also enforces a per-attempt timeout
// because Safari has a known bug where some concurrent cross-origin fetches
// never resolve (no response, no error) — without this the whole audit stalls.
// Honors Retry-After when the server provides it; otherwise exponential backoff.
async function fetchWithRetry(url, options = {}, maxRetries = 3, perAttemptTimeoutMs = 15000) {
  let delayMs = 1000;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perAttemptTimeoutMs);
    try {
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.status !== 429 || attempt === maxRetries) return resp;
      const retryAfter = parseFloat(resp.headers.get("Retry-After") || "");
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : delayMs;
      await new Promise(r => setTimeout(r, wait));
      delayMs *= 2;
    } catch (e) {
      clearTimeout(timer);
      // Normalize abort to a clearer message.
      if (e.name === "AbortError") lastErr = new Error(`request timed out after ${perAttemptTimeoutMs}ms`);
      else lastErr = e;
      if (attempt === maxRetries) throw lastErr;
      await new Promise(r => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
  if (lastErr) throw lastErr;
}

async function oaSearch(title, email) {
  // OpenAlex "polite pool" — adding mailto= moves us off the shared anonymous
  // bucket and gives ~10 req/s instead of frequent 429s.
  const params = new URLSearchParams({ search: title, "per-page": "10" });
  if (email) params.set("mailto", email);
  const url = `${OA_BASE}?${params.toString()}`;
  const resp = await fetchWithRetry(url, { headers: { "Accept": "application/json" } });
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

async function openalexLookup(title, hint, email) {
  try {
    const hits = await oaSearch(title, email);
    let r = pickBest(title, hits, hint, 75);
    if (!r) {
      // simplify: drop subtitle
      const colon = title.indexOf(":");
      if (colon > 10) {
        const hits2 = await oaSearch(title.slice(0, colon), email);
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

// ========== Semantic Scholar ==========

const S2_BASE = "https://api.semanticscholar.org/graph/v1/paper/search";
const S2_FIELDS = "title,authors,year,venue,publicationVenue,journal,externalIds,publicationTypes";

async function s2Search(title, apiKey) {
  const url = `${S2_BASE}?query=${encodeURIComponent(title)}&limit=10&fields=${encodeURIComponent(S2_FIELDS)}`;
  const headers = { "Accept": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  // S2's anonymous pool is extremely strict (~1 req/s shared globally) and
  // often closes the connection instead of returning 429, surfacing as
  // "TypeError: Failed to fetch". Retry with backoff handles both cases.
  const resp = await fetchWithRetry(url, { headers });
  if (!resp.ok) throw new Error(`Semantic Scholar HTTP ${resp.status}${apiKey ? "" : " (try adding an S2 API key)"}`);
  const data = await resp.json();
  return data.data || [];
}

function s2ToResult(item) {
  const authors = (item.authors || []).map(a => a.name).filter(Boolean);
  const pv = item.publicationVenue || {};
  const journal = item.journal || {};
  let venue = pv.name || item.venue || journal.name || "";
  const types = item.publicationTypes || [];
  const isConf = (pv.type || "").toLowerCase() === "conference"
    || types.some(t => /conference/i.test(t));
  const isJournal = (pv.type || "").toLowerCase() === "journal"
    || types.some(t => /journal/i.test(t));
  let entryType = "article", venueKind = "journal";
  if (isConf) { entryType = "inproceedings"; venueKind = "booktitle"; }
  else if (isJournal) { entryType = "article"; venueKind = "journal"; }
  // Treat arXiv-only entries as preprint.
  const arxivOnly = item.externalIds && item.externalIds.ArXiv
    && !item.externalIds.DOI && !venue;
  if (arxivOnly) { venue = "arXiv preprint"; venueKind = "journal"; entryType = "article"; }
  return {
    title: item.title || "",
    authors,
    year: item.year ?? null,
    venue,
    venueKind,
    volume: journal.volume || "",
    number: "",
    pages: journal.pages || "",
    publisher: "",
    entryType,
    rawMeta: `S2 paperId=${item.paperId} venueType='${pv.type || "?"}'`,
    isPreprint: arxivOnly || /arxiv|preprint|corr/i.test(venue || ""),
  };
}

async function s2Lookup(title, hint, apiKey) {
  try {
    const items = await s2Search(title, apiKey);
    let best = null, bestScore = 0;
    for (const it of items) {
      const r = s2ToResult(it);
      if (!r.title) continue;
      const score = tokenSetRatio(title, r.title);
      if (score < 80) continue;
      if (!authorOk(r, hint)) continue;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  } catch (e) {
    return { __error: e.message };
  }
}

// arXiv export API (CORS-enabled). Returns latest version number for an
// arXiv ID, or null on failure. Cached per id.
const _arxivVersionCache = new Map();
async function arxivLatestVersion(id) {
  if (_arxivVersionCache.has(id)) return _arxivVersionCache.get(id);
  try {
    const res = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
    if (!res.ok) { _arxivVersionCache.set(id, null); return null; }
    const text = await res.text();
    // Match <id>http://arxiv.org/abs/2001.08361v3</id>
    const m = /<id>\s*https?:\/\/arxiv\.org\/abs\/[^<]*v(\d+)\s*<\/id>/i.exec(text);
    const v = m ? parseInt(m[1], 10) : null;
    _arxivVersionCache.set(id, v);
    return v;
  } catch {
    _arxivVersionCache.set(id, null);
    return null;
  }
}

// ========== LLM hallucination check (opt-in, requires OpenAI key) ==========
//
// For unmatched references we ask a small LLM to assess whether the citation
// looks fabricated. The model is asked to return strict JSON. We never send
// content other than fields already in the user's bib.
async function llmHallucinationCheck(entry, apiKey, model = "gpt-4o-mini") {
  const f = entry.fields;
  const userMsg = `Assess whether the following BibTeX reference describes a real academic work. Reply ONLY with strict JSON: {"verdict":"real|likely_real|uncertain|likely_fabricated","reason":"<=200 chars","best_known_venue":"<=80 chars or empty","best_known_year":"YYYY or empty"}.\n\nTitle: ${f.title || "(missing)"}\nAuthors: ${f.author || "(missing)"}\nYear: ${f.year || "(missing)"}\nVenue: ${f.booktitle || f.journal || "(missing)"}\nDOI: ${f.doi || "(none)"}\narXiv: ${f.eprint || "(none)"}`;
  const body = {
    model,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: "You are a meticulous research librarian. You must not invent references. If you do not recognise the work from training data, return verdict=uncertain or likely_fabricated and explain briefly. Never claim a paper is real unless you are confident." },
      { role: "user", content: userMsg },
    ],
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 160)}`);
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); } catch { return { verdict: "uncertain", reason: "non-JSON LLM reply" }; }
}

// ========== Pipeline ==========

// Session-wide tally of API failures so we can summarize once instead of
// spamming a warning under every entry (the user's #3 complaint about S2).
// `details` keeps per-failure { citeKey, msg } so the summary can expand.
const _apiFailures = {
  openalex: 0, crossref: 0, s2: 0,
  details: { openalex: [], crossref: [], s2: [] },
};
function _recordApiFailure(src, msg, citeKey) {
  _apiFailures[src] = (_apiFailures[src] || 0) + 1;
  if (_apiFailures.details[src]) _apiFailures.details[src].push({ citeKey: citeKey || "?", msg: String(msg) });
  console.warn(`[bib-check] ${src} failure on ${citeKey || "?"}: ${msg}`);
}

async function auditOne(entry, opts) {
  const issues = detectIssues(entry);
  const trusted = entryIsTrusted(entry);
  const title = entry.fields.title || "";
  const hint = entry.fields.author || "";
  let match = null, source = "none";
  let upgradedFrom = null;

  // arXiv version freshness check (only if entry has an explicit version like v2).
  const arxivInfo = extractArxivId(entry);
  if (arxivInfo && arxivInfo.version != null) {
    const latest = await arxivLatestVersion(arxivInfo.id);
    if (latest && latest > arxivInfo.version) {
      issues.push({ severity: "warning", field: "eprint", message: `cites arXiv:${arxivInfo.id}v${arxivInfo.version}; latest is v${latest}` });
    }
  }

  if (title && opts.useOpenalex) {
    const r = await openalexLookup(title, hint, opts.email);
    if (r && r.__error) _recordApiFailure("openalex", r.__error, entry.citeKey);
    else if (r) { match = r; source = "openalex"; }
  }
  if (title && opts.useCrossref && (match === null || isPreprint(match))) {
    const cr = await crossrefLookup(title, hint);
    if (cr && cr.__error) _recordApiFailure("crossref", cr.__error, entry.citeKey);
    else if (cr && !isPreprint(cr)) {
      const score = tokenSortRatio(title, cr.title);
      if (score >= 92 || match === null) {
        if (score >= 88) {
          if (match && isPreprint(match)) upgradedFrom = match.venue || "preprint";
          if (match && match.authors?.length) cr.authors = match.authors; // keep ordering
          match = cr; source = "crossref";
        }
      }
    }
  }
  if (title && opts.useS2 && (match === null || isPreprint(match))) {
    const s2 = await s2Lookup(title, hint, opts.s2Key);
    if (s2 && s2.__error) _recordApiFailure("s2", s2.__error, entry.citeKey);
    else if (s2) {
      const score = tokenSortRatio(title, s2.title);
      // Accept S2 if no match yet, or if it's a non-preprint upgrade.
      if (match === null && score >= 80) {
        match = s2; source = "s2";
      } else if (match && isPreprint(match) && !isPreprint(s2) && score >= 88) {
        upgradedFrom = match.venue || "preprint";
        if (match.authors?.length) s2.authors = match.authors;
        match = s2; source = "s2";
      }
    }
  }
  // (API failures are tracked silently in _apiFailures and surfaced in renderSummary.)

  // === Sanity gates: reject implausible matches before they poison rewrite. ===
  // Year sanity (#1): jevons1865 must not match a 2023 Routledge re-print.
  // Allow ±5 years to absorb early-access vs camera-ready drift.
  if (match) {
    const bibYear = parseInt((entry.fields.year || "").trim(), 10);
    const matchYear = parseInt(match.year ?? "", 10);
    if (bibYear && matchYear && Math.abs(bibYear - matchYear) > 5) {
      issues.push({ severity: "info", field: null, message: `${source} candidate rejected (year mismatch: bib=${bibYear}, ${source}=${matchYear}, Δ${Math.abs(bibYear - matchYear)} years)` });
      match = null; source = "none"; upgradedFrom = null;
    }
  }
  // Venue-acronym sanity (#4): if the bib venue contains a well-known venue
  // acronym (OSDI, NAACL, ...), reject any match whose normalized venue is a
  // *different* well-known venue. Catches OSDI being matched to ACL.
  if (match && match.venue) {
    const bibVenueRaw = `${entry.fields.booktitle || ""} ${entry.fields.journal || ""}`.toLowerCase();
    const matchVenueLower = String(match.venue).toLowerCase();
    let bibAcronym = null, matchAcronym = null;
    for (const k of Object.keys(VENUE_FULL_NAME)) {
      const re = new RegExp(`\\b${k}\\b`);
      if (!bibAcronym && re.test(bibVenueRaw)) bibAcronym = k;
      // Match a known acronym in match.venue either by short token or by
      // checking whether match.venue equals/contains the canonical full name.
      const fullLower = VENUE_FULL_NAME[k].toLowerCase();
      if (!matchAcronym && (re.test(matchVenueLower) || matchVenueLower.includes(fullLower))) matchAcronym = k;
    }
    if (bibAcronym && matchAcronym && bibAcronym !== matchAcronym) {
      issues.push({ severity: "info", field: null, message: `${source} candidate rejected (venue mismatch: bib mentions ${bibAcronym.toUpperCase()} but ${source} returned ${matchAcronym.toUpperCase()})` });
      match = null; source = "none"; upgradedFrom = null;
    }
  }

  // Author-diff vs match (count / membership / order). Differences are
  // classified by similarity so cosmetic deviations don't raise false alarms.
  if (match && match.authors?.length) {
    const bibLast = extractAuthorLastnames(entry.fields.author || "");
    const matchLast = match.authors.map(authorLastname).filter(Boolean);
    if (bibLast.length && matchLast.length) {
      // Pair-up by index to detect "near match" (typo / hyphen / accent) vs
      // genuinely different surnames.
      const fuzzyEq = (a, b) => {
        if (a === b) return true;
        if (!a || !b) return false;
        if (a.startsWith(b) || b.startsWith(a)) return true;
        const dist = levenshtein(a, b);
        return dist <= Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.15));
      };
      const bibSet = new Set(bibLast), matchSet = new Set(matchLast);
      // Filter "others"/"al"/"others" tokens from extras: these come from
      // "and others" in the bib and are already reported as a separate error
      // by detectIssues — no need to also list them as "missing from crossref".
      const NOISE_LASTNAMES = new Set(["others", "al", "etal"]);
      const missing = matchLast.filter(x => !bibSet.has(x) && !bibLast.some(y => fuzzyEq(x, y)));
      const extra = bibLast.filter(x => !matchSet.has(x) && !matchLast.some(y => fuzzyEq(x, y)) && !NOISE_LASTNAMES.has(x));
      if (bibLast.length !== matchLast.length) {
        const sev = Math.abs(bibLast.length - matchLast.length) >= 2 ? "warning" : "info";
        issues.push({ severity: sev, field: "author", message: `author count differs: bib=${bibLast.length}, ${source}=${matchLast.length}` });
      }
      if (missing.length) issues.push({ severity: "warning", field: "author", message: `authors in ${source} but missing from bib: ${missing.join(", ")}` });
      if (extra.length) issues.push({ severity: "warning", field: "author", message: `authors in bib but not in ${source}: ${extra.join(", ")}` });
      if (!missing.length && !extra.length && bibLast.length === matchLast.length) {
        let orderDiffs = 0, fuzzyDiffs = 0;
        for (let i = 0; i < bibLast.length; i++) {
          if (bibLast[i] === matchLast[i]) continue;
          if (fuzzyEq(bibLast[i], matchLast[i])) { fuzzyDiffs++; continue; }
          orderDiffs++;
        }
        if (orderDiffs) issues.push({ severity: "warning", field: "author", message: `author order differs from ${source}` });
        else if (fuzzyDiffs) issues.push({ severity: "info", field: "author", message: `${fuzzyDiffs} author surname(s) have minor spelling differences vs ${source}` });
      }
    }
  }

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
  const r = rewrite(entry, scholar);
  // Surface blocked downgrades as info-level notes so the user knows why the
  // suggested block didn't change a particular field.
  for (const reason of r.blocked) {
    issues.push({ severity: "info", field: null, message: `kept original: ${reason}` });
  }
  return {
    entry, issues, match, source,
    rewritten: r.text,
    additions: r.additions,
    blocked: r.blocked,
    trusted,
    upgradedFrom,
  };
}

function extractAuthorLastnames(authorsStr) {
  return splitAuthors(authorsStr).map(a => {
    a = stripLatex(a);
    let last;
    if (a.includes(",")) last = a.split(",")[0].trim();
    else { const t = a.split(/\s+/); last = t[t.length - 1]; }
    return last.replace(/[^a-zA-Z]/g, "").toLowerCase();
  }).filter(Boolean);
}

function scholarSearchURL(entry) {
  const title = (entry.fields.title || "").replace(/[{}\\]/g, "");
  const author = (entry.fields.author || "").split(/\s+and\s+/i)[0].replace(/[{}\\]/g, "");
  const q = `${title} ${author}`.replace(/\s+/g, " ").trim();
  return "https://scholar.google.com/scholar?q=" + encodeURIComponent(q);
}

// ========== Renderer ==========

const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Escape, then turn http(s) URLs into clickable links. Used for issue
// messages that embed e.g. a Google Scholar search URL.
function linkifyMessage(s) {
  const esc = escapeHtml(s);
  return esc.replace(/https?:\/\/[^\s<>"']+/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

function diffLines(oldText, newText) {
  // Backwards-compat: still expose the side-by-side highlight if needed.
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines.map(l => l.trim()));
  const newSet = new Set(newLines.map(l => l.trim()));
  const renderOld = oldLines.map(l => newSet.has(l.trim()) ? escapeHtml(l) : `<span class="del">${escapeHtml(l)}</span>`).join("\n");
  const renderNew = newLines.map(l => oldSet.has(l.trim()) ? escapeHtml(l) : `<span class="add">${escapeHtml(l)}</span>`).join("\n");
  return { renderOld, renderNew };
}

// Git-style unified diff via LCS. Returns an array of {tag:" "|"-"|"+", line:string}.
function unifiedDiff(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length, m = b.length;
  // LCS table (rows = n+1, cols = m+1).
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ tag: " ", line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ tag: "-", line: a[i] }); i++; }
    else { out.push({ tag: "+", line: b[j] }); j++; }
  }
  while (i < n) out.push({ tag: "-", line: a[i++] });
  while (j < m) out.push({ tag: "+", line: b[j++] });
  return out;
}

function renderUnifiedDiff(oldText, newText) {
  const diff = unifiedDiff(oldText, newText);
  const adds = diff.filter(d => d.tag === "+").length;
  const dels = diff.filter(d => d.tag === "-").length;
  if (!adds && !dels) {
    return `<pre class="bib diff diff-empty">${escapeHtml(oldText)}</pre>`;
  }
  let oldLn = 0, newLn = 0;
  const rows = diff.map(d => {
    let oldNum = "", newNum = "", cls;
    if (d.tag === " ") { oldLn++; newLn++; oldNum = oldLn; newNum = newLn; cls = "ctx"; }
    else if (d.tag === "-") { oldLn++; oldNum = oldLn; cls = "del"; }
    else { newLn++; newNum = newLn; cls = "add"; }
    return `<div class="d-row d-${cls}"><span class="d-ln d-ln-old">${oldNum}</span><span class="d-ln d-ln-new">${newNum}</span><span class="d-sign">${d.tag}</span><span class="d-line">${escapeHtml(d.line) || "&nbsp;"}</span></div>`;
  }).join("");
  return `<div class="diff-block"><div class="diff-header"><span class="d-stat add">+${adds}</span> <span class="d-stat del">-${dels}</span></div><div class="diff-body">${rows}</div></div>`;
}

function renderEntry(a) {
  const e = a.entry;
  const errs = a.issues.filter(i => i.severity === "error").length;
  const warns = a.issues.filter(i => i.severity === "warning").length;
  const infos = a.issues.filter(i => i.severity === "info").length;
  const visible = a.issues.filter(i => i.severity === "error" || i.severity === "warning" || i.severity === "info");
  const hasChanges = (a.additions && a.additions.length > 0) || (e.raw.trim() !== a.rewritten);
  const badges = [];
  badges.push(`<span class="badge src-${a.source}">${a.source}</span>`);
  if (a.trusted) badges.push(`<span class="badge trusted" title="entry looks curated (DBLP source or full author names); aggregator data is only used to fill missing fields">trusted</span>`);
  if (a.upgradedFrom) badges.push(`<span class="badge upgraded" title="upgraded from ${escapeHtml(a.upgradedFrom)}">upgraded</span>`);
  if (errs) badges.push(`<span class="badge err">${errs}</span>`);
  if (warns) badges.push(`<span class="badge warn">${warns}</span>`);
  if (!errs && !warns) badges.push(`<span class="badge ok">clean</span>`);
  const unified = renderUnifiedDiff(e.raw.trim(), a.rewritten);
  const scholarUrl = scholarSearchURL(e);

  const matchHtml = a.match ? `
    <div class="section">
      <h4>Match <span class="badge src-${a.source}">${a.source}</span>${a.upgradedFrom ? ` <span style="color:var(--muted);font-weight:normal;text-transform:none;letter-spacing:0">— upgraded from ${escapeHtml(a.upgradedFrom)}</span>` : ""}</h4>
      <div class="match-meta">
        <div class="row"><span class="k">title</span><span class="v">${escapeHtml(a.match.title)}</span></div>
        <div class="row"><span class="k">authors</span><span class="v">${escapeHtml((a.match.authors || []).join(", ") || "(none)")}</span></div>
        <div class="row"><span class="k">year</span><span class="v">${escapeHtml(String(a.match.year ?? "?"))}</span></div>
        <div class="row"><span class="k">venue</span><span class="v">${escapeHtml(a.match.venue || "?")} <span style="color:var(--muted)">(${escapeHtml(a.match.venueKind || "?")})</span></span></div>
        <div class="row"><span class="k">vol/num/pp</span><span class="v">${escapeHtml(String(a.match.volume || "-"))} / ${escapeHtml(String(a.match.number || "-"))} / ${escapeHtml(String(a.match.pages || "-"))}</span></div>
        <div class="row"><span class="k">meta</span><span class="v trunc" title="${escapeHtml(a.match.rawMeta || "")}">${escapeHtml(a.match.rawMeta || "")}</span></div>
      </div>
    </div>` : "";

  const issuesHtml = visible.length ? `
    <div class="section">
      <h4>Issues</h4>
      <ul class="issues">${visible.map(i => `<li class="sev-${i.severity}"><span class="badge ${i.severity === "error" ? "err" : i.severity === "warning" ? "warn" : "info"}">${i.severity}</span>${i.field ? `<code>${escapeHtml(i.field)}</code>` : ""}${linkifyMessage(i.message)}</li>`).join("")}</ul>
    </div>` : "";

  const matchSection = a.match ? matchHtml : `
    <div class="section">
      <h4>Match</h4>
      <div class="no-match">No match found in OpenAlex, Crossref, or Semantic Scholar.
        <a href="${scholarUrl}" target="_blank" rel="noopener">Search Google Scholar →</a>
      </div>
    </div>`;

  const diffSection = hasChanges ? `
        <div class="section">
          <h4>Diff (original → suggested)${a.additions && a.additions.length ? ` <span style="color:var(--muted);font-weight:normal;text-transform:none;letter-spacing:0">filled: ${escapeHtml(a.additions.join(", "))}</span>` : ""} <button class="copy-btn" data-copy="suggested">Copy suggested</button></h4>
          ${unified}
          <pre class="bib hidden" data-suggested>${escapeHtml(a.rewritten)}</pre>
        </div>` : `
        <div class="section">
          <h4>Suggested</h4>
          <div class="no-changes">No changes — original entry already complete (not downgraded by aggregator data).</div>
        </div>`;

  return `
    <article class="entry" data-key="${escapeHtml(e.citeKey)}" data-errs="${errs}" data-warns="${warns}" data-infos="${infos}" data-trusted="${a.trusted ? "1" : "0"}" data-source="${a.source}">
      <div class="head">
        <div class="title"><span class="chevron">▸</span><span class="idx">[${e.index}]</span><span class="key">${escapeHtml(e.citeKey)}</span><span class="meta">line ${e.lineNumber}</span></div>
        <div class="badges">${badges.join("")}</div>
      </div>
      <div class="body">
        <div class="body-inner">
        ${issuesHtml}
        ${matchSection}
        ${diffSection}
        </div>
      </div>
    </article>`;
}

function renderSummary(audited) {
  const total = audited.length;
  const oa = audited.filter(a => a.source === "openalex").length;
  const cr = audited.filter(a => a.source === "crossref").length;
  const s2 = audited.filter(a => a.source === "s2").length;
  const none = audited.filter(a => a.source === "none").length;
  const clean = audited.filter(a => !a.issues.some(i => i.severity === "error" || i.severity === "warning")).length;
  const errs = audited.filter(a => a.issues.some(i => i.severity === "error")).length;
  const trusted = audited.filter(a => a.trusted).length;
  $("#summary").classList.remove("hidden");
  let html = `
    <div class="card total"><div class="n">${total}</div><div class="l">total</div></div>
    <div class="card clean"><div class="n">${clean}</div><div class="l">clean</div></div>
    <div class="card errors"><div class="n">${errs}</div><div class="l">with errors</div></div>
    <div class="card trusted"><div class="n">${trusted}</div><div class="l">trusted</div></div>
    <div class="card oa"><div class="n">${oa}</div><div class="l">via OpenAlex</div></div>
    <div class="card cr"><div class="n">${cr}</div><div class="l">via Crossref</div></div>
    <div class="card s2"><div class="n">${s2}</div><div class="l">via S2</div></div>
    <div class="card unmatched"><div class="n">${none}</div><div class="l">unmatched</div></div>`;
  const apiNotes = [];
  if (_apiFailures.openalex) apiNotes.push(`OpenAlex failed ${_apiFailures.openalex}×`);
  if (_apiFailures.crossref) apiNotes.push(`Crossref failed ${_apiFailures.crossref}×`);
  if (_apiFailures.s2) apiNotes.push(`Semantic Scholar failed ${_apiFailures.s2}×`);
  if (apiNotes.length) {
    // Build an expandable details list grouped by source, showing which
    // cite keys triggered which error message.
    const detailRows = [];
    for (const src of ["openalex", "crossref", "s2"]) {
      const list = _apiFailures.details[src] || [];
      if (!list.length) continue;
      detailRows.push(`<div class="api-fail-group"><strong>${src}</strong> (${list.length}):</div>`);
      // If OpenAlex is failing and no polite-pool email is set, hint at it.
      if (src === "openalex" && !($("#email")?.value || "").trim()) {
        detailRows.push(`<div class="api-fail-row" style="background:rgba(255,200,0,0.08);border-left:3px solid #f5a623;padding:6px 10px;margin:4px 0;">
          <strong>Tip:</strong> Add your email to the &ldquo;Email (OpenAlex polite pool)&rdquo; field above
          to get ~10 req/s instead of the shared anonymous bucket. The email is sent only to OpenAlex per their
          <a href="https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication" target="_blank" rel="noopener">polite pool policy</a>.
        </div>`);
      }
      // If S2 is failing and no API key is set, add a hint with the
      // application link so users know how to fix the rate limiting.
      if (src === "s2" && !($("#s2key")?.value || "").trim()) {
        detailRows.push(`<div class="api-fail-row" style="background:rgba(255,200,0,0.08);border-left:3px solid #f5a623;padding:6px 10px;margin:4px 0;">
          <strong>Tip:</strong> Semantic Scholar's anonymous pool is shared globally (~1 req/s) and frequently drops connections under load.
          Get a free API key at <a href="https://www.semanticscholar.org/product/api#api-key-form" target="_blank" rel="noopener">semanticscholar.org/product/api</a>
          and paste it into the &ldquo;S2 key&rdquo; field above.
        </div>`);
      }
      // Group by error message so 5 identical "Load failed" collapse into one row.
      const byMsg = new Map();
      for (const { citeKey, msg } of list) {
        if (!byMsg.has(msg)) byMsg.set(msg, []);
        byMsg.get(msg).push(citeKey);
      }
      for (const [msg, keys] of byMsg) {
        detailRows.push(`<div class="api-fail-row"><code>${escapeHtml(msg)}</code> &mdash; ${keys.map(k => `<code>${escapeHtml(k)}</code>`).join(", ")}</div>`);
      }
    }
    html += `<div class="card api-notes">
      <details>
        <summary><div class="l">API issues: ${apiNotes.join(" · ")} <span style="color:var(--muted);font-weight:normal">(click for details)</span></div></summary>
        <div class="api-fail-details">${detailRows.join("")}</div>
      </details>
    </div>`;
  }
  $("#summary").innerHTML = html;
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

const CONCURRENCY = 3;
const INTER_BATCH_MS = 150;
let _auditRunning = false;

async function runAudit() {
  if (_auditRunning) return;
  _auditRunning = true;
  const runBtn = $("#run");
  runBtn.disabled = true;
  runBtn.textContent = "Running…";

  try {
  const text = $("#bib").value;
  const entries = parseBib(text);
  if (!entries.length) { setStatus("No BibTeX entries found.", 100); return; }
  const range = parseRange($("#range").value, entries.length);
  const targets = range ? entries.filter(e => e.index >= range.a && e.index <= range.b) : entries;
  const opts = {
    useOpenalex: $("#useOpenalex").checked,
    useCrossref: $("#useCrossref").checked,
    useS2: $("#useS2").checked,
    s2Key: $("#s2key").value.trim() || null,
    email: ($("#email")?.value || "").trim() || null,
  };
  $("#results").innerHTML = "";
  $("#summary").classList.add("hidden");
  _apiFailures.openalex = 0; _apiFailures.crossref = 0; _apiFailures.s2 = 0;
  _apiFailures.details.openalex = []; _apiFailures.details.crossref = []; _apiFailures.details.s2 = [];

  // Cross-entry duplicate detection
  const dupGroups = new Map();
  for (const e of entries) {
    const t = (e.fields.title || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (!dupGroups.has(t)) dupGroups.set(t, []);
    dupGroups.get(t).push(e.citeKey);
  }
  const dupOf = new Map();
  for (const keys of dupGroups.values()) {
    if (keys.length > 1) for (const k of keys) dupOf.set(k, keys);
  }

  const audited = [];
  let completed = 0;

  function updateProgress() {
    setStatus(`Auditing ${completed} / ${targets.length}`, (completed / targets.length) * 100);
  }

  async function processOne(e) {
    const a = await auditOne(e, opts);
    if (dupOf.has(e.citeKey)) {
      const others = dupOf.get(e.citeKey).filter(k => k !== e.citeKey);
      a.issues.push({ severity: "warning", field: "title", message: `possible duplicate of: ${others.join(", ")}` });
    }
    audited.push(a);
    $("#results").insertAdjacentHTML("beforeend", renderEntry(a));
    completed++;
    updateProgress();
  }

  // Worker-pool: keep CONCURRENCY tasks in flight at all times. This is more
  // resilient than fixed batches — if one entry's API calls are slow, other
  // workers keep consuming from the queue instead of all 3 waiting.
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < targets.length) {
      const e = targets[nextIdx++];
      try { await processOne(e); }
      catch (err) {
        // Defensive: processOne shouldn't throw (auditOne swallows source errors)
        // but if it does, log and keep the worker alive.
        console.error("audit worker error", e.citeKey, err);
        completed++; updateProgress();
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  setStatus(`Done. Audited ${audited.length} entries.`, 100);
  renderSummary(audited);
  setupExports(audited);
  // Sort audited back to original order for exports/persistence
  audited.sort((a, b) => a.entry.index - b.entry.index);
  saveState(text, opts, audited);

  } finally {
    _auditRunning = false;
    runBtn.disabled = false;
    runBtn.textContent = "Audit";
  }
}

// ========== Persistence (localStorage) ==========

const LS_KEY = "bibcheck.state.v1";

function saveState(bibText, opts, audited) {
  try {
    const payload = {
      savedAt: new Date().toISOString(),
      bib: bibText,
      range: $("#range").value,
      opts,
      audited: audited.map(a => ({
        entry: a.entry,
        issues: a.issues,
        match: a.match,
        source: a.source,
        rewritten: a.rewritten,
        upgradedFrom: a.upgradedFrom,
        additions: a.additions || [],
        blocked: a.blocked || [],
        trusted: !!a.trusted,
      })),
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("saveState failed:", e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn("loadState failed:", e);
    return null;
  }
}

function clearState() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

function restoreFromState() {
  const s = loadState();
  if (!s) return;
  if (s.bib) $("#bib").value = s.bib;
  if (typeof s.range === "string") $("#range").value = s.range;
  if (s.opts) {
    if ("useOpenalex" in s.opts) $("#useOpenalex").checked = !!s.opts.useOpenalex;
    if ("useCrossref" in s.opts) $("#useCrossref").checked = !!s.opts.useCrossref;
    if ("useS2" in s.opts) $("#useS2").checked = !!s.opts.useS2;
    if (s.opts.s2Key) $("#s2key").value = s.opts.s2Key;
    if (s.opts.email && $("#email")) $("#email").value = s.opts.email;
  }
  if (Array.isArray(s.audited) && s.audited.length) {
    $("#results").innerHTML = s.audited.map(renderEntry).join("");
    renderSummary(s.audited);
    setupExports(s.audited);
    const when = s.savedAt ? new Date(s.savedAt).toLocaleString() : "previous run";
    setStatus(`Restored ${s.audited.length} entries from ${when}. Click "Run audit" to refresh.`, 100);
  }
}

function download(name, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildBib(audited) {
  // Only emit entries where we actually have something better than the
  // original. Otherwise re-emit the user's original verbatim.
  return audited.map(a => {
    const hasChanges = (a.additions && a.additions.length) || (a.entry.raw.trim() !== a.rewritten);
    return hasChanges ? a.rewritten : a.entry.raw.trim();
  }).join("\n\n") + "\n";
}

function buildJson(audited) {
  return JSON.stringify(audited.map(a => ({
    index: a.entry.index,
    citeKey: a.entry.citeKey,
    line: a.entry.lineNumber,
    source: a.source,
    issues: a.issues,
    match: a.match,
    original: a.entry.raw.trim(),
    suggested: a.rewritten,
  })), null, 2);
}

function buildMarkdown(audited) {
  // Top-summary so users can scan instead of paging through every entry.
  const total = audited.length;
  const errs = audited.filter(a => a.issues.some(i => i.severity === "error")).length;
  const warns = audited.filter(a => a.issues.some(i => i.severity === "warning")).length;
  const unmatched = audited.filter(a => a.source === "none").length;
  const trusted = audited.filter(a => a.trusted).length;
  const lines = [
    "# bib-check report", "",
    `**Summary**: ${total} entries · ${errs} with errors · ${warns} with warnings · ${unmatched} unmatched · ${trusted} marked trusted`,
    "",
  ];
  // Errors-first table for quick triage.
  const errEntries = audited.filter(a => a.issues.some(i => i.severity === "error"));
  if (errEntries.length) {
    lines.push("## ❌ Errors (must fix)", "", "| cite key | line | issue |", "|---|---|---|");
    for (const a of errEntries) {
      for (const i of a.issues.filter(x => x.severity === "error")) {
        lines.push(`| \`${a.entry.citeKey}\` | ${a.entry.lineNumber} | ${i.field ? `\`${i.field}\`: ` : ""}${i.message.replace(/\|/g, "\\|")} |`);
      }
    }
    lines.push("");
  }
  lines.push("## Detail", "");
  for (const a of audited) {
    const e = a.entry;
    const trustedBadge = a.trusted ? " · _trusted_" : "";
    lines.push(`### [${e.index}] \`${e.citeKey}\` (line ${e.lineNumber}) — source: ${a.source}${trustedBadge}`, "");
    const visible = a.issues.filter(i => i.severity === "error" || i.severity === "warning" || i.severity === "info");
    if (visible.length) {
      lines.push("**Issues**");
      for (const i of visible) {
        const tag = i.severity === "error" ? "❌" : i.severity === "warning" ? "⚠️" : "ℹ️";
        lines.push(`- ${tag} ${i.field ? `\`${i.field}\`: ` : ""}${i.message}`);
      }
      lines.push("");
    }
    if (a.match) {
      lines.push("**Match**", `- title: ${a.match.title}`, `- authors: ${a.match.authors?.join(", ") || "(none)"}`, `- year: ${a.match.year ?? "?"}`, `- venue: ${a.match.venue || "?"} (${a.match.venueKind || "?"})`, `- vol/num/pages: ${a.match.volume || "-"} / ${a.match.number || "-"} / ${a.match.pages || "-"}`, "");
    }
    const hasChanges = (a.additions && a.additions.length) || (e.raw.trim() !== a.rewritten);
    lines.push("**Original**", "```bibtex", e.raw.trim(), "```", "");
    if (hasChanges) {
      const note = a.additions && a.additions.length ? ` _(filled: ${a.additions.join(", ")})_` : "";
      lines.push(`**Suggested**${note}`, "```bibtex", a.rewritten, "```", "");
    } else {
      lines.push("_Suggested: no changes — original entry already complete._", "");
    }
  }
  return lines.join("\n");
}

function setupExports(audited) {
  $("#exports").classList.remove("hidden");
  $("#dlBib").onclick = () => { download("suggested.bib", buildBib(audited), "application/x-bibtex"); showToast("Downloading suggested.bib"); };
  $("#dlReport").onclick = () => { download("report.json", buildJson(audited), "application/json"); showToast("Downloading report.json"); };
  $("#dlMd").onclick = () => { download("report.md", buildMarkdown(audited), "text/markdown"); showToast("Downloading report.md"); };
  $("#copyAll").onclick = async () => {
    await navigator.clipboard.writeText(buildBib(audited));
    showToast("Copied all entries");
    const b = $("#copyAll"); const old = b.textContent;
    b.textContent = "Copied"; setTimeout(() => b.textContent = old, 1200);
  };
  $("#filters").classList.remove("hidden");
  applyFilters();
}

// ========== View filters ==========

function applyFilters() {
  const sev = (document.querySelector("input[name=sevFilter]:checked") || {}).value || "warnings";
  const hideClean = $("#hideClean").checked;
  const hideTrusted = $("#hideTrusted").checked;
  const collapseInfo = $("#collapseInfo").checked;
  const root = $("#results");
  // Toggle global class so CSS can hide info <li>s when collapseInfo is on.
  root.classList.toggle("collapse-info", collapseInfo);
  let shown = 0, total = 0;
  for (const el of root.querySelectorAll(".entry")) {
    total++;
    const errs = +el.dataset.errs || 0;
    const warns = +el.dataset.warns || 0;
    const trusted = el.dataset.trusted === "1";
    const isClean = errs === 0 && warns === 0;
    let visible = true;
    if (sev === "errors" && errs === 0) visible = false;
    else if (sev === "warnings" && errs === 0 && warns === 0) visible = false;
    if (visible && hideClean && isClean) visible = false;
    if (visible && hideTrusted && trusted) visible = false;
    el.classList.toggle("filtered", !visible);
    if (visible) shown++;
  }
  const cnt = $("#filterCount");
  if (cnt) cnt.textContent = `showing ${shown} / ${total}`;
}

// ========== Toast ==========

function showToast(message, duration = 2000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("#toastContainer").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ========== Init ==========

setupDragDrop();
setupKeyboard();
setupExpandCollapse();
restoreFromState();

function setupDragDrop() {
  const overlay = $("#dropOverlay");
  let dragCounter = 0;
  document.addEventListener("dragenter", e => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) overlay.classList.add("active");
  });
  document.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter === 0) overlay.classList.remove("active");
  });
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", async e => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove("active");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.name.endsWith(".bib") && !file.name.endsWith(".txt")) {
      showToast("Please drop a .bib or .txt file");
      return;
    }
    $("#bib").value = await file.text();
    showToast(`Loaded ${file.name}`);
  });
}

// ========== Keyboard shortcuts ==========

function setupKeyboard() {
  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      runAudit();
    }
    if (mod && e.shiftKey && e.key === "F") {
      e.preventDefault();
      $("#range").focus();
    }
    if (e.key === "Escape") {
      for (const el of document.querySelectorAll(".entry.open")) {
        el.classList.remove("open");
      }
    }
  });
}

// ========== Expand / collapse all ==========

function setupExpandCollapse() {
  $("#expandAll").addEventListener("click", () => {
    for (const el of document.querySelectorAll(".entry")) el.classList.add("open");
  });
  $("#collapseAll").addEventListener("click", () => {
    for (const el of document.querySelectorAll(".entry")) el.classList.remove("open");
  });
}

// ========== Click handler ==========

document.addEventListener("click", e => {
  const head = e.target.closest(".entry .head");
  if (head) {
    const entry = head.parentElement;
    entry.classList.toggle("open");
  }
  const btn = e.target.closest(".copy-btn");
  if (btn) {
    const pre = btn.closest(".section").querySelector("[data-suggested]");
    navigator.clipboard.writeText(pre.textContent);
    btn.textContent = "Copied"; setTimeout(() => btn.textContent = "Copy suggested", 1200);
    showToast("Copied to clipboard");
  }
});

// ========== Button wiring ==========

$("#run").addEventListener("click", runAudit);
$("#loadFile").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  $("#bib").value = await f.text();
  showToast(`Loaded ${f.name}`);
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
  showToast("Sample loaded");
});

// ========== Persistence ==========

let _bibSaveTimer = null;
$("#bib").addEventListener("input", () => {
  clearTimeout(_bibSaveTimer);
  _bibSaveTimer = setTimeout(() => {
    try {
      const prev = loadState() || {};
      prev.bib = $("#bib").value;
      prev.range = $("#range").value;
      localStorage.setItem(LS_KEY, JSON.stringify(prev));
    } catch {}
  }, 400);
});

$("#clearSaved").addEventListener("click", () => {
  if (!confirm("Clear saved bib input and audit results from this browser?")) return;
  clearState();
  $("#results").innerHTML = "";
  $("#summary").classList.add("hidden");
  $("#exports").classList.add("hidden");
  $("#filters").classList.add("hidden");
  setStatus("Saved state cleared.", 100);
});

// ========== Filter controls ==========

for (const r of document.querySelectorAll("input[name=sevFilter]")) {
  r.addEventListener("change", applyFilters);
}
for (const id of ["hideClean", "hideTrusted", "collapseInfo"]) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("change", applyFilters);
}

// (init moved above after function definitions)
