(() => {
  const profileId = "S4HPuI4AAAAJ";
  const day = 24 * 60 * 60 * 1000;
  const urls = ["./data/scholar.json"];
  if (location.hostname === "supem.github.io") {
    urls.push("https://raw.githubusercontent.com/supem/supem.github.io/main/data/scholar.json");
  }

  const byId = (id) => document.getElementById(id);
  const time = byId("sync-time");
  const status = byId("sync-status");
  const shanghaiTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const number = new Intl.NumberFormat("en-US");
  let lastCheck = 0;
  let checking = false;
  let lastRendered = "";

  function showStatus(unavailable = false) {
    const age = Date.now() - Date.parse(time.dateTime);
    if (age > 3 * day) {
      status.textContent = "The last successful sync was more than three days ago. Google Scholar may have newer records.";
    } else if (unavailable) {
      status.textContent = "Could not check for updates. Showing the last saved snapshot.";
    } else {
      status.textContent = "";
    }
  }

  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  function validSnapshot(data) {
    return data?.profile_id === profileId && typeof data.updated_at === "string"
      && Number.isFinite(Date.parse(data.updated_at))
      && ["citations", "h_index", "i10_index"].every((key) => isCount(data.metrics?.[key]))
      && Array.isArray(data.papers) && data.papers.length > 0
      && data.papers.every((p) => p && typeof p.id === "string" && p.id.startsWith(profileId + ":")
        && typeof p.title === "string" && p.title.trim() && typeof p.authors === "string"
        && typeof p.venue === "string" && (p.year === null || Number.isInteger(p.year))
        && isCount(p.citations));
  }

  async function readSnapshot(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("Snapshot unavailable");
      const data = await response.json();
      if (!validSnapshot(data)) throw new Error("Invalid snapshot");
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Restrict links to HTTPS. If the supplied URL is missing or unsafe, construct
  // a Google Scholar record link from the qualified publication ID instead.
  function recordUrl(paper) {
    try {
      const url = new URL(paper.url);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch { /* Use the Scholar record below. */ }
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

  function paperArticle(paper) {
    const article = element("article", "paper");
    const info = element("div");
    const title = element("h3");
    const link = element("a", "", paper.title);
    link.href = recordUrl(paper);
    title.append(link);
    info.append(title, element("p", "authors", paper.authors),
      element("p", "venue", paper.venue),
      element("p", "paper-cites", number.format(paper.citations) + (paper.citations === 1 ? " citation" : " citations")));
    article.append(element("span", "paper-year", paper.year ?? "—"), info);
    return article;
  }

  function render(data) {
    const papers = [...data.papers].sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    const cards = papers.map(paperArticle);
    byId("recent-papers").replaceChildren(...cards.slice(0, 5));
    byId("more-papers").replaceChildren(...cards.slice(5));
    const remaining = Math.max(0, cards.length - 5);
    byId("more-label").textContent = "More publications (" + number.format(remaining) + ")";
    byId("more-records").hidden = !remaining;
    byId("citation-total").textContent = number.format(data.metrics.citations);
    byId("h-index").textContent = number.format(data.metrics.h_index);
    byId("i10-index").textContent = number.format(data.metrics.i10_index);
    time.dateTime = data.updated_at;
    time.textContent = shanghaiTime.format(new Date(data.updated_at)) + " (Asia/Shanghai, UTC+8)";
  }

  async function refresh() {
    if (checking || Date.now() - lastCheck < 60 * 60 * 1000) return;
    checking = true;
    lastCheck = Date.now();
    try {
      const results = await Promise.allSettled(urls.map(readSnapshot));
      const snapshots = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      snapshots.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      const latest = snapshots[0];
      const shown = Date.parse(time.dateTime);
      if (latest && lastRendered !== latest.updated_at &&
          (!Number.isFinite(shown) || Date.parse(latest.updated_at) >= shown)) {
        render(latest);
        lastRendered = latest.updated_at;
      }
      showStatus(!latest);
    } finally {
      checking = false;
    }
  }

  if (!time || !status) return;
  showStatus();
  refresh();
  window.addEventListener("focus", refresh);
})();
