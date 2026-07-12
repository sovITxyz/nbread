import { rowToEvent, type FeedRow } from "../../services/events";
import { postMeta, isoDate } from "../../markdown/nip23";

/**
 * One cross-tenant feed entry (discover / search result). All text fields
 * are relay-derived and UNTRUSTED: they must only ever render through
 * hono/jsx text/attribute children (auto-escaped), never raw(). Titles and
 * summaries come straight from tag strings via postMeta — no markdown
 * rendering happens on this path (render-at-ingest contract).
 */
export type FeedItem = {
  title: string;
  summary: string | null;
  /** YYYY-MM-DD (from the published_at tag, falling back to created_at). */
  date: string;
  /** The author's claimed handle, lowercased. */
  handle: string;
  /** Absolute URL of the post on its blog subdomain. */
  url: string;
  /** Absolute URL of the author's blog home. */
  blogUrl: string;
};

/** Map joined event rows to renderable feed items. */
export function feedItems(rows: FeedRow[], mainHost: string): FeedItem[] {
  return rows.map((row) => {
    const meta = postMeta(rowToEvent(row));
    const handle = row.handle.toLowerCase();
    const blogUrl = `https://${handle}.${mainHost}/`;
    return {
      title: meta.title,
      summary: meta.summary,
      date: isoDate(meta.published_at),
      handle,
      // A d-tagless post has no addressable post URL (BlogHome drops such
      // posts from its own list for the same reason); in a cross-tenant feed
      // linking to the blog home keeps page sizes stable instead of
      // silently shrinking pages.
      url:
        meta.slug === ""
          ? blogUrl
          : `${blogUrl}${encodeURIComponent(meta.slug)}`,
      blogUrl,
    };
  });
}

/** Post list shared by the discover page and search results. */
export function FeedList(props: { items: FeedItem[] }) {
  return (
    <ul class="post-list feed-list">
      {props.items.map((item) => (
        <li class="post-item">
          <a class="post-link" href={item.url}>
            {item.title}
          </a>{" "}
          <span class="post-author">
            by <a href={item.blogUrl}>@{item.handle}</a>
          </span>{" "}
          <time class="post-date" datetime={item.date}>
            {item.date}
          </time>
          {item.summary ? <p class="post-summary">{item.summary}</p> : null}
        </li>
      ))}
    </ul>
  );
}
