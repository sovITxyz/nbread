import { Layout } from "../layout";

/**
 * Minimal authed dashboard shell (P4): shows the signed-in npub and either
 * the claimed handle or the claim form (with Turnstile). Post list, settings
 * and the editor arrive in P5.
 *
 * All dynamic strings render through hono/jsx auto-escaping.
 */
export function DashboardPage(props: {
  npub: string;
  handle: string | null;
  mainHost: string;
  turnstileSiteKey: string;
  error: string | null;
}) {
  return (
    <Layout title="Dashboard — Nostrbook">
      <main>
        <h1>Dashboard</h1>
        <p class="dashboard-npub">
          Signed in as <code>{props.npub}</code>
        </p>

        {props.error ? (
          <p class="claim-error" role="alert">
            {props.error}
          </p>
        ) : null}

        {props.handle ? (
          <section class="dashboard-handle">
            <h2>Your blog</h2>
            <p>
              <a href={`https://${props.handle}.${props.mainHost}/`}>
                {props.handle}.{props.mainHost}
              </a>
            </p>
            <p>
              Your NIP-05 identifier:{" "}
              <code>
                {props.handle}@{props.mainHost}
              </code>
            </p>
          </section>
        ) : (
          <section class="dashboard-claim">
            <h2>Claim your handle</h2>
            <p>
              Pick the subdomain your blog will live at. One handle per key —
              choose carefully.
            </p>
            <form method="post" action="/dashboard/claim">
              <label>
                Handle{" "}
                <input
                  name="handle"
                  type="text"
                  required
                  minlength={2}
                  maxlength={31}
                  pattern="[a-z0-9][a-z0-9\-]{1,30}"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="yourname"
                />
              </label>
              <span class="claim-suffix">.{props.mainHost}</span>
              <div
                class="cf-turnstile"
                data-sitekey={props.turnstileSiteKey}
              ></div>
              <button type="submit">Claim</button>
            </form>
            <script
              src="https://challenges.cloudflare.com/turnstile/v0/api.js"
              async
              defer
            ></script>
          </section>
        )}

        <form method="post" action="/logout" class="logout-form">
          <button type="submit">Sign out</button>
        </form>
      </main>
    </Layout>
  );
}
