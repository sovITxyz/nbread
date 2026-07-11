import { Layout } from "../layout";

/**
 * Login page: NIP-07 challenge-response. All logic lives in /js/login.js
 * (fetch challenge → window.nostr.signEvent kind 22242 → POST /login).
 */
export function LoginPage() {
  return (
    <Layout title="Sign in — Nostrbook">
      <main>
        <h1>Sign in</h1>
        <p>
          Sign in with your Nostr key. You need a{" "}
          <a
            href="https://github.com/nostr-protocol/nips/blob/master/07.md"
            rel="noopener noreferrer"
          >
            NIP-07 browser extension
          </a>{" "}
          (Alby, nos2x, …) — your key never leaves it; you only sign a
          one-time login challenge.
        </p>
        <button id="login-button" type="button">
          Sign in with Nostr
        </button>
        <p id="login-status" role="status" aria-live="polite"></p>
        <script src="/js/login.js"></script>
      </main>
    </Layout>
  );
}
