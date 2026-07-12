import { Layout } from "../layout";
import { FeedList, type FeedItem } from "./feed";

/**
 * Discover page: recent posts by claimed, non-blocked users across all
 * blogs, paginated. Items come pre-scoped from listRecentClaimedPosts;
 * every string renders through hono/jsx auto-escaping.
 */
export function DiscoverPage(props: {
  items: FeedItem[];
  page: number;
  hasNext: boolean;
  mainHost: string;
}) {
  return (
    <Layout title="Discover — Nostrbook">
      <main class="discover">
        <p class="site-nav">
          <a href="/">Nostrbook</a> · <a href="/search">Search</a>
        </p>
        <h1>Discover</h1>
        <p class="page-intro">
          Recent posts from blogs on {props.mainHost}.
        </p>
        {props.items.length === 0 ? (
          <p class="empty">No posts here yet.</p>
        ) : (
          <FeedList items={props.items} />
        )}
        {props.page > 1 || props.hasNext ? (
          <nav class="pager" aria-label="Pagination">
            {props.page > 1 ? (
              <a rel="prev" href={`/discover?page=${props.page - 1}`}>
                ← Newer
              </a>
            ) : null}
            {props.hasNext ? (
              <a rel="next" href={`/discover?page=${props.page + 1}`}>
                Older →
              </a>
            ) : null}
          </nav>
        ) : null}
      </main>
    </Layout>
  );
}
