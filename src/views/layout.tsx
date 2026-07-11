import type { Child } from "hono/jsx";

/** Base HTML layout shared by main-site and blog pages. */
export function Layout(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/css/style.css" />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
