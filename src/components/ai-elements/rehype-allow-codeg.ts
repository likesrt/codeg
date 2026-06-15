import type { ComponentProps } from "react"
import type { Streamdown } from "streamdown"

type RehypePlugins = NonNullable<
  ComponentProps<typeof Streamdown>["rehypePlugins"]
>
type RehypePlugin = RehypePlugins[number]

/** Minimal view of rehype-sanitize's schema — only the protocol allow-list we widen. */
type SanitizeSchema = {
  protocols?: Record<string, string[]>
  [key: string]: unknown
}

/**
 * Re-derive Streamdown's default rehype pipeline so the app-internal `codeg`
 * scheme survives sanitization and reaches `MarkdownLink` → `ReferenceBadge`.
 *
 * Streamdown's default pipeline is `[raw, [rehypeSanitize, schema], harden]`
 * (run in that order). The sanitize schema's `protocols.href` allow-list omits
 * `codeg`, so it strips the href off our `[label](codeg://…)` reference links;
 * rehype-harden then sees a hrefless `<a>`, can't transform it, and replaces it
 * with a `… [blocked]` span — all at the rehype stage, *before* react-markdown
 * maps `<a>` to `MarkdownLink` (which turns a `codeg:` href into an inline
 * badge). The net effect was `@Codex CLI [blocked]` in the transcript.
 *
 * Adding `codeg` to the sanitize allow-list lets the href survive. harden is
 * left untouched: it already permits every protocol via its `*` default and
 * still hard-blocks `javascript:` / `data:` / `file:` / `vbscript:`, so widening
 * sanitize by one inert app scheme adds no XSS surface. `file://` links are
 * unaffected — they are rewritten to local paths at the remark layer (see
 * {@link "./remark-file-uri-links"}) before sanitize runs.
 *
 * Only the `sanitize` entry is rewritten; every other plugin is passed through
 * in its original position (mirroring how Streamdown builds the default list via
 * `Object.values`), so the pipeline stays correct if upstream adds plugins.
 */
export function rehypePluginsAllowingCodeg(
  defaults: Record<string, RehypePlugin>
): RehypePlugins {
  return Object.entries(defaults).map<RehypePlugin>(([key, plugin]) => {
    if (key !== "sanitize") return plugin
    const [sanitizePlugin, schema] = (
      Array.isArray(plugin) ? plugin : [plugin]
    ) as [RehypePlugin, SanitizeSchema?]
    const href = schema?.protocols?.href ?? []
    const next: SanitizeSchema = {
      ...schema,
      protocols: {
        ...schema?.protocols,
        href: href.includes("codeg") ? href : [...href, "codeg"],
      },
    }
    return [sanitizePlugin, next] as RehypePlugin
  })
}
