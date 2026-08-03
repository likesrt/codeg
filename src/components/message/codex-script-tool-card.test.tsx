import { type ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * Codex "code mode" cards.
 *
 * Codex now wraps every tool call in a JS script. The history parser
 * (`src-tauri/src/parsers/codex_code_mode.rs`) recovers the inner
 * `tools.<name>(…)` calls so the ordinary cards keep working, and emits a
 * `codex_script` card only for the scripts it could not decompose. Before that,
 * every codex history card was titled `const r = await tools.exec_command({`
 * and rendered the JS as a shell command.
 */

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({
    filePath,
    children,
  }: {
    filePath: string
    children: ReactNode
  }) => <button data-path={filePath}>{children}</button>,
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code-block" data-language={language}>
      {code}
    </pre>
  ),
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { CODEX_SCRIPT_TOOL_NAME } from "@/lib/codex-code-mode"

function renderParts(parts: AdaptedContentPart[], expand = true) {
  const result = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={parts} role="assistant" />
    </NextIntlClientProvider>
  )
  if (expand) fireEvent.click(screen.getAllByRole("button")[0])
  return result
}

const SCRIPT_SOURCE = `const cmds = [
  {cmd: "cargo test", workdir: "/repo"},
  {cmd: "cargo clippy", workdir: "/repo"}
];
const rs = await Promise.all(cmds.map(c => tools.exec_command(c)));`

function scriptPart(
  card: { source: string; title?: string; call_count?: number },
  output: string
): AdaptedContentPart {
  return {
    type: "tool-call",
    toolCallId: "tc-script",
    toolName: CODEX_SCRIPT_TOOL_NAME,
    input: JSON.stringify(card),
    state: "output-available",
    output,
  }
}

describe("codex code-mode cards", () => {
  it("renders an undecomposable script as JS, titled by its first command", () => {
    renderParts([
      scriptPart(
        { source: SCRIPT_SOURCE, title: "cargo test", call_count: 1 },
        "test result: ok. 12 passed"
      ),
    ])

    expect(screen.getByText("cargo test")).toBeInTheDocument()
    // First block is the input (the script); the second is the output body.
    const block = screen.getAllByTestId("code-block")[0]
    expect(block).toHaveAttribute("data-language", "javascript")
    expect(block.textContent).toContain("Promise.all")
    expect(screen.getByText("1 tool call")).toBeInTheDocument()
    expect(document.body.textContent).toContain("test result: ok. 12 passed")
  })

  it("falls back to a plain Script label when no command could be read", () => {
    renderParts([scriptPart({ source: "text('hi');", call_count: 0 }, "hi")])

    expect(screen.getByText("Script")).toBeInTheDocument()
    // The count line is suppressed when the script called no tools at all.
    expect(document.body.textContent).not.toContain("tool call")
  })

  it("never renders the script as a shell command", () => {
    const { container } = renderParts([
      scriptPart({ source: SCRIPT_SOURCE, title: "cargo test" }, "done"),
    ])

    // The terminal card prefixes commands with `$ `; a JS script must not get
    // one, which is exactly what the `exec` → "bash" freeform match produced.
    expect(container.textContent).not.toContain("$ const")
  })

  it("renders an unwrapped inner call as its own tool card", () => {
    // What the parser emits for `tools.exec_command({cmd: "git status"})`:
    // the pre-code-mode shape (bare command), so the Terminal card matches.
    renderParts([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "exec_command",
        input: "git status --short",
        state: "output-available",
        output: " M src/main.rs",
      },
    ])

    expect(screen.getByText("git status --short")).toBeInTheDocument()
    expect(document.body.textContent).toContain(" M src/main.rs")
    expect(document.body.textContent).not.toContain("await tools.")
  })
})
