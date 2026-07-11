import { Layout } from "../layout";

/** Landing page (P0 stub — product pitch + login CTA arrive in P6). */
export function MainHome() {
  return (
    <Layout title="Nostrbook">
      <main>
        <h1>Nostrbook</h1>
        <p>
          Nostr-native blogging. Your posts are NIP-23 events signed by your
          key — we just render them beautifully at{" "}
          <code>you.nostrbook.net</code>.
        </p>
      </main>
    </Layout>
  );
}
