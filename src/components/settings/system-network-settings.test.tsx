import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()
const subscribe = vi.fn(async () => () => {})

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call, subscribe }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
}))

vi.mock("@/lib/api", () => ({
  getSystemProxySettings: vi.fn(),
  updateSystemProxySettings: vi.fn(),
  updateSystemLanguageSettings: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))

vi.mock("@/components/i18n-provider", () => ({
  useAppI18n: () => ({
    languageSettings: { mode: "system", language: "en" },
    languageSettingsLoaded: true,
    setLanguageSettings: vi.fn(),
  }),
}))

// Keep the test hermetic from the markdown ESM stack (only rendered when an
// update is available, which it isn't here).
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: string }) => children ?? null,
}))
vi.mock("remark-gfm", () => ({ default: () => undefined }))

import { SystemNetworkSettings } from "./system-network-settings"
import enMessages from "@/i18n/messages/en.json"
import { getSystemProxySettings } from "@/lib/api"

const mockGetProxy = vi.mocked(getSystemProxySettings)

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SystemNetworkSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  call.mockReset()
  subscribe.mockClear()
  mockGetProxy.mockReset()
})

describe("SystemNetworkSettings — update source outage", () => {
  it("loads proxy settings and exposes rollback when the manifest is unreachable", async () => {
    // The release source is down: the update CHECK fails, but the version read
    // and rollback availability come from the local `app_update_status`
    // endpoint, so neither the settings load nor the rollback action breaks.
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://proxy.local:8080",
    })
    call.mockImplementation(async (endpoint: string) => {
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.14.11",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: true,
        }
      }
      if (endpoint === "health") return { version: "0.14.11" }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })

    renderWithIntl()

    // Rollback action is exposed despite the failed update check.
    expect(
      await screen.findByRole("button", { name: "Roll back" })
    ).toBeInTheDocument()

    // Unrelated local settings still loaded (not defaulted), and the settings
    // load itself did not error out.
    expect(
      screen.getByDisplayValue("http://proxy.local:8080")
    ).toBeInTheDocument()
    expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument()
  })

  it("loads proxy settings even when the status route is also unavailable (older server)", async () => {
    // Newer desktop, older remote server: both the update check and the new
    // /app_update_status route fail; the version still resolves via /health and
    // the settings load must not break.
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://proxy.local:8080",
    })
    call.mockImplementation(async (endpoint: string) => {
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      if (endpoint === "app_update_status") {
        throw new Error("not implemented")
      }
      if (endpoint === "health") return { version: "0.14.11" }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })

    renderWithIntl()

    // Settings load completed (spinner gone) and proxy is loaded, not defaulted.
    expect(
      await screen.findByDisplayValue("http://proxy.local:8080")
    ).toBeInTheDocument()
    expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument()
  })
})
