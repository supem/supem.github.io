(() => {
  const profileId = "S4HPuI4AAAAJ";
  const urls = ["./data/scholar.json"];
  if (location.hostname === "supem.github.io") {
    urls.push("https://raw.githubusercontent.com/supem/supem.github.io/main/data/scholar.json");
  }
  const byId = (id) => document.getElementById(id);
  const snapshotMeta = document.querySelector('meta[name="scholar-snapshot"]');
  const publicationList = byId("publication-list");
  const publicationTools = byId("publication-tools");
  const paperSearch = byId("paper-search");
  const paperYear = byId("paper-year");
  const paperCount = byId("paper-count");
  const paperEmpty = byId("paper-empty");
  const paperReset = byId("paper-reset");
  const number = new Intl.NumberFormat("en-US");
  let lastCheck = 0;
  let checking = false;
  let lastRendered = "";
  let journalCatalog = null;
  let publicationGroups = [];
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

  function applyFilters() {
    const tokens = normalizeName(paperSearch.value).split(" ").filter(Boolean);
    const filtered = tokens.length > 0 || paperYear.value !== "";
    let total = 0;
    let matches = 0;
    for (const group of publicationGroups) {
      let groupMatches = 0;
      for (const paper of group.papers) {
        const matchesYear = !paperYear.value || paperYear.value === group.year;
        const matchesSearch = tokens.every((token) => paper.searchText.includes(token));
        paper.article.hidden = !(matchesYear && matchesSearch);
        if (!paper.article.hidden) groupMatches += 1;
      }
      group.section.hidden = groupMatches === 0;
      total += group.papers.length;
      matches += groupMatches;
    }
    paperCount.textContent = filtered
      ? number.format(matches) + " of " + number.format(total) + " publications"
      : number.format(total) + (total === 1 ? " publication" : " publications");
    paperEmpty.hidden = matches > 0;
    paperReset.hidden = !filtered;
  }

  function indexPublications() {
    const selectedYear = paperYear.value;
    publicationGroups = [...publicationList.querySelectorAll(".year-group")].map((section) => ({
      section,
      year: section.querySelector(".year-label").textContent.trim(),
      papers: [...section.querySelectorAll(".paper")].map((article) => ({
        article,
        searchText: normalizeName([...article.querySelectorAll("h4, .authors, .venue")]
          .map((part) => part.textContent).join(" "))
      }))
    }));
    const allYears = element("option", "", "All years");
    allYears.value = "";
    const years = [...new Set(publicationGroups.map((group) => group.year))];
    const options = years.map((year) => {
      const option = element("option", "", year);
      option.value = year;
      return option;
    });
    paperYear.replaceChildren(allYears, ...options);
    if (years.includes(selectedYear)) paperYear.value = selectedYear;
    applyFilters();
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
    links.forEach((link, index) => {
      if (index > 0) group.append(" · ");
      group.append(link);
    });
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
    indexPublications();
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
    if (papersByYear.has(null)) years.push(null);
    const publications = document.createDocumentFragment();
    for (const year of years) {
      const papers = papersByYear.get(year);
      const section = element("section", "year-group");
      const entries = element("div", "year-papers");
      entries.append(...papers.map(paperArticle));
      section.append(element("h3", "year-label", year ?? "Undated"), entries);
      publications.append(section);
    }
    publicationList.replaceChildren(publications);
    byId("citation-total").textContent = number.format(data.metrics.citations);
    snapshotMeta.content = data.updated_at;
    indexPublications();
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

  if (!snapshotMeta || !publicationList || !publicationTools || !paperSearch || !paperYear
      || !paperCount || !paperEmpty || !paperReset) return;
  for (const group of document.querySelectorAll(".paper .venue .journal-metrics")) {
    staticMetrics.set(normalizeName(readVenue(group.parentElement)), group.cloneNode(true));
  }
  indexPublications();
  publicationTools.hidden = false;
  paperSearch.addEventListener("input", applyFilters);
  paperYear.addEventListener("change", applyFilters);
  paperReset.addEventListener("click", () => {
    paperSearch.value = "";
    paperYear.value = "";
    applyFilters();
    paperSearch.focus();
  });
  refresh();
  window.addEventListener("focus", refresh);
})();
