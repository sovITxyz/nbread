import { Layout } from "../layout";

/** Landing page: product pitch + login CTA (P6 polish). */
export function MainHome() {
  return (
    <Layout title="Nostrbook — Nostr-native blogging">
      <main class="landing">
        <h1>Nostrbook</h1>
        <p class="tagline">
          Nostr-native blogging. Your posts are NIP-23 events signed by your
          key — we just render them beautifully at{" "}
          <code>you.nostrbook.net</code>.
        </p>
        <p class="landing-cta">
          <a class="cta-button" href="/login">
            Sign in with Nostr
          </a>{" "}
          <a class="cta-secondary" href="/discover">
            Discover blogs
          </a>
        </p>

        <section class="landing-pitch">
          <h2>Your keys, your words</h2>
          <p>
            Every post is a signed Nostr event living on public relays.
            Nostrbook mirrors and renders them — it never owns them. Leave
            any time and take everything with you; no export button needed.
          </p>

          <h2>A real blog, not a feed</h2>
          <p>
            Claim a handle and get a clean site at{" "}
            <code>handle.nostrbook.net</code> with RSS and Atom feeds, a
            sitemap, your own theme CSS, and a{" "}
            <code>handle@nostrbook.net</code> NIP-05 identifier.
          </p>

          <h2>Write anywhere</h2>
          <p>
            Use the built-in markdown editor with NIP-07 signing, or publish
            long-form posts from any Nostr client — Nostrbook keeps your blog
            in sync with the relays either way.
          </p>
        </section>

        <p class="landing-links">
          <a href="/discover">Discover recent posts</a> ·{" "}
          <a href="/search">Search posts</a> · <a href="/login">Sign in</a>
        </p>
      </main>
    </Layout>
  );
}
