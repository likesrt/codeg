import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CONTENT_SEARCH_DEFAULT_SETTINGS,
  loadContentSearchSettings,
  parseCommaList,
  saveContentSearchSettings,
  toSearchFilesRequest,
} from "./content-search-settings"

describe("parseCommaList", () => {
  it("trims items and drops empty entries", () => {
    expect(parseCommaList(" ts, ,tsx,,  rs ")).toEqual(["ts", "tsx", "rs"])
  })
})

describe("content search settings persistence", () => {
  const originalLocalStorage = globalThis.localStorage

  beforeEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    })
    localStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    })
  })

  it("loads defaults when storage is empty", () => {
    expect(loadContentSearchSettings()).toEqual(CONTENT_SEARCH_DEFAULT_SETTINGS)
  })

  it("falls back to defaults when storage contains invalid JSON", () => {
    localStorage.setItem("codeg.contentSearch.settings", "{")

    expect(loadContentSearchSettings()).toEqual(CONTENT_SEARCH_DEFAULT_SETTINGS)
  })

  it("round-trips saved settings", () => {
    const settings = {
      searchDirsText: "src,src-tauri",
      includeExtensionsText: "ts,tsx,rs",
      excludeDirsText: ".git,target",
      excludeExtensionsText: "png,lock",
      maxResults: 250,
      maxFileBytesMb: 0.5,
    }

    saveContentSearchSettings(settings)

    expect(loadContentSearchSettings()).toEqual(settings)
  })

  it("ignores save when localStorage is unavailable", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: undefined,
    })

    expect(() => {
      saveContentSearchSettings(CONTENT_SEARCH_DEFAULT_SETTINGS)
    }).not.toThrow()
  })

  it("ignores save when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })

    expect(() => {
      saveContentSearchSettings(CONTENT_SEARCH_DEFAULT_SETTINGS)
    }).not.toThrow()
  })

  it("loads defaults when storage JSON is not an object", () => {
    localStorage.setItem("codeg.contentSearch.settings", "[]")

    expect(loadContentSearchSettings()).toEqual(CONTENT_SEARCH_DEFAULT_SETTINGS)
  })

  it("ignores stored fields with invalid types", () => {
    localStorage.setItem(
      "codeg.contentSearch.settings",
      JSON.stringify({
        searchDirsText: ["src"],
        includeExtensionsText: 7,
        excludeDirsText: null,
        excludeExtensionsText: false,
        maxResults: "250",
        maxFileBytesMb: Number.NaN,
      })
    )

    expect(loadContentSearchSettings()).toEqual(CONTENT_SEARCH_DEFAULT_SETTINGS)
  })
})

describe("toSearchFilesRequest", () => {
  it("clamps maxResults to 1000 and maxFileBytes to 10MB", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxResults: 5000,
      maxFileBytesMb: 20,
    })

    expect(request.maxResults).toBe(1000)
    expect(request.maxFileBytes).toBe(10 * 1024 * 1024)
  })

  it("clamps maxResults below 1 to the minimum", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxResults: 0,
    })

    expect(request.maxResults).toBe(1)
  })

  it("rounds maxResults to the nearest integer", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxResults: 1.6,
    })

    expect(request.maxResults).toBe(2)
  })

  it("treats non-finite maxResults as the minimum", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxResults: Number.NaN,
    })

    expect(request.maxResults).toBe(1)
  })

  it("rounds maxFileBytesMb to the nearest byte and clamps low values", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxFileBytesMb: 0.5,
    })

    expect(request.maxFileBytes).toBe(524288)
  })

  it("treats non-finite maxFileBytesMb as the minimum", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxFileBytesMb: Number.POSITIVE_INFINITY,
    })

    expect(request.maxFileBytes).toBe(64 * 1024)
  })

  it("maps comma-separated text fields to request arrays", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      searchDirsText: " src, src-tauri ",
      includeExtensionsText: " ts,tsx ",
      excludeDirsText: " .git, target ",
      excludeExtensionsText: " png, lock ",
      maxResults: 100,
      maxFileBytesMb: 2,
    })

    expect(request).toEqual({
      rootPath: "/repo",
      query: "needle",
      searchDirs: ["src", "src-tauri"],
      includeExtensions: ["ts", "tsx"],
      excludeDirs: [".git", "target"],
      excludeExtensions: ["png", "lock"],
      maxResults: 100,
      maxFileBytes: 2 * 1024 * 1024,
    })
  })
})
