import type { Child } from "hono/jsx";
import { FAVICON_HREF } from "./brand";

/**
 * Base HTML layout for apex pages (and the tenant 404, which renders on
 * blog hosts too — so this must stay script-free and form-free). Body gets
 * class "apex" (scopes the apex type scale and form styles) plus any extra
 * page class (e.g. "editor-wide").
 */
export function Layout(props: {
  title: string;
  description?: string;
  bodyClass?: string;
  children?: Child;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        {props.description ? (
          <meta name="description" content={props.description} />
        ) : null}
        <link rel="icon" type="image/svg+xml" href={FAVICON_HREF} />
        <link rel="stylesheet" href="/css/style.css" />
      </head>
      <body class={props.bodyClass ? `apex ${props.bodyClass}` : "apex"}>
        {props.children}
      </body>
    </html>
  );
}
