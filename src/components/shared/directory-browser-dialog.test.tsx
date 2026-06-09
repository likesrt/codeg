import { StrictMode, useEffect, useState } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DirectoryEntry } from "@/lib/types"
import { DirectoryBrowserDialog } from "./directory-browser-dialog"

const api = vi.hoisted(() => ({
  createFolderDirectory: vi.fn(),
  deleteFileTreeEntry: vi.fn(),
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const dir = (
  name: string,
  path: string,
  hasChildren = false
): DirectoryEntry => ({ name, path, hasChildren })

const onSelect = vi.fn()
const onOpenChange = vi.fn()

let setOpenExternal: (open: boolean) => void = () => {}

/**
 * 通过右键打开目录行的上下文菜单并返回目标菜单项。
 *
 * 关键参数为目录可访问名称和菜单项名称；返回菜单项元素。边界上会等待菜单浮层
 * 渲染完成，副作用是触发用户级右键交互。
 */
async function openDirectoryMenuItem(entryName: string, itemName: string) {
  await userEvent.pointer({
    keys: "[MouseRight]",
    target: screen.getByRole("button", { name: entryName }),
  })
  return screen.findByRole("menuitem", { name: itemName })
}

/**
 * 点击目录行上下文菜单中的指定菜单项。
 *
 * 关键参数为目录名称和菜单项名称；无返回值。边界上依赖 Radix 菜单完成打开后再
 * 点击，副作用是触发对应菜单命令。
 */
async function clickDirectoryMenuItem(entryName: string, itemName: string) {
  const item = await openDirectoryMenuItem(entryName, itemName)
  await userEvent.click(item)
}

/**
 * 为目录浏览器测试提供受控 open 状态和真实英文翻译。
 *
 * 关键参数为可选初始路径；返回带 i18n 的对话框。边界上父组件拥有 open 状态，
 * 因此取消和重开流程能覆盖生产代码中的异步会话失效逻辑。
 */
function Harness({ initialPath }: { initialPath?: string }) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    setOpenExternal = setOpen
  }, [])
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DirectoryBrowserDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          onOpenChange(next)
        }}
        onSelect={onSelect}
        initialPath={initialPath}
      />
    </NextIntlClientProvider>
  )
}

