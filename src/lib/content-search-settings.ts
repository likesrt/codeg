import type { SearchFilesRequest } from "./types"

const STORAGE_KEY = "codeg.contentSearch.settings"
const MAX_RESULTS_LIMIT = 1000
const BYTES_PER_MB = 1024 * 1024
const MAX_FILE_BYTES_LIMIT = 10 * BYTES_PER_MB
const MAX_FILE_BYTES_MB = MAX_FILE_BYTES_LIMIT / BYTES_PER_MB
const MIN_FILE_BYTES_MB = 0.0625

export interface ContentSearchSettings {
  searchDirsText: string
  includeExtensionsText: string
  excludeDirsText: string
  excludeExtensionsText: string
  maxResults: number
  maxFileBytesMb: number
}

export const CONTENT_SEARCH_DEFAULT_SETTINGS: ContentSearchSettings = {
  searchDirsText: ".",
  includeExtensionsText: "",
  excludeDirsText:
    ".git,node_modules,dist,build,.next,.turbo,target,coverage,__pycache__,.venv,venv",
  excludeExtensionsText:
    "png,jpg,jpeg,gif,webp,ico,pdf,zip,tar,gz,7z,rar,exe,dll,so,dylib,bin,lock",
  maxResults: 100,
  maxFileBytesMb: 2,
}

/**
 * Parses comma-separated user input into trimmed non-empty values.
 * @param text Raw comma-separated text from persisted settings or form fields.
 * @returns Ordered entries with whitespace-only and empty segments removed.
 * @remarks The function has no side effects and preserves duplicate entries.
 */
export function parseCommaList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * Loads persisted content search settings from browser localStorage.
 * @returns Stored settings merged over defaults, or defaults when unavailable.
 * @remarks Invalid JSON and non-browser storage errors fall back to defaults.
 */
export function loadContentSearchSettings(): ContentSearchSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return parseStoredSettings(stored)
  } catch {
    return { ...CONTENT_SEARCH_DEFAULT_SETTINGS }
  }
}

/**
 * Persists content search settings to browser localStorage.
 * @param settings Settings selected by the user for future searches.
 * @returns Nothing.
 * @remarks Storage quota or unavailable-storage errors are ignored safely.
 */
export function saveContentSearchSettings(
  settings: ContentSearchSettings
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 持久化只是用户体验增强；SSR、隐私模式或配额错误时应静默降级。
  }
}

/**
 * Converts UI settings into the backend content search request shape.
 * @param rootPath Workspace root directory sent to the backend search command.
 * @param query Search query text entered by the user.
 * @param settings Persisted or current content search settings.
 * @returns Request object with parsed lists and bounded numeric limits.
 * @remarks maxResults is capped at 1000 and file size at 0.0625MB..10MB.
 */
export function toSearchFilesRequest(
  rootPath: string,
  query: string,
  settings: ContentSearchSettings
): SearchFilesRequest {
  return {
    rootPath,
    query,
    searchDirs: parseCommaList(settings.searchDirsText),
    includeExtensions: parseCommaList(settings.includeExtensionsText),
    excludeDirs: parseCommaList(settings.excludeDirsText),
    excludeExtensions: parseCommaList(settings.excludeExtensionsText),
    maxResults: clampInteger(settings.maxResults, 1, MAX_RESULTS_LIMIT),
    maxFileBytes: toClampedFileBytes(settings.maxFileBytesMb),
  }
}

/**
 * Parses one localStorage payload into a full settings object.
 * @param stored Raw JSON string from localStorage, or null when absent.
 * @returns Defaults merged with valid stored fields.
 * @remarks Malformed JSON and non-object JSON intentionally return defaults.
 */
function parseStoredSettings(stored: string | null): ContentSearchSettings {
  if (!stored) {
    return { ...CONTENT_SEARCH_DEFAULT_SETTINGS }
  }

  try {
    const parsed: unknown = JSON.parse(stored)
    return mergeSettings(parsed)
  } catch {
    return { ...CONTENT_SEARCH_DEFAULT_SETTINGS }
  }
}

/**
 * Merges unknown parsed JSON over default settings when field types are valid.
 * @param value Parsed JSON value from persisted storage.
 * @returns A complete settings object with invalid fields ignored.
 * @remarks Type checks prevent corrupt storage from leaking into requests.
 */
function mergeSettings(value: unknown): ContentSearchSettings {
  if (!isRecord(value)) {
    return { ...CONTENT_SEARCH_DEFAULT_SETTINGS }
  }

  return {
    searchDirsText: readString(value, "searchDirsText"),
    includeExtensionsText: readString(value, "includeExtensionsText"),
    excludeDirsText: readString(value, "excludeDirsText"),
    excludeExtensionsText: readString(value, "excludeExtensionsText"),
    maxResults: readNumber(value, "maxResults"),
    maxFileBytesMb: readNumber(value, "maxFileBytesMb"),
  }
}

/**
 * Checks whether an unknown value can be read by string keys.
 * @param value Unknown value parsed from storage.
 * @returns True when the value is a non-null object record.
 * @remarks Arrays are accepted as records but unknown keys still fall back.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Reads a string setting with a default fallback.
 * @param record Parsed settings object.
 * @param key Setting key to read from the object.
 * @returns Stored string value or the default for that key.
 * @remarks Non-string values are ignored to tolerate old or corrupt storage.
 */
function readString(
  record: Record<string, unknown>,
  key: keyof ContentSearchSettings
): string {
  const value = record[key]
  const defaultValue = CONTENT_SEARCH_DEFAULT_SETTINGS[key]
  return typeof value === "string" ? value : String(defaultValue)
}

/**
 * Reads a numeric setting with a default fallback.
 * @param record Parsed settings object.
 * @param key Numeric setting key to read from the object.
 * @returns Stored finite number or the default for that key.
 * @remarks NaN and Infinity are ignored because they cannot form safe limits.
 */
function readNumber(
  record: Record<string, unknown>,
  key: keyof ContentSearchSettings
): number {
  const value = record[key]
  const defaultValue = CONTENT_SEARCH_DEFAULT_SETTINGS[key]
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number(defaultValue)
}

/**
 * Clamps a numeric value to an inclusive integer range.
 * @param value Candidate number from user settings.
 * @param min Smallest allowed integer.
 * @param max Largest allowed integer.
 * @returns Rounded integer constrained to the provided range.
 * @remarks Non-finite values use the minimum to avoid unsafe requests.
 */
function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.min(Math.max(Math.round(value), min), max)
}

/**
 * Converts a megabyte value into a bounded byte limit.
 * @param megabytes File size limit in megabytes from settings.
 * @returns Byte limit clamped between 64KB and 10MB.
 * @remarks The lower bound prevents zero-byte scans from disabling all files.
 */
function toClampedFileBytes(megabytes: number): number {
  if (!Number.isFinite(megabytes)) {
    return MIN_FILE_BYTES_MB * BYTES_PER_MB
  }

  const clamped = Math.min(
    Math.max(megabytes, MIN_FILE_BYTES_MB),
    MAX_FILE_BYTES_MB
  )
  return Math.round(Math.min(clamped * BYTES_PER_MB, MAX_FILE_BYTES_LIMIT))
}
