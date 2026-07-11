import { Layout } from "../layout";
import type { User } from "../../services/users";

/** Blog home (P0 stub — the real post list arrives in P2/P3). */
export function BlogHome(props: { user: User }) {
  const handle = props.user.handle ?? "";
  return (
    <Layout title={`@${handle} — Nostrbook`}>
      <main>
        <h1>@{handle}</h1>
        <p>This blog is powered by Nostr. Posts arrive in a later phase.</p>
      </main>
    </Layout>
  );
}
