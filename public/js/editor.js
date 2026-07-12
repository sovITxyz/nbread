// NIP-07 editor glue: build a kind 30023 (long-form post) or kind 5 (delete)
// event, sign it with the user's extension (window.nostr), broadcast it to
// the user's relays client-side (best-effort), and POST the signed event to
// /api/mirror so the blog updates immediately. The key never leaves the
// extension; the server only ever sees signed events.
(function () {
  "use strict";

  var cfgEl = document.getElementById("editor-config");
  var form = document.getElementById("editor-form");
  if (!cfgEl || !form) return;

  var cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
  } catch (e) {
    return;
  }

  var titleEl = document.getElementById("post-title");
  var slugEl = document.getElementById("post-slug");
  var summaryEl = document.getElementById("post-summary");
  var contentEl = document.getElementById("post-content");
  var statusEl = document.getElementById("editor-status");
  var previewSection = document.getElementById("preview");
  var previewBody = document.getElementById("preview-body");
  var previewBtn = document.getElementById("preview-button");
  var publishBtn = document.getElementById("publish-button");
  var deleteBtn = document.getElementById("delete-button");

  function say(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function hasNostr() {
    if (window.nostr && typeof window.nostr.signEvent === "function") {
      return true;
    }
    say(
      "No NIP-07 extension found. Install Alby or nos2x, then reload this page.",
    );
    return false;
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  // An edit must WIN the replaceable slot: created_at strictly greater than
  // the stored version's (equal timestamps tie-break on id and can lose).
  function nextCreatedAt() {
    var prev = typeof cfg.prevCreatedAt === "number" ? cfg.prevCreatedAt : 0;
    return Math.max(nowSeconds(), prev + 1);
  }

  // Mirrors the server's heading-slug shape (ASCII, hyphens, max 64).
  function slugify(text) {
    var s = String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    return s || "post-" + nowSeconds();
  }

  // Best-effort broadcast: publish the signed event to every configured
  // relay, tolerating dead relays. Resolves once every attempt has finished
  // (OK, error, or per-relay timeout) — never rejects.
  function broadcast(event) {
    var relays = Array.isArray(cfg.relays) ? cfg.relays : [];
    var message = JSON.stringify(["EVENT", event]);
    var attempts = relays.map(function (url) {
      return new Promise(function (resolve) {
        var ws = null;
        var done = false;
        var timer = null;
        function finish() {
          if (done) return;
          done = true;
          if (timer !== null) clearTimeout(timer);
          try {
            if (ws) ws.close();
          } catch (e) {
            /* already closed */
          }
          resolve();
        }
        try {
          ws = new WebSocket(url);
        } catch (e) {
          resolve();
          return;
        }
        timer = setTimeout(finish, 3000);
        ws.onopen = function () {
          try {
            ws.send(message);
          } catch (e) {
            finish();
          }
        };
        ws.onmessage = finish; // relay replied (["OK", ...]) — done
        ws.onerror = finish;
        ws.onclose = finish;
      });
    });
    return Promise.all(attempts);
  }

  // POST the signed event to the server mirror (the authoritative copy the
  // blog renders from). Throws with the server's error message on rejection.
  async function postMirror(event) {
    var res = await fetch("/api/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    var data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* non-JSON error body */
    }
    if (!res.ok) {
      throw new Error(data.error || data.result || "mirror failed (" + res.status + ")");
    }
    return data.result;
  }

  async function signMirrorBroadcast(unsigned, progress) {
    say("Waiting for your signature…");
    var signed = await window.nostr.signEvent(unsigned);
    say(progress);
    var result = await postMirror(signed);
    if (result !== "stored") {
      throw new Error("unexpected mirror result: " + result);
    }
    say("Broadcasting to your relays…");
    await broadcast(signed);
  }

  // Publish goes through the button, never a native form submit.
  form.addEventListener("submit", function (e) {
    e.preventDefault();
  });

  if (publishBtn) {
    publishBtn.addEventListener("click", async function () {
      publishBtn.disabled = true;
      try {
        if (!hasNostr()) return;
        var title = (titleEl && titleEl.value ? titleEl.value : "").trim();
        var content = contentEl && contentEl.value ? contentEl.value : "";
        if (!title) {
          say("A title is required.");
          return;
        }
        if (!content.trim()) {
          say("Write something first.");
          return;
        }
        var slug =
          cfg.mode === "edit"
            ? cfg.slug
            : slugify((slugEl && slugEl.value.trim()) || title);
        var createdAt = nextCreatedAt();
        // First publication time survives edits (NIP-23 published_at).
        var publishedAt =
          typeof cfg.publishedAt === "number" && cfg.publishedAt > 0
            ? cfg.publishedAt
            : createdAt;
        var tags = [
          ["d", slug],
          ["title", title],
          ["published_at", String(publishedAt)],
        ];
        var summary = (summaryEl && summaryEl.value ? summaryEl.value : "").trim();
        if (summary) tags.push(["summary", summary]);

        await signMirrorBroadcast(
          {
            kind: 30023,
            created_at: createdAt,
            tags: tags,
            content: content,
          },
          "Publishing to Nostrbook…",
        );
        window.location.href = "/dashboard";
        return;
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        publishBtn.disabled = false;
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", async function () {
      if (
        !window.confirm(
          "Delete this post? A signed deletion event (kind 5) will be published to your relays and the post will disappear from your blog.",
        )
      ) {
        return;
      }
      deleteBtn.disabled = true;
      try {
        if (!hasNostr()) return;
        var tags = [];
        if (typeof cfg.eventId === "string" && cfg.eventId) {
          tags.push(["e", cfg.eventId]);
        }
        tags.push(["a", "30023:" + cfg.pubkey + ":" + cfg.slug]);

        await signMirrorBroadcast(
          {
            kind: 5,
            created_at: nextCreatedAt(),
            tags: tags,
            content: "Deleted via Nostrbook",
          },
          "Deleting…",
        );
        window.location.href = "/dashboard";
        return;
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        deleteBtn.disabled = false;
      }
    });
  }

  if (previewBtn) {
    previewBtn.addEventListener("click", async function () {
      previewBtn.disabled = true;
      try {
        say("Rendering preview…");
        var res = await fetch("/dashboard/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            markdown: contentEl && contentEl.value ? contentEl.value : "",
          }),
        });
        if (!res.ok) {
          throw new Error("preview failed (" + res.status + ")");
        }
        // Server-sanitized HTML from the exact publish pipeline — what you
        // see here is byte-identical to what readers will get.
        var html = await res.text();
        if (previewBody) previewBody.innerHTML = html;
        if (previewSection) previewSection.hidden = false;
        say("");
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        previewBtn.disabled = false;
      }
    });
  }
})();