/**
 * 创建一个可由测试显式 resolve 的 Promise。
 *
 * 关键类型参数为 Promise 结果；返回 promise 与 resolve。边界上未 resolve 时保持
 * 挂起，用于验证慢请求不会污染新会话。
 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  onSelect.mockClear()
  onOpenChange.mockClear()
  setOpenExternal = () => {}
  api.createFolderDirectory.mockReset()
  api.createFolderDirectory.mockResolvedValue(undefined)
  api.deleteFileTreeEntry.mockReset()
  api.deleteFileTreeEntry.mockResolvedValue(undefined)
  api.getHomeDirectory.mockReset()
  api.getHomeDirectory.mockResolvedValue("/home/me")
  api.listDirectoryEntries.mockReset()
  api.listDirectoryEntries.mockResolvedValue([])
})

describe("DirectoryBrowserDialog", () => {
  it("pre-fills the initial path and confirms it without a tree click", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("work", "/home/me/work", true),
    ])
    render(<Harness initialPath="/home/me" />)

    await screen.findByDisplayValue("/home/me")
    const select = screen.getByRole("button", { name: "Select" })
    expect(select).toBeEnabled()

    fireEvent.click(select)

    await screen.findByDisplayValue("/home/me")
    expect(onSelect).toHaveBeenCalledWith("/home/me")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("updates the path input when a directory row is clicked and confirms that path", async () => {
    api.listDirectoryEntries.mockImplementation((p: string) =>
      p === "/home/me"
        ? Promise.resolve([dir("work", "/home/me/work", true)])
        : Promise.resolve([])
    )
    render(<Harness initialPath="/home/me" />)
    await screen.findByText("work")

    fireEvent.click(screen.getByText("work"))
    await screen.findByDisplayValue("/home/me/work")

    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    await screen.findByDisplayValue("/home/me/work")
    expect(onSelect).toHaveBeenCalledWith("/home/me/work")
  })

  it("keeps the dialog open and shows an error when the typed path is invalid", async () => {
    api.listDirectoryEntries.mockImplementation((p: string) =>
      p === "/home/me"
        ? Promise.resolve([dir("work", "/home/me/work", true)])
        : Promise.reject(new Error("ENOENT"))
    )
    render(<Harness initialPath="/home/me" />)
    await screen.findByDisplayValue("/home/me")

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/does/not/exist" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Select" }))

    await screen.findByText("Failed to load directory")
    expect(onSelect).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("navigates up relative to the path shown in the input, not the tree root", async () => {
    api.listDirectoryEntries.mockImplementation((p: string) =>
      p === "/home/me"
        ? Promise.resolve([dir("work", "/home/me/work", true)])
        : Promise.resolve([])
    )
    render(<Harness initialPath="/home/me" />)
    await screen.findByText("work")

    fireEvent.click(screen.getByText("work"))
    await screen.findByDisplayValue("/home/me/work")

    fireEvent.click(screen.getByTitle("Go to parent directory"))

    await screen.findByDisplayValue("/home/me")
    expect(screen.queryByDisplayValue("/home")).toBeNull()
  })

  it("creates a child directory from a directory context menu", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) => {
      if (path === "/home/me") {
        return Promise.resolve([
          dir("project", "/home/me/project"),
          dir("docs", "/home/me/docs"),
        ])
      }
      if (path === "/home/me/project") return Promise.resolve([])
      return Promise.resolve([])
    })
    render(<Harness initialPath="/home/me" />)

    await screen.findByText("project")
    await clickDirectoryMenuItem("project", "New child folder")
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "src" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    await waitFor(() => {
      expect(api.createFolderDirectory).toHaveBeenCalledWith(
        "/home/me/project/src"
      )
    })
    expect(api.listDirectoryEntries).toHaveBeenCalledWith("/home/me/project")
    expect(screen.getByRole("textbox")).toHaveValue("/home/me/project/src")
  })

  it("ignores repeated create submissions while creation is pending", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) =>
      path === "/home/me"
        ? Promise.resolve([dir("project", "/home/me/project")])
        : Promise.resolve([])
    )
    api.createFolderDirectory.mockImplementation(
      () => new Promise(() => undefined)
    )
    render(<Harness initialPath="/home/me" />)

    await screen.findByText("project")
    await clickDirectoryMenuItem("project", "New child folder")
    const nameInput = screen.getByPlaceholderText("Folder name")
    fireEvent.change(nameInput, { target: { value: "src" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    fireEvent.keyDown(nameInput, { key: "Enter" })

    await waitFor(() => {
      expect(api.createFolderDirectory).toHaveBeenCalledTimes(1)
    })
    expect(nameInput).toBeDisabled()
    expect(screen.getByRole("button", { name: "Loading..." })).toBeDisabled()
  })

  it("marks directory deletion context menu item as destructive", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("project", "/home/me/project"),
    ])
    render(<Harness initialPath="/home/me" />)

    await screen.findByText("project")
    const deleteItem = await openDirectoryMenuItem(
      "project",
      "Delete directory"
    )

    expect(deleteItem).toHaveAttribute("data-variant", "destructive")
  })

  it("opens a confirmation dialog before deleting a directory", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("project", "/home/me/project"),
    ])
    render(<Harness initialPath="/home/me" />)

    await screen.findByText("project")
    await clickDirectoryMenuItem("project", "Delete directory")

    expect(screen.getByText("Delete directory?"))
    expect(
      screen.getByText(
        "This will permanently delete the selected directory and its contents. This action cannot be undone."
      )
    )
    expect(api.deleteFileTreeEntry).not.toHaveBeenCalled()
  })

  it("focuses cancel by default and does not delete when deletion is cancelled", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("project", "/home/me/project"),
    ])
    render(<Harness initialPath="/home/me" />)

    await screen.findByText("project")
    await clickDirectoryMenuItem("project", "Delete directory")

    const cancelButton = await screen.findByRole("button", {
      name: "Cancel delete",
    })
    await waitFor(() => expect(cancelButton).toHaveFocus())

    fireEvent.click(cancelButton)

    expect(api.deleteFileTreeEntry).not.toHaveBeenCalled()
  })

  it("deletes a directory through the file tree API and refreshes its parent", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) =>
      path === "/home/me"
        ? Promise.resolve([dir("project", "/home/me/project")])
        : Promise.resolve([])
    )
    render(<Harness initialPath="/home/me" />)

    await screen.findByText("project")
    await clickDirectoryMenuItem("project", "Delete directory")
    fireEvent.click(screen.getByRole("button", { name: "Delete directory" }))

    await waitFor(() => {
      expect(api.deleteFileTreeEntry).toHaveBeenCalledWith(
        "/home/me",
        "project"
      )
    })
    expect(api.listDirectoryEntries).toHaveBeenCalledWith("/home/me")
  })

  it("clears deleted Windows descendant selection after deleting a directory", async () => {
    const root = "C:\\repo"
    const src = "C:\\repo\\src"
    const child = "C:\\repo\\src\\child"

    api.listDirectoryEntries.mockImplementation((path: string) => {
      if (path === root) return Promise.resolve([dir("src", src, true)])
      if (path === src) return Promise.resolve([dir("child", child)])
      return Promise.resolve([])
    })

    render(<Harness initialPath={root} />)

    await screen.findByText("src")
    const srcRow = screen.getByRole("button", { name: "src" })
    fireEvent.click(srcRow)
    fireEvent.click(within(srcRow).getByRole("button"))
    await screen.findByText("child")
    fireEvent.click(screen.getByRole("button", { name: "child" }))
    expect(screen.getByRole("textbox")).toHaveValue(child)

    await clickDirectoryMenuItem("src", "Delete directory")
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete directory" })
    )

    await waitFor(() => {
      expect(api.deleteFileTreeEntry).toHaveBeenCalledWith(root, "src")
    })
    expect(screen.queryByText(child)).not.toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue(root)
  })

  it("does not commit a path when the dialog is cancelled mid-validation", async () => {
    const slow = deferred<DirectoryEntry[]>()
    api.listDirectoryEntries.mockImplementation((p: string) => {
      if (p === "/home/me")
        return Promise.resolve([dir("work", "/home/me/work", true)])
      if (p === "/slow/dir") return slow.promise
      return Promise.resolve([])
    })
    render(<Harness initialPath="/home/me" />)
    await screen.findByDisplayValue("/home/me")

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/slow/dir" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    await act(async () => {
      slow.resolve([])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it("does not commit the original path when the selection changes mid-validation", async () => {
    const slow = deferred<DirectoryEntry[]>()
    api.listDirectoryEntries.mockImplementation((p: string) => {
      if (p === "/home/me")
        return Promise.resolve([dir("work", "/home/me/work", true)])
      if (p === "/slow/dir") return slow.promise
      return Promise.resolve([])
    })
    render(<Harness initialPath="/home/me" />)
    await screen.findByText("work")

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/slow/dir" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getByText("work"))
    await screen.findByDisplayValue("/home/me/work")

    await act(async () => {
      slow.resolve([])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it("does not show or confirm the previous path while a reopened dialog loads", async () => {
    const home2 = deferred<string>()
    api.getHomeDirectory.mockReset()
    api.getHomeDirectory
      .mockResolvedValueOnce("/home/me")
      .mockImplementationOnce(() => home2.promise)
    api.listDirectoryEntries.mockImplementation((p: string) =>
      p === "/home/me"
        ? Promise.resolve([dir("work", "/home/me/work", true)])
        : Promise.resolve([])
    )
    render(<Harness />)

    await screen.findByText("work")
    fireEvent.click(screen.getByText("work"))
    await screen.findByDisplayValue("/home/me/work")

    act(() => setOpenExternal(false))
    act(() => setOpenExternal(true))

    expect(screen.queryByDisplayValue("/home/me/work")).toBeNull()
    expect(screen.getByRole("button", { name: "Select" })).toBeDisabled()

    await act(async () => {
      home2.resolve("/home/me")
      await Promise.resolve()
    })
    await screen.findByDisplayValue("/home/me")
  })

  it("ignores a stale init from a previous open", async () => {
    const home1 = deferred<string>()
    api.getHomeDirectory.mockReset()
    api.getHomeDirectory
      .mockImplementationOnce(() => home1.promise)
      .mockResolvedValueOnce("/home/v2")
    render(<Harness />)

    act(() => setOpenExternal(false))
    act(() => setOpenExternal(true))
    await screen.findByDisplayValue("/home/v2")

    await act(async () => {
      home1.resolve("/home/v1")
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole("textbox")).toHaveValue("/home/v2")
  })

  it("ignores a stale navigation (Enter) that outlives a close/reopen", async () => {
    const slow = deferred<DirectoryEntry[]>()
    api.getHomeDirectory.mockReset()
    api.getHomeDirectory
      .mockResolvedValueOnce("/home/me")
      .mockResolvedValueOnce("/home/v2")
    api.listDirectoryEntries.mockImplementation((p: string) =>
      p === "/slow/dir" ? slow.promise : Promise.resolve([])
    )
    render(<Harness />)
    await screen.findByDisplayValue("/home/me")

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/slow/dir" },
    })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })

    act(() => setOpenExternal(false))
    act(() => setOpenExternal(true))
    await screen.findByDisplayValue("/home/v2")

    await act(async () => {
      slow.resolve([])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole("textbox")).toHaveValue("/home/v2")
  })

  it("initializes correctly under StrictMode despite effect replay", async () => {
    api.getHomeDirectory.mockReset()
    api.getHomeDirectory.mockResolvedValue("/home/me")
    api.listDirectoryEntries.mockResolvedValue([])
    render(
      <StrictMode>
        <Harness />
      </StrictMode>
    )

    await screen.findByDisplayValue("/home/me")
    expect(screen.getByRole("button", { name: "Select" })).toBeEnabled()
  })

  it("does not let a stale confirm clear a newer open's spinner", async () => {
    const slowA = deferred<DirectoryEntry[]>()
    const slowB = deferred<DirectoryEntry[]>()
    api.getHomeDirectory.mockReset()
    api.getHomeDirectory
      .mockResolvedValueOnce("/home/me")
      .mockResolvedValueOnce("/home/me")
    api.listDirectoryEntries.mockImplementation((p: string) => {
      if (p === "/slow/a") return slowA.promise
      if (p === "/slow/b") return slowB.promise
      return Promise.resolve([])
    })
    render(<Harness />)
    await screen.findByDisplayValue("/home/me")

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/slow/a" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Select" }))

    act(() => setOpenExternal(false))
    act(() => setOpenExternal(true))
    await screen.findByDisplayValue("/home/me")

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/slow/b" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Select" }))
    expect(screen.getByRole("button", { name: "Loading..." })).toBeDisabled()

    await act(async () => {
      slowA.resolve([])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole("button", { name: "Loading..." })).toBeDisabled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("lets the newest navigation win when an older one resolves later", async () => {
    const slowOld = deferred<DirectoryEntry[]>()
    api.listDirectoryEntries.mockImplementation((p: string) =>
      p === "/nav/old" ? slowOld.promise : Promise.resolve([])
    )
    render(<Harness initialPath="/home/me" />)
    await screen.findByDisplayValue("/home/me")

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/nav/old" },
    })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/nav/new" },
    })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    await screen.findByDisplayValue("/nav/new")

    await act(async () => {
      slowOld.resolve([])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole("textbox")).toHaveValue("/nav/new")
  })

  it("lets a user navigation during the initial load win over init", async () => {
    const home = deferred<string>()
    api.getHomeDirectory.mockReset()
    api.getHomeDirectory.mockImplementationOnce(() => home.promise)
    api.listDirectoryEntries.mockResolvedValue([])
    render(<Harness />)

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/typed/dir" },
    })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    await screen.findByDisplayValue("/typed/dir")

    await act(async () => {
      home.resolve("/home/me")
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole("textbox")).toHaveValue("/typed/dir")
  })

  it("expands two folders concurrently without losing either", async () => {
    const loadA = deferred<DirectoryEntry[]>()
    const loadB = deferred<DirectoryEntry[]>()
    api.listDirectoryEntries.mockImplementation((p: string) => {
      if (p === "/home/me") {
        return Promise.resolve([
          dir("a", "/home/me/a", true),
          dir("b", "/home/me/b", true),
        ])
      }
      if (p === "/home/me/a") return loadA.promise
      if (p === "/home/me/b") return loadB.promise
      return Promise.resolve([])
    })
    render(<Harness initialPath="/home/me" />)
    await screen.findByText("a")

    const chevron = (name: string) =>
      within(screen.getByText(name).closest("button")!).getByRole("button")
    fireEvent.click(chevron("a"))
    fireEvent.click(chevron("b"))

    await act(async () => {
      loadA.resolve([dir("a-child", "/home/me/a/a-child")])
      loadB.resolve([dir("b-child", "/home/me/b/b-child")])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText("a-child")).toBeInTheDocument()
    expect(await screen.findByText("b-child")).toBeInTheDocument()
  })
})
