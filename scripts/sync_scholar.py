"""Refresh this site's public Google Scholar snapshot from its author's profile."""

import argparse
from datetime import datetime, timezone
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import sys
import time
from tempfile import NamedTemporaryFile
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from bs4 import BeautifulSoup
from protego import Protego


PROFILE_ID = "S4HPuI4AAAAJ"
ORIGIN = "https://scholar.google.com.hk"
PROFILE_URL = f"{ORIGIN}/citations?user={PROFILE_ID}&hl=en&pagesize=100&sortby=pubdate"
BOT = "ScholarHomepageSync"
OUTPUT = Path(__file__).resolve().parents[1] / "data" / "scholar.json"


class SyncError(ValueError):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SyncError(f"Scholar redirected the request (HTTP {code})", "redirect")


def fetch(url, stage):
    request = Request(url, headers={
        "User-Agent": f"{BOT}/1.0 (+https://supem.github.io/)",
        "Accept-Language": "en",
    })
    for attempt in range(3):
        try:
            with build_opener(NoRedirects).open(request, timeout=30) as response:
                return response.read().decode(response.headers.get_content_charset() or "utf-8")
        except HTTPError as error:
            error.close()
            # Access denials and rate limits wait for the next scheduled check.
            if error.code not in (408, 500, 502, 503, 504) or attempt == 2:
                raise SyncError(f"{stage} request failed (HTTP {error.code})",
                                f"http_{error.code}") from error
        except (URLError, TimeoutError, ConnectionError, HTTPException) as error:
            if attempt == 2:
                raise SyncError(f"{stage} request timed out or could not connect",
                                "network_error") from error
        delay = (5, 15)[attempt]
        print(f"Temporary {stage} request failure; retrying in {delay} seconds.", file=sys.stderr)
        time.sleep(delay)


def fetch_profile():
    rules = fetch(f"{ORIGIN}/robots.txt", "robots.txt")
    if not re.search(r"(?im)^\s*User-agent:", rules):
        raise ValueError("could not verify the origin's robots.txt")
    if not Protego.parse(rules).can_fetch(PROFILE_URL, BOT):
        raise SyncError("robots.txt disallows the profile request", "robots_disallowed")
    return fetch(PROFILE_URL, "profile")


def content(tag, field):
    if tag is None:
        raise ValueError(f"missing {field} in Scholar's profile")
    return " ".join(tag.stripped_strings)


def count(value):
    if not re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)", value):
        raise ValueError(f"invalid count {value!r}")
    return int(value.replace(",", ""))


def parse_profile(html):
    page = BeautifulSoup(html, "html.parser")
    if not content(page.select_one("#gsc_prf_in"), "author name"):
        raise ValueError("empty author name")

    headers = page.select("#gsc_rsb_st thead th")
    if len(headers) < 2 or headers[1].get_text(strip=True) != "All":
        raise ValueError("all-time metrics column is missing")
    labels = {"Citations": "citations", "h-index": "h_index", "i10-index": "i10_index"}
    metrics = {}
    for row in page.select("#gsc_rsb_st tbody tr"):
        label = content(row.select_one(".gsc_rsb_sc1"), "metric label")
        if label in labels:
            metrics[labels[label]] = count(content(row.select_one(".gsc_rsb_std"), label))
    if set(metrics) != set(labels.values()):
        raise ValueError("profile metrics are incomplete")

    rows = page.select("#gsc_a_b tr.gsc_a_tr")
    more = page.select_one("#gsc_bpf_more")
    if more is None or not more.has_attr("disabled"):
        raise ValueError("article list is incomplete; skipping paginated requests")
    article_range = content(page.select_one("#gsc_a_nn"), "article range")
    if not rows or not re.fullmatch(rf"Articles\s+1\s*[-–—]\s*{len(rows)}", article_range):
        raise ValueError(f"article range {article_range!r} does not match the visible rows")

    papers = []
    ids = set()
    for row in rows:
        title_link = row.select_one(".gsc_a_at")
        title = content(title_link, "title")
        query = parse_qs(urlsplit(title_link.get("href", "")).query)
        paper_id = query.get("citation_for_view", [""])[0]
        if (not title or query.get("user") != [PROFILE_ID] or paper_id in ids
                or not re.fullmatch(rf"{PROFILE_ID}:[\w-]+", paper_id)):
            raise ValueError("invalid or duplicate article identity")
        ids.add(paper_id)
        details = row.select(".gsc_a_t > .gs_gray")
        if len(details) != 2:
            raise ValueError(f"missing article metadata for {paper_id}")
        author, venue = details
        for year_suffix in venue.select(".gs_oph"):
            year_suffix.decompose()
        year = content(row.select_one(".gsc_a_y"), "publication year")
        if year and not re.fullmatch(r"[0-9]{4}", year):
            raise ValueError(f"invalid year for {paper_id}")
        cited = content(row.select_one(".gsc_a_ac"), "article citations").removesuffix("*").strip()
        permalink = urlencode({"view_op": "view_citation", "user": PROFILE_ID,
                               "citation_for_view": paper_id})
        papers.append({
            "id": paper_id, "title": title, "authors": content(author, "authors"),
            "venue": content(venue, "venue"), "year": int(year) if year else None,
            "citations": count(cited) if cited else 0, "url": f"{ORIGIN}/citations?{permalink}",
        })
    if metrics["h_index"] and not any(paper["citations"] for paper in papers):
        raise ValueError("all per-paper counts are zero despite a positive h-index")
    return {"profile_id": PROFILE_ID, "metrics": metrics, "papers": papers}


