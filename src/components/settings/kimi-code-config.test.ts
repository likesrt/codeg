import { describe, expect, it } from "vitest"

import {
  KIMI_INTERFACE_TYPES,
  kimiBaseUrlForRegion,
  kimiEndpointRegionFromBaseUrl,
  kimiInitialMode,
  kimiInterfaceMeta,
  parseKimiManagedConfig,
} from "./acp-agent-settings"

describe("kimiEndpointRegionFromBaseUrl", () => {
  it("maps Moonshot endpoints + empty to a region, others to custom", () => {
    expect(kimiEndpointRegionFromBaseUrl("")).toBe("international")
    expect(kimiEndpointRegionFromBaseUrl("https://api.moonshot.ai/v1")).toBe(
      "international"
    )
    expect(kimiEndpointRegionFromBaseUrl("https://api.moonshot.cn/v1")).toBe(
      "china"
    )
    expect(kimiEndpointRegionFromBaseUrl("https://api.deepseek.com/v1")).toBe(
      "custom"
    )
  })

  it("is case-insensitive", () => {
    expect(kimiEndpointRegionFromBaseUrl("HTTPS://API.MOONSHOT.CN/V1")).toBe(
      "china"
    )
  })
})

describe("kimiBaseUrlForRegion", () => {
  it("resolves each region to its endpoint, trimming a custom URL", () => {
    expect(kimiBaseUrlForRegion("international", "")).toBe(
      "https://api.moonshot.ai/v1"
    )
    expect(kimiBaseUrlForRegion("china", "")).toBe("https://api.moonshot.cn/v1")
    expect(kimiBaseUrlForRegion("custom", "  https://x/v1  ")).toBe(
      "https://x/v1"
    )
  })
})

describe("kimiInterfaceMeta + KIMI_INTERFACE_TYPES", () => {
  it("exposes all six interface types in order", () => {
    expect(KIMI_INTERFACE_TYPES.map((m) => m.value)).toEqual([
      "kimi",
      "openai",
      "openai_responses",
      "anthropic",
      "google-genai",
      "vertexai",
    ])
  })

  it("vertexai uses GCP ADC (no API key); kimi defaults to Moonshot", () => {
    expect(kimiInterfaceMeta("vertexai").usesApiKey).toBe(false)
    expect(kimiInterfaceMeta("kimi").defaultBaseUrl).toBe(
      "https://api.moonshot.ai/v1"
    )
  })

  it("falls back to kimi for an unknown type", () => {
    // @ts-expect-error testing the runtime fallback for an out-of-range value
    expect(kimiInterfaceMeta("nope").value).toBe("kimi")
  })
})

describe("parseKimiManagedConfig", () => {
  it("returns an empty object for blank or invalid JSON", () => {
    expect(parseKimiManagedConfig(null)).toEqual({})
    expect(parseKimiManagedConfig("")).toEqual({})
    expect(parseKimiManagedConfig("{not json")).toEqual({})
  })

  it("parses a managed projection incl. gate-credential flags", () => {
    const cfg = parseKimiManagedConfig(
      JSON.stringify({
        interfaceType: "anthropic",
        key: "sk",
        hasManagedBlock: true,
        credentialPresent: true,
        credentialSynthetic: true,
      })
    )
    expect(cfg.interfaceType).toBe("anthropic")
    expect(cfg.key).toBe("sk")
    expect(cfg.hasManagedBlock).toBe(true)
    expect(cfg.credentialPresent).toBe(true)
    expect(cfg.credentialSynthetic).toBe(true)
  })
})

describe("kimiInitialMode", () => {
  it("prefers a managed block, then a real login, else the api-key form", () => {
    expect(kimiInitialMode({ hasManagedBlock: true })).toBe("apikey")
    // A real (non-synthetic) login → show login mode so we don't offer to
    // overwrite it.
    expect(
      kimiInitialMode({ credentialPresent: true, credentialSynthetic: false })
    ).toBe("login")
    // codeg's own synthetic gate token is not a "login" → default to api-key.
    expect(
      kimiInitialMode({ credentialPresent: true, credentialSynthetic: true })
    ).toBe("apikey")
    expect(kimiInitialMode({})).toBe("apikey")
  })
})
