import { beforeEach, describe, expect, it } from "vitest"

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
  beforeEach(() => {
    localStorage.clear()
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

  it("clamps maxFileBytesMb to at least 0.0625MB", () => {
    const request = toSearchFilesRequest("/repo", "needle", {
      ...CONTENT_SEARCH_DEFAULT_SETTINGS,
      maxFileBytesMb: 0.01,
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
