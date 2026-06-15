import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// Exercise the REAL Streamdown pipeline (no streamdown mock) so the assertion
// covers the actual rehype ordering — the command-badge plugin must run after
// sanitize/harden and before the math (katex) plugin. Only the link-safety hook
// is stubbed (irrelevant to badges).
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { MessageResponse } from "./message"

const skillBadge = (c: HTMLElement) =>
  c.querySelector("[data-reference-badge][data-ref-type='skill']")

describe("MessageResponse — `/`·`$` tokens badge in user messages (real Streamdown)", () => {
  it("badges a `/command` token (with its prefix) in a user message", async () => {
    const { container } = render(
      <MessageResponse softBreaks>{"run /review please"}</MessageResponse>
    )
    await waitFor(() => expect(skillBadge(container)).not.toBeNull())
    expect(container.textContent).toContain("/review")
    expect(container.textContent).toContain("please")
    expect(container.textContent).not.toContain("[blocked]")
  })

  it("badges a `$skill` token in a user message", async () => {
    const { container } = render(
      <MessageResponse softBreaks>{"$deploy now"}</MessageResponse>
    )
    await waitFor(() => expect(skillBadge(container)).not.toBeNull())
    expect(container.textContent).toContain("$deploy")
  })

  it("does NOT badge `/command` in an assistant message (no softBreaks)", async () => {
    const { container } = render(
      <MessageResponse>{"run /review please"}</MessageResponse>
    )
    // Let the async block render, then assert the token stayed plain text.
    await waitFor(() => expect(container.textContent).toContain("/review"))
    expect(skillBadge(container)).toBeNull()
  })

  it("does NOT badge a file-ish path", async () => {
    const { container } = render(
      <MessageResponse softBreaks>{"see /usr/bin for it"}</MessageResponse>
    )
    await waitFor(() => expect(container.textContent).toContain("/usr/bin"))
    expect(skillBadge(container)).toBeNull()
  })

  it("does NOT badge a token inside inline code", async () => {
    const { container } = render(
      <MessageResponse softBreaks>{"type `/review` here"}</MessageResponse>
    )
    await waitFor(() => expect(container.textContent).toContain("/review"))
    expect(skillBadge(container)).toBeNull()
  })

  it("does NOT badge `$…$` math as a skill token", async () => {
    const { container } = render(
      <MessageResponse softBreaks>{"the value $x$ holds"}</MessageResponse>
    )
    await waitFor(() => expect(container.textContent).toContain("holds"))
    expect(skillBadge(container)).toBeNull()
  })
})
