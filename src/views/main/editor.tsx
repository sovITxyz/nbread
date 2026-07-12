import { Layout } from "../layout";

/**
 * Editor page (new post / edit existing). All signing happens client-side in
 * public/js/editor.js via the user's NIP-07 extension; this page only ships
 * the form plus a JSON config blob the script reads.
 *
 * XSS notes: every field value renders through hono/jsx auto-escaping (post
 * titles/summaries/content are relay-sourced and hostile by assumption). The
 * config JSON is embedded in a non-executable script tag with every `<`
 * escaped to < so a crafted d-tag/relay URL can never break out with
 * `</script>`.
 */
export function EditorPage(props: {
  mode: "new" | "edit";
  slug: string; // "" for new posts
  title: string;
  summary: string;
  content: string;
  publishedAt: number | null; // original publication time, preserved on edit
  prevCreatedAt: number | null; // stored version's created_at (edit must exceed it)
  eventId: string | null; // stored event id (delete e-tags it)
  pubkey: string;
  relays: string[];
  handle: string | null;
  mainHost: string;
}) {
  const config = {
    mode: props.mode,
    slug: props.slug,
    publishedAt: props.publishedAt,
    prevCreatedAt: props.prevCreatedAt,
    eventId: props.eventId,
    pubkey: props.pubkey,
    relays: props.relays,
  };
  const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
  const isEdit = props.mode === "edit";

  return (
    <Layout title={isEdit ? "Edit post — Nostrbook" : "New post — Nostrbook"}>
      <main>
        <h1>{isEdit ? "Edit post" : "New post"}</h1>
        <p>
          <a href="/dashboard">&larr; Dashboard</a>
          {isEdit && props.handle && props.slug !== "" ? (
            <>
              {" · "}
              <a
                href={`https://${props.handle}.${props.mainHost}/${encodeURIComponent(props.slug)}`}
              >
                View published
              </a>
            </>
          ) : null}
        </p>

        <form id="editor-form" class="editor-form">
          <p>
            <label>
              Title
              <br />
              <input
                id="post-title"
                name="title"
                type="text"
                required
                maxlength={200}
                value={props.title}
                placeholder="Post title"
              />
            </label>
          </p>
          <p>
            <label>
              Slug (d-tag){" "}
              {isEdit ? (
                <input
                  id="post-slug"
                  name="slug"
                  type="text"
                  value={props.slug}
                  readonly
                />
              ) : (
                <input
                  id="post-slug"
                  name="slug"
                  type="text"
                  maxlength={64}
                  placeholder="derived from the title when empty"
                  autocomplete="off"
                  spellcheck={false}
                />
              )}
            </label>
          </p>
          <p>
            <label>
              Summary
              <br />
              <input
                id="post-summary"
                name="summary"
                type="text"
                maxlength={500}
                value={props.summary}
                placeholder="Optional one-line summary"
              />
            </label>
          </p>
          <p>
            <label>
              Markdown
              <br />
              {/* The textarea is seeded with a protective leading "\n" the
                  HTML parser eats exactly one of, so content that itself
                  starts with a newline round-trips unchanged — otherwise
                  republishing would strip it and mint a different event id. */}
              <textarea
                id="post-content"
                name="content"
                rows={20}
                cols={80}
                required
                spellcheck={true}
              >
                {"\n" + props.content}
              </textarea>
            </label>
          </p>
          <p class="editor-actions">
            <button id="preview-button" type="button">
              Preview
            </button>{" "}
            <button id="publish-button" type="button">
              {isEdit ? "Sign & republish" : "Sign & publish"}
            </button>
            {isEdit ? (
              <>
                {" "}
                <button id="delete-button" type="button" class="danger">
                  Delete post
                </button>
              </>
            ) : null}
          </p>
        </form>
        <p id="editor-status" role="status" aria-live="polite"></p>

        <section id="preview" hidden>
          <h2>Preview</h2>
          <div id="preview-body" class="post-content"></div>
        </section>

        <script
          type="application/json"
          id="editor-config"
          dangerouslySetInnerHTML={{ __html: configJson }}
        ></script>
        <script src="/js/editor.js"></script>
      </main>
    </Layout>
  );
}
