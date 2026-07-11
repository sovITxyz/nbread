// NIP-07 login glue: fetch a one-time challenge, sign a kind 22242 event
// with the user's extension (window.nostr), POST it to /login. The key
// never leaves the extension; the server only ever sees a signed event.
(function () {
  "use strict";

  var button = document.getElementById("login-button");
  var status = document.getElementById("login-status");
  if (!button) return;

  function say(message) {
    if (status) status.textContent = message;
  }

  button.addEventListener("click", async function () {
    button.disabled = true;
    try {
      if (
        !window.nostr ||
        typeof window.nostr.getPublicKey !== "function" ||
        typeof window.nostr.signEvent !== "function"
      ) {
        say(
          "No NIP-07 extension found. Install Alby or nos2x, then reload this page.",
        );
        return;
      }

      say("Requesting challenge…");
      var challengeRes = await fetch("/login/challenge");
      if (!challengeRes.ok) {
        throw new Error("Could not get a challenge (" + challengeRes.status + ")");
      }
      var challenge = (await challengeRes.json()).challenge;

      // Prompts the extension's connect dialog before the signing dialog,
      // so the user understands which identity they are signing in with.
      await window.nostr.getPublicKey();

      say("Waiting for your signature…");
      var signed = await window.nostr.signEvent({
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          // Binds the signature to THIS service: the server refuses events
          // whose relay tag names any other host, so a signature phished
          // through a third-party site's login flow is useless here — and
          // the tag surfaces the destination in the extension's prompt.
          ["relay", "wss://" + location.host],
          ["challenge", challenge],
        ],
        // Human-readable statement of intent for the signing prompt
        // (transparency only — the relay tag is what the server enforces).
        content: "Log in to " + location.host,
      });

      say("Signing in…");
      var loginRes = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      if (!loginRes.ok) {
        var err = {};
        try {
          err = await loginRes.json();
        } catch (_) {
          /* non-JSON error body */
        }
        throw new Error(err.error || "Login failed (" + loginRes.status + ")");
      }
      window.location.href = "/dashboard";
      return;
    } catch (e) {
      say(String((e && e.message) || e));
    } finally {
      button.disabled = false;
    }
  });
})();