def matches_abbreviated_authors(prefix, full):
    short_names = [name.strip().split() for name in prefix.rstrip(" ,").split(",")]
    full_names = [name.strip().split() for name in full.split(",")]
    if len(short_names) > len(full_names):
        return False
    for short, name in zip(short_names, full_names):
        if not short or len(short) != len(name) or short[-1] != name[-1]:
            return False
        if not all(word.startswith(abbreviation) for abbreviation, word in zip(short, name)):
            return False
    return True


def reconcile(fresh, previous, allow_large_removal):
    if previous["profile_id"] != PROFILE_ID:
        raise ValueError("existing snapshot belongs to a different profile")
    old = {paper["id"]: paper for paper in previous["papers"]}
    removed = old.keys() - {paper["id"] for paper in fresh["papers"]}
    if (removed and not allow_large_removal
            and (removed == old.keys() or len(removed) > max(2, len(old) // 3))):
        raise ValueError("many existing article IDs disappeared; verify the live profile "
                         "and rerun with --allow-large-removal to accept the changes")
    for paper in fresh["papers"]:
        for key in ("title", "authors", "venue"):
            raw = paper[key]
            full = old.get(paper["id"], {}).get(key, "")
            if raw.endswith(("…", "...")) and not full.endswith(("…", "...")):
                prefix = " ".join(raw.rstrip(".…").split()).casefold()
                full_normalized = " ".join(full.split()).casefold()
                if prefix and (full_normalized.startswith(prefix)
                               or key == "authors" and matches_abbreviated_authors(prefix, full_normalized)):
                    paper[key] = full


def write_text(output, text):
    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=output.parent,
                            prefix=".scholar-", suffix=".tmp", delete=False) as tmp:
        temp_path = Path(tmp.name)
    try:
        temp_path.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temp_path, output)
    finally:
        temp_path.unlink(missing_ok=True)


def write_snapshot(output, snapshot):
    write_text(output, json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")


def render_page(source, snapshot):
    """Update the visible citation count and its snapshot metadata."""
    stamp = snapshot["updated_at"]
    page, count_matches = re.subn(r'(<span id="citation-total">)[^<]*(</span>)',
                                 lambda match: f'{match[1]}{snapshot["metrics"]["citations"]:,}{match[2]}',
                                 source)
    page, time_matches = re.subn(r'(<meta name="scholar-snapshot" content=")[^"]*("\s*/?>)',
                                lambda match: f'{match[1]}{stamp}{match[2]}', page)
    if count_matches != 1 or time_matches != 1:
        raise ValueError("expected one citation count and one scholar-snapshot meta tag")
    return page


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--status-output", type=Path,
                        help="sync health JSON; defaults to a sibling of --output")
    parser.add_argument("--update-page", type=Path,
                        help="also update the static page's citation count and timestamp")
    parser.add_argument("--allow-large-removal", action="store_true",
                        help="accept a manually verified large change in article IDs")
    args = parser.parse_args()
    health_path = args.status_output or args.output.with_name(args.output.stem + "-status.json")
    health = {"profile_id": PROFILE_ID, "last_attempt_at": utc_now(),
              "last_success_at": None, "status": "failure", "error_code": None}
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    if run_id.isdigit():
        health["run_url"] = f"https://github.com/supem/supem.github.io/actions/runs/{run_id}"
    try:
        old = None
        old_source = None
        if args.output.exists():
            old_source = args.output.read_text(encoding="utf-8")
            old = json.loads(old_source)
            health["last_success_at"] = old.get("updated_at")
        fresh = parse_profile(fetch_profile())
        if old is not None:
            reconcile(fresh, old, args.allow_large_removal)
        fresh["updated_at"] = utc_now()
        page = render_page(args.update_page.read_text(encoding="utf-8"), fresh) if args.update_page else None
        write_snapshot(args.output, fresh)
        try:
            if page is not None:
                write_text(args.update_page, page)
        except OSError:
            # Keep the published snapshot and its static fallback in step.
            if old_source is None:
                args.output.unlink(missing_ok=True)
            else:
                write_text(args.output, old_source)
            raise
        health["last_success_at"] = fresh["updated_at"]
        health.update(status="success", error_code=None, last_attempt_at=utc_now())
        write_snapshot(health_path, health)
    except (OSError, ValueError, KeyError, TypeError) as error:
        health.update(status="failure", last_attempt_at=utc_now(), error_code=getattr(error, "code",
                      "storage_error" if isinstance(error, OSError) else "validation_error"))
        try:
            write_snapshot(health_path, health)
        except OSError as status_error:
            print(f"Could not save sync status: {status_error}", file=sys.stderr)
        print(f"Scholar sync failed: {error}. Last verified snapshot retained.", file=sys.stderr)
        return 1
    print(f"Updated {len(fresh['papers'])} papers and {fresh['metrics']['citations']} all-time citations.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
