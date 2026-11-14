(() => {
  const profileId = "S4HPuI4AAAAJ";
  const urls = ["./data/scholar.json"];
  if (location.hostname === "supem.github.io") {
    urls.push("https://raw.githubusercontent.com/supem/supem.github.io/main/data/scholar.json");
  }
  const byId = (id) => document.getElementById(id);
  const snapshotMeta = document.querySelector('meta[name="scholar-snapshot"]');
  const number = new Intl.NumberFormat("en-US");
  let lastCheck = 0;
  let checking = false;
  let lastRendered = "";
  let journalCatalog = null;
  const staticMetrics = new Map();

  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  function validSnapshot(data) {
    return data?.profile_id === profileId && typeof data.updated_at === "string"
      && Number.isFinite(Date.parse(data.updated_at))
      && isCount(data.metrics?.citations)
      && Array.isArray(data.papers) && data.papers.length > 0
      && data.papers.every((p) => p && typeof p.id === "string" && p.id.startsWith(profileId + ":")
        && typeof p.title === "string" && p.title.trim() && typeof p.authors === "string"
        && typeof p.venue === "string" && (p.year === null || Number.isInteger(p.year)));
  }

  async function readJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("Data unavailable");
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function httpsUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch { /* Invalid or relative URL. */ }
    return null;
  }

  function recordUrl(paper) {
    const supplied = httpsUrl(paper.url);
    if (supplied) return supplied;
    const url = new URL("https://scholar.google.com/citations");
    url.searchParams.set("view_op", "view_citation");
    url.searchParams.set("user", profileId);
    url.searchParams.set("citation_for_view", paper.id);
    return url.href;
  }

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function externalLink(label, url) {
    const link = element("a", "", label);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }

  function normalizeName(value) {
    return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function journalFor(venue) {
    const name = normalizeName(venue);
    return journalCatalog.find(({key}) => name === key || (name.startsWith(key)
      && /^(?:[\s,:;]+(?:(?:vol(?:ume)?\.?|issue|no\.?|pp?\.?)\s*)?|\s*\()\d+(?=$|[\s(),.:;–-])/.test(name.slice(key.length))))?.journal;
  }

  function metricLink(metric, label, description) {
    const href = httpsUrl(metric?.url);
    if (!href || !Number.isInteger(metric.year)) return null;
    const link = externalLink(label, href);
    link.title = description;
    link.setAttribute("aria-label", description);
    return link;
  }

  function metricsFor(venue) {
    if (!journalCatalog) return staticMetrics.get(normalizeName(venue))?.cloneNode(true);
    const journal = journalFor(venue);
    if (!journal) return null;
    const {jcr, jif, ccf} = journal;
    const impact = jif?.value && metricLink(jif, `IF ${jif.value} (${jif.year})`,
      `Journal Impact Factor ${jif.value} for ${jif.year}`);
    const quartile = jcr && /^Q[1-4]$/.test(jcr.quartile) && metricLink(jcr,
      `JCR ${jcr.quartile}` + (impact && jif.year === jcr.year ? "" : ` (${jcr.year})`),
      `JCR ${jcr.quartile} for ${jcr.year}` + (jcr.category ? ` in ${jcr.category}` : " (category not specified in the source)"));
    const rank = ccf?.category && /^[ABC]$/.test(ccf.rank) && metricLink(ccf,
      `CCF ${ccf.rank} (${ccf.year})`, `CCF ${ccf.rank} in ${ccf.category} for ${ccf.year}`);
    const links = [quartile, impact, rank].filter(Boolean);
    if (!links.length) return null;
    const group = element("span", "journal-metrics");
    for (const link of links) group.append(" · ", link);
    return group;
  }

  function readVenue(para) {
    const copy = para.cloneNode(true);
    copy.querySelector(".journal-metrics")?.remove();
    return copy.textContent.replace(/\s*·\s*$/, "").trim();
  }

  function annotateVenue(para, venue) {
    para.replaceChildren(venue);
    const group = metricsFor(venue);
    if (group) para.append(group);
  }

  async function refreshJournalCatalog() {
    try {
      const data = await readJson("./data/journal-metrics.json");
      if (!Array.isArray(data.journals)) return;
      journalCatalog = data.journals.flatMap((journal) =>
        [journal.name, ...(journal.aliases || [])].filter((name) => typeof name === "string" && name.trim())
          .map((name) => ({key: normalizeName(name), journal})))
        .sort((a, b) => b.key.length - a.key.length);
    } catch {
      return; // Keep existing annotations if the independent catalog is offline.
    }
    for (const para of document.querySelectorAll(".paper .venue")) annotateVenue(para, readVenue(para));
  }

  function paperArticle(paper) {
    const article = element("article", "paper");
    const title = element("h4");
    title.append(externalLink(paper.title, recordUrl(paper)));
    article.append(title);
    if (paper.authors) {
      const authors = element("p", "authors");
      paper.authors.split(",").forEach((part, index) => {
        const author = part.trim();
        if (index > 0) authors.append(", ");
        authors.append(/^(?:C|Chao) Mao$/i.test(author) ? element("strong", "", author) : author);
      });
      article.append(authors);
    }
    if (paper.venue) {
      const venue = element("p", "venue");
      annotateVenue(venue, paper.venue);
      article.append(venue);
    }
    return article;
  }

  function render(data) {
    const papersByYear = new Map();
    for (const paper of data.papers) {
      if (!papersByYear.has(paper.year)) papersByYear.set(paper.year, []);
      papersByYear.get(paper.year).push(paper);
    }
    const years = [...papersByYear.keys()].filter((year) => year !== null).sort((a, b) => b - a);
    const visibleYears = new Set(years.length ? years.slice(0, 2) : [null]);
    if (papersByYear.has(null)) years.push(null);
    const recent = document.createDocumentFragment();
    const earlier = document.createDocumentFragment();
    let remaining = 0;
    for (const year of years) {
      const papers = papersByYear.get(year);
      const section = element("section", "year-group");
      const entries = element("div", "year-papers");
      entries.append(...papers.map(paperArticle));
      section.append(element("h3", "year-label", year ?? "Undated"), entries);
      if (visibleYears.has(year)) {
        recent.append(section);
      } else {
        earlier.append(section);
        remaining += papers.length;
      }
    }
    byId("recent-papers").replaceChildren(recent);
    byId("more-papers").replaceChildren(earlier);
    byId("more-label").textContent = "Earlier publications (" + number.format(remaining) + ")";
    byId("more-records").hidden = !remaining;
    byId("citation-total").textContent = number.format(data.metrics.citations);
    snapshotMeta.content = data.updated_at;
  }

  async function refresh() {
    if (checking || Date.now() - lastCheck < 60 * 60 * 1000) return;
    checking = true;
    lastCheck = Date.now();
    refreshJournalCatalog();
    try {
      await Promise.allSettled(urls.map(async (url) => {
        const data = await readJson(url);
        if (!validSnapshot(data)) return;
        const shown = Date.parse(snapshotMeta.content);
        if (lastRendered !== data.updated_at && (!Number.isFinite(shown) || Date.parse(data.updated_at) >= shown)) {
          render(data);
          lastRendered = data.updated_at;
        }
      }));
    } finally {
      checking = false;
    }
  }

  if (!snapshotMeta) return;
  for (const group of document.querySelectorAll(".paper .venue .journal-metrics")) {
    staticMetrics.set(normalizeName(readVenue(group.parentElement)), group.cloneNode(true));
  }
  refresh();
  window.addEventListener("focus", refresh);
})();
