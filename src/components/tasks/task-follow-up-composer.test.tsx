import { act, render, screen, waitFor } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { NextIntlClientProvider } from "next-intl"
import { createRef, useState } from "react"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { RichComposerHandle } from "@/components/chat/composer/rich-composer"
import type { ReferenceSearch } from "@/components/chat/composer/suggestion/types"
import type { AgentSkillItem, AgentType } from "@/lib/types"

import { TaskFollowUpComposer } from "./task-follow-up-composer"

// The `/` menu's source: the agent-options probe (a transient CLI session).
vi.mock("@/components/automations/use-agent-options", () => ({
  useAgentOptions: () => ({
    snapshot: {
      available_commands: [
        { name: "review", description: "Review the working diff" },
        { name: "commit", description: "Commit the change" },
      ],
    },
    loading: false,
    error: null,
    reload: vi.fn(),
    ensure: () => Promise.resolve(null),
  }),
}))

// Codex's `$` skills: a filesystem scan in production.
const SKILL: AgentSkillItem = {
  id: "deploy",
  name: "Deploy",
  scope: "global",
  layout: "skill_directory",
  path: "/skills/deploy",
  description: "Ship it",
  read_only: false,
}
vi.mock("@/hooks/use-agent-skills", () => ({
  useAgentSkills: (agentType: AgentType | null) =>
    agentType === "codex" ? [SKILL] : [],
}))

// The `@` panel's data sources all hit the transport; the panel itself is what
// matters here, so it gets one canned file.
const search: ReferenceSearch = () => [
  {
    kind: "file",
    label: "Files",
    items: [
      {
        reference: {
          refType: "file",
          id: "src/app.ts",
          label: "app.ts",
          uri: "file:///repo-task-7/src/app.ts",
          meta: { fileKind: "file" },
        },
        detail: "src/app.ts",
      },
    ],
  },
]
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => search,
}))

async function mount(
  props: Partial<React.ComponentProps<typeof TaskFollowUpComposer>> = {}
) {
  const ref = createRef<RichComposerHandle>()
  const onChange = vi.fn()
  const onSubmit = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskFollowUpComposer
        editorRef={ref}
        agentType="claude_code"
        folderPath="/repo-task-7"
        defaultText=""
        placeholder="What should the agent change?"
        ariaLabel="Follow up"
        onChange={onChange}
        onSubmit={onSubmit}
        {...props}
      />
    </NextIntlClientProvider>
  )
  // Editor construction (ProseMirror + React node views) is async and can be
  // slow under parallel workers.
  await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
    timeout: 5000,
  })
  const editor = ref.current?.getEditor() as Editor
  return { ref, editor, onChange, onSubmit }
}

describe("TaskFollowUpComposer", () => {
  it("offers the agent's slash commands and inserts the invocation token", async () => {
    const { editor, onChange } = await mount()
    act(() => {
      editor.commands.insertContent("/rev")
    })
    const row = await screen.findByText("/review", {}, { timeout: 5000 })
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    })
    // The badge serializes to the literal token the agent runs, and the typed
    // trigger text is gone.
    await waitFor(() => expect(editor.getText()).toContain("/review"))
    expect(editor.getText()).not.toContain("/rev ")
    expect(onChange).toHaveBeenCalled()
  })

  it("references a file through the @ panel", async () => {
    const { editor } = await mount()
    act(() => {
      editor.commands.insertContent("@app")
    })
    const row = await screen.findByText("app.ts", {}, { timeout: 5000 })
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    })
    // What the backend receives is one string: the reference as a Markdown
    // link, the same shape the chat composer sends.
    await waitFor(() =>
      expect(editor.getText()).toContain(
        "[app.ts](file:///repo-task-7/src/app.ts)"
      )
    )
  })

  it("triggers Codex skills on $, not on #", async () => {
    const { editor } = await mount({ agentType: "codex" })
    act(() => {
      editor.commands.insertContent("#dep")
    })
    // `#` is ordinary text — no menu, nothing swallowed.
    expect(screen.queryByText("Deploy")).toBeNull()

    act(() => {
      editor.commands.setContent("")
      editor.commands.insertContent("$dep")
    })
    const row = await screen.findByText("Deploy", {}, { timeout: 5000 })
    act(() => {
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      )
    })
    await waitFor(() => expect(editor.getText()).toContain("$deploy"))
  })

  it("follows the scenario's placeholder without dropping what was typed", async () => {
    // Tiptap bakes the placeholder into an extension at creation, so switching
    // scenario chips remounts the box. Wired the way the drawer wires it, the
    // text has to survive that.
    const ref = createRef<RichComposerHandle>()
    function Host({ placeholder }: { placeholder: string }) {
      const [text, setText] = useState("")
      return (
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <TaskFollowUpComposer
            editorRef={ref}
            agentType="claude_code"
            folderPath={null}
            defaultText={text}
            placeholder={placeholder}
            ariaLabel="Follow up"
            onChange={setText}
          />
        </NextIntlClientProvider>
      )
    }
    const { rerender } = render(<Host placeholder="What should it change?" />)
    await waitFor(() => expect(ref.current?.getEditor()).not.toBeNull(), {
      timeout: 5000,
    })
    expect(
      document.querySelector('[data-placeholder="What should it change?"]')
    ).not.toBeNull()

    act(() => {
      ref.current?.getEditor()?.commands.insertContent("check the retry path")
    })
    rerender(<Host placeholder="What do you want to know?" />)
    await waitFor(() =>
      expect(
        document.querySelector('[data-placeholder="What do you want to know?"]')
      ).not.toBeNull()
    )
    expect(ref.current?.getText()).toContain("check the retry path")
  })
})
