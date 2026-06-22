import {
  render,
  screen,
  cleanup,
  within,
  fireEvent,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
  type ReactNode,
} from "react"

// virtua renders ZERO rows under jsdom (no layout), so mock it to render every
// child directly — the established pattern (see sidebar-conversation-list.test).
// Forward a no-op scrollToIndex handle so keyboard nav doesn't throw.
vi.mock("virtua", () => ({
  VList: forwardRef(function VListMock(
    props: {
      children: ReactNode
      role?: string
      id?: string
      "aria-label"?: string
      style?: CSSProperties
      className?: string
    },
    ref: React.Ref<{ scrollToIndex: (i: number) => void }>
  ) {
    useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }))
    return (
      <div
        role={props.role}
        id={props.id}
        aria-label={props["aria-label"]}
        className={props.className}
      >
        {props.children}
      </div>
    )
  }),
}))

import { ModelOptionList } from "./model-option-list"
import type { ModelOptionGroup } from "@/lib/model-config-groups"

const GROUPS: ModelOptionGroup[] = [
  {
    key: "anthropic",
    name: "anthropic",
    options: [
      { value: "anthropic/opus", name: "opus", description: null },
      { value: "anthropic/sonnet", name: "sonnet", description: null },
    ],
  },
  {
    key: "openai",
    name: "openai",
    options: [{ value: "openai/gpt-4o", name: "gpt-4o", description: null }],
  },
]

function renderList(
  overrides: Partial<Parameters<typeof ModelOptionList>[0]> = {}
) {
  const onSelect = vi.fn()
  render(
    <ModelOptionList
      groups={GROUPS}
      currentValue="anthropic/opus"
      onSelect={onSelect}
      searchPlaceholder="Search models"
      searchAriaLabel="Search models"
      listAriaLabel="Models"
      emptyLabel="No models found"
      {...overrides}
    />
  )
  return { onSelect }
}

describe("ModelOptionList", () => {
  afterEach(() => cleanup())

  it("renders grouped options and marks the current value selected", () => {
    renderList()
    expect(screen.getByText("anthropic")).toBeInTheDocument()
    expect(screen.getByText("openai")).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /opus/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("option", { name: /sonnet/ })).toHaveAttribute(
      "aria-selected",
      "false"
    )
  })

  it("filters options as you type (matching name or value)", async () => {
    const user = userEvent.setup()
    renderList()
    await user.type(screen.getByRole("combobox"), "gpt")
    expect(screen.getByRole("option", { name: /gpt-4o/ })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /opus/ })).toBeNull()
    // The now-empty anthropic group drops its header too.
    expect(screen.queryByText("anthropic")).toBeNull()
  })

  it("shows the empty label when nothing matches", async () => {
    const user = userEvent.setup()
    renderList()
    await user.type(screen.getByRole("combobox"), "zzzz")
    expect(screen.getByText("No models found")).toBeInTheDocument()
    expect(screen.queryByRole("option")).toBeNull()
  })

  it("commits a value on click", async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList()
    await user.click(screen.getByRole("option", { name: /sonnet/ }))
    expect(onSelect).toHaveBeenCalledWith("anthropic/sonnet")
  })

  it("navigates with the keyboard and commits on Enter", async () => {
    const user = userEvent.setup()
    const { onSelect } = renderList()
    const input = screen.getByRole("combobox")
    await user.click(input)
    // Cursor starts at the first option (opus); ArrowDown → sonnet, Enter picks.
    await user.keyboard("{ArrowDown}{Enter}")
    expect(onSelect).toHaveBeenCalledWith("anthropic/sonnet")
  })

  it("ignores Enter while an IME composition is in flight", () => {
    const { onSelect } = renderList()
    const input = screen.getByRole("combobox")
    // Enter during CJK composition confirms the candidate — it must NOT select.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("points aria-activedescendant at the active option", async () => {
    const user = userEvent.setup()
    renderList()
    const input = screen.getByRole("combobox")
    const initial = input.getAttribute("aria-activedescendant")
    expect(initial).toBeTruthy()
    // The active descendant must resolve to a real option element.
    const listbox = screen.getByRole("listbox")
    expect(within(listbox).getByRole("option", { name: /opus/ }).id).toBe(
      initial
    )
    await user.click(input)
    await user.keyboard("{ArrowDown}")
    expect(input.getAttribute("aria-activedescendant")).not.toBe(initial)
  })
})
