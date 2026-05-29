"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import type * as React from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { useTabContext } from "@/contexts/tab-context"
import { useWorkspaceContext } from "@/contexts/workspace-context"
import { listAllConversations, searchFiles } from "@/lib/api"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
  SearchFileMatch,
  SearchFilesResponse,
} from "@/lib/types"
import {
  loadContentSearchSettings,
  saveContentSearchSettings,
  toSearchFilesRequest,
  type ContentSearchSettings,
} from "@/lib/content-search-settings"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { AGENT_LABELS, compareAgentType } from "@/lib/types"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type SearchTab = "conversations" | "files" | "content"

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ContentSearchState {
  results: SearchFileMatch[]
  searching: boolean
  error: string | null
  truncated: boolean
  submittedQuery: string | null
}

interface ContentSettingsPanelProps {
  settings: ContentSearchSettings
  onChange: (settings: ContentSearchSettings) => void
}

interface ContentResultsProps {
  activeTab: SearchTab
  state: ContentSearchState
  query: string
  t: ReturnType<typeof useTranslations>
  onSelect: (match: SearchFileMatch, query: string) => void
}

/**
 * Renders the folder-aware search command dialog.
 * @param props Dialog open state and close callback from the title bar.
 * @returns Command dialog with conversation, filename, and content search tabs.
 * @remarks Content search is deliberately manual to avoid expensive scans.
 */
export function SearchCommandDialog({
  open,
  onOpenChange,
}: SearchCommandDialogProps) {
  const model = useSearchDialogModel(open, onOpenChange)
  return <SearchCommandDialogView model={model} />
}

/**
 * Builds all state and callbacks needed by the search dialog view.
 * @param open Whether the dialog is currently visible.
 * @param onOpenChange Callback used to close the dialog after selection.
 * @returns View model containing data, actions, and translated labels.
 * @remarks Effects are centralized here so render helpers stay small.
 */
function useSearchDialogModel(
  open: boolean,
  onOpenChange: (open: boolean) => void
) {
  const base = useBaseSearchState()
  const conversations = useConversationSearch(base, open)
  const files = useFileSearch(base.activeTab, base.folderPath, base.query)
  const content = useContentSearch(base.folderPath, base.query)
  const actions = useSearchActions(base, conversations, content, onOpenChange)
  useResetOnClose(open, base, conversations, files, content)
  return {
    ...base,
    ...conversations,
    ...files,
    ...content,
    ...actions,
    open,
    onOpenChange,
  }
}

/**
 * Creates shared dialog state and translated metadata.
 * @returns Base state used by all search tabs.
 * @remarks Locale selection only affects date formatting in conversation rows.
 */
function useBaseSearchState() {
  const t = useTranslations("Folder.search")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const { activeFolder: folder, activeFolderId } = useActiveFolder()
  const { conversations: allConversations } = useAppWorkspace()
  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  const [query, setQuery] = useState("")
  const folderId = activeFolderId ?? 0
  const folderPath = folder?.path ?? ""
  const conversations = useMemo(
    () => getFolderConversations(allConversations, activeFolderId),
    [allConversations, activeFolderId]
  )
  return {
    t,
    dateFnsLocale,
    folder,
    folderId,
    folderPath,
    conversations,
    activeTab,
    setActiveTab,
    query,
    setQuery,
  }
}

/**
 * Filters workspace conversations to the active folder.
 * @param conversations All conversations loaded in the workspace.
 * @param activeFolderId Current folder id, or null when no folder is active.
 * @returns Conversations belonging to the active folder only.
 * @remarks Null active folder returns an empty list to avoid global leakage.
 */
function getFolderConversations(
  conversations: DbConversationSummary[],
  activeFolderId: number | null
): DbConversationSummary[] {
  if (activeFolderId == null) return []
  return conversations.filter((c) => c.folder_id === activeFolderId)
}

/**
 * Manages debounced conversation search state.
 * @param base Shared dialog state from the active folder and query.
 * @param open Whether the dialog is visible.
 * @returns Conversation results, filters, and reset helpers.
 * @remarks Searching remains debounced only for the conversations tab.
 */
function useConversationSearch(
  base: ReturnType<typeof useBaseSearchState>,
  open: boolean
) {
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const availableAgents = getAvailableAgents(base.conversations)
  const doSearch = useConversationSearchCallback(
    base.folderId,
    setResults,
    setSearching
  )
  useConversationSearchEffect(base, agentFilter, doSearch, debounceRef)
  return {
    agentFilter,
    setAgentFilter,
    results,
    setResults,
    searching,
    setSearching,
    availableAgents,
    open,
  }
}

/**
 * Returns sorted agent types present in the active folder.
 * @param conversations Active-folder conversation summaries.
 * @returns Unique agent types sorted by project display order.
 * @remarks Used to hide the filter bar when only one agent is present.
 */
function getAvailableAgents(
  conversations: DbConversationSummary[]
): AgentType[] {
  return Array.from(new Set(conversations.map((c) => c.agent_type))).sort(
    compareAgentType
  )
}

/**
 * Creates the async conversation search callback.
 * @param folderId Active folder id used to scope backend search.
 * @param setResults Setter for conversation results.
 * @param setSearching Setter for the loading flag.
 * @returns Callback that searches conversations by text and agent.
 * @remarks Empty text with no agent clears results without a backend request.
 */
function useConversationSearchCallback(
  folderId: number,
  setResults: (results: DbConversationSummary[]) => void,
  setSearching: (searching: boolean) => void
) {
  return useCallback(
    async (q: string, agent: AgentType | null) => {
      if (!q.trim() && !agent)
        return clearConversationResults(setResults, setSearching)
      setSearching(true)
      try {
        const data = await listAllConversations({
          folder_ids: folderId > 0 ? [folderId] : null,
          search: q.trim() || null,
          agent_type: agent,
        })
        setResults(data)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    },
    [folderId, setResults, setSearching]
  )
}

/**
 * Clears conversation search output and loading state.
 * @param setResults Setter for conversation results.
 * @param setSearching Setter for the loading flag.
 * @returns Nothing.
 * @remarks This avoids backend calls for the empty default state.
 */
function clearConversationResults(
  setResults: (results: DbConversationSummary[]) => void,
  setSearching: (searching: boolean) => void
): void {
  setResults([])
  setSearching(false)
}

/**
 * Runs the debounced conversation search effect.
 * @param base Shared dialog state containing active tab and query.
 * @param agentFilter Current agent filter.
 * @param doSearch Backend-backed conversation search callback.
 * @param debounceRef Mutable timeout holder for cancellation.
 * @returns Nothing.
 */
function useConversationSearchEffect(
  base: ReturnType<typeof useBaseSearchState>,
  agentFilter: AgentType | null,
  doSearch: (q: string, agent: AgentType | null) => Promise<void>,
  debounceRef: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>
): void {
  useEffect(() => {
    if (base.activeTab !== "conversations") return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(
      () => void doSearch(base.query, agentFilter),
      300
    )
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [base.query, agentFilter, doSearch, base.activeTab, debounceRef])
}

/**
 * Loads and filters the file tree for filename search.
 * @param activeTab Current search tab.
 * @param folderPath Active folder path used by the file-tree hook.
 * @param query Current search query.
 * @returns File-tree loading state, reset callback, and filtered rows.
 * @remarks File tree is only enabled while the files tab is active.
 */
function useFileSearch(
  activeTab: SearchTab,
  folderPath: string,
  query: string
) {
  const {
    allFiles,
    loading: filesLoading,
    reset: resetFileTree,
  } = useFileTree({
    folderPath: folderPath || undefined,
    enabled: activeTab === "files",
  })
  const filteredFiles = useMemo(
    () => filterFiles(allFiles, query),
    [allFiles, query]
  )
  return { allFiles, filesLoading, resetFileTree, filteredFiles }
}

/**
 * Filters flat file entries against the current query.
 * @param allFiles Flat file entries from the active workspace.
 * @param query Filename or path query.
 * @returns Up to 100 matching entries.
 * @remarks Empty query returns the first 100 entries for browse-like behavior.
 */
function filterFiles(
  allFiles: FlatFileEntry[],
  query: string
): FlatFileEntry[] {
  const trimmed = query.trim().toLowerCase()
  const results: FlatFileEntry[] = []
  for (const file of allFiles) {
    if (results.length >= 100) break
    if (!trimmed || fileMatchesQuery(file, trimmed)) results.push(file)
  }
  return results
}

/**
 * Checks whether one flat file entry matches a lowercase filename query.
 * @param file Flat file entry from the workspace tree.
 * @param lowerQuery Trimmed lowercase query text.
 * @returns True when the file name or relative path contains the query.
 * @remarks The caller handles empty queries so this only checks real filters.
 */
function fileMatchesQuery(file: FlatFileEntry, lowerQuery: string): boolean {
  return (
    file.lowerName.includes(lowerQuery) || file.lowerPath.includes(lowerQuery)
  )
}

/**
 * Manages manual content-search settings and results.
 * @param folderPath Active workspace root path.
 * @param query Current search query.
 * @returns Content settings, results, flags, and search callbacks.
 * @remarks Backend search is only triggered by Enter or the search button.
 */
function useContentSearch(folderPath: string, query: string) {
  const store = useContentSearchStore()
  const runContentSearch = useContentSearchRunner(
    folderPath,
    query,
    store.contentSettings,
    store.contentState.searching,
    store.setContentState,
    store.contentRequestRef
  )
  useInvalidateContentSearchOnQueryChange(query, store.invalidateContentSearch)
  return { ...store, runContentSearch }
}

/**
 * Creates state holders and reset helpers for manual content search.
 * @returns Content-search state, settings state, and invalidation callbacks.
 * @remarks The request id lives with state so all callbacks cancel stale responses.
 */
function useContentSearchStore() {
  const [contentSettings, setContentSettings] = useState(
    loadContentSearchSettings
  )
  const [showContentSettings, setShowContentSettings] = useState(false)
  const [contentState, setContentState] = useState<ContentSearchState>(
    createEmptyContentState
  )
  const contentRequestRef = useRef(0)
  const resetContentSearch = useResetContentSearch(
    setContentState,
    contentRequestRef
  )
  const invalidateContentSearch = useInvalidateContentSearch(
    setContentState,
    contentRequestRef
  )
  const updateContentSettings = useUpdateContentSettings(setContentSettings)
  return {
    contentSettings,
    updateContentSettings,
    showContentSettings,
    setShowContentSettings,
    contentState,
    setContentState,
    contentRequestRef,
    resetContentSearch,
    invalidateContentSearch,
  }
}

/**
 * Creates a reset callback that cancels and clears content search state.
 * @param setState Setter for content-search state.
 * @param requestRef Monotonic request id used to invalidate pending responses.
 * @returns Callback that resets visible and pending content-search data.
 * @remarks Incrementing the id prevents late backend responses from committing.
 */
function useResetContentSearch(
  setState: React.Dispatch<React.SetStateAction<ContentSearchState>>,
  requestRef: React.MutableRefObject<number>
) {
  return useCallback(() => {
    requestRef.current += 1
    setState((current) =>
      isEmptyContentState(current) ? current : createEmptyContentState()
    )
  }, [setState, requestRef])
}

/**
 * Creates a query-change invalidation callback for content search state.
 * @param setState Setter for content-search state.
 * @param requestRef Monotonic request id used to invalidate pending responses.
 * @returns Callback that clears stale content results for edited queries.
 * @remarks Idle empty state is preserved to avoid unnecessary renders.
 */
function useInvalidateContentSearch(
  setState: React.Dispatch<React.SetStateAction<ContentSearchState>>,
  requestRef: React.MutableRefObject<number>
) {
  return useCallback(() => {
    requestRef.current += 1
    setState((current) =>
      isIdleEmptyContentState(current) ? current : createEmptyContentState()
    )
  }, [setState, requestRef])
}

/**
 * Creates the empty content-search state object.
 * @returns Initial content search result state.
 * @remarks A fresh object avoids accidental state sharing between resets.
 */
function createEmptyContentState(): ContentSearchState {
  return {
    results: [],
    searching: false,
    error: null,
    truncated: false,
    submittedQuery: null,
  }
}

/**
 * Checks whether content-search state is already at its empty baseline.
 * @param state Current content-search state from React state.
 * @returns True when a reset would not change any visible content state.
 * @remarks Used to avoid repeated state updates while the dialog is closed.
 */
function isEmptyContentState(state: ContentSearchState): boolean {
  return (
    state.results.length === 0 &&
    !state.searching &&
    state.error === null &&
    !state.truncated &&
    state.submittedQuery === null
  )
}

/**
 * Checks whether content-search state has no visible idle data.
 * @param state Current content-search state from React state.
 * @returns True when invalidating the current query would not alter visible output.
 * @remarks In-flight searches are not idle and must still be cancelled visibly.
 */
function isIdleEmptyContentState(state: ContentSearchState): boolean {
  return isEmptyContentState(state) && !state.searching
}

/**
 * Creates the manual backend content-search runner.
 * @param folderPath Workspace root sent to the backend.
 * @param query Current query text.
 * @param settings Current content search settings.
 * @param searching Whether another content request is currently in flight.
 * @param setState Setter for content-search state.
 * @param requestRef Monotonic request id used to ignore stale responses.
 * @returns Function that executes one content search when the query is non-empty.
 * @remarks Blank, folderless, or already-pending searches never reach the backend.
 */
function useContentSearchRunner(
  folderPath: string,
  query: string,
  settings: ContentSearchSettings,
  searching: boolean,
  setState: React.Dispatch<React.SetStateAction<ContentSearchState>>,
  requestRef: React.MutableRefObject<number>
) {
  return useCallback(async () => {
    const trimmed = query.trim()
    if (searching) return
    if (!trimmed || !folderPath) return setState(createEmptyContentState())
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setState(createSearchingContentState(trimmed))
    try {
      const response = await searchFiles(
        toSearchFilesRequest(folderPath, trimmed, settings)
      )
      setContentSearchSuccess(
        setState,
        requestRef,
        requestId,
        trimmed,
        response
      )
    } catch (error) {
      setContentSearchError(setState, requestRef, requestId, trimmed, error)
    }
  }, [folderPath, query, settings, searching, setState, requestRef])
}

/**
 * Creates the loading state for a submitted content query.
 * @param submittedQuery Trimmed query passed to the backend.
 * @returns Loading state that records the query owning future results.
 * @remarks The submitted query is used to prevent display under edited input.
 */
function createSearchingContentState(
  submittedQuery: string
): ContentSearchState {
  return {
    results: [],
    searching: true,
    error: null,
    truncated: false,
    submittedQuery,
  }
}

/**
 * Commits a successful content-search response when it is still current.
 * @param setState Setter for content-search state.
 * @param requestRef Monotonic request id used to ignore stale responses.
 * @param requestId Request id captured when the backend call started.
 * @param submittedQuery Trimmed query that produced the response.
 * @param response Backend response containing matches and metadata.
 * @returns Nothing.
 */
function setContentSearchSuccess(
  setState: React.Dispatch<React.SetStateAction<ContentSearchState>>,
  requestRef: React.MutableRefObject<number>,
  requestId: number,
  submittedQuery: string,
  response: SearchFilesResponse
): void {
  if (requestRef.current !== requestId) return
  setState((current) =>
    shouldCommitContentResponse(current, submittedQuery)
      ? toContentSuccessState(response, submittedQuery)
      : current
  )
}

/**
 * Commits a failed content-search response when it is still current.
 * @param setState Setter for content-search state.
 * @param requestRef Monotonic request id used to ignore stale responses.
 * @param requestId Request id captured when the backend call started.
 * @param submittedQuery Trimmed query that produced the error.
 * @param error Unknown thrown value from the content search request.
 * @returns Nothing.
 */
function setContentSearchError(
  setState: React.Dispatch<React.SetStateAction<ContentSearchState>>,
  requestRef: React.MutableRefObject<number>,
  requestId: number,
  submittedQuery: string,
  error: unknown
): void {
  if (requestRef.current !== requestId) return
  setState((current) =>
    shouldCommitContentResponse(current, submittedQuery)
      ? toContentErrorState(error, submittedQuery)
      : current
  )
}

/**
 * Checks whether a content response still belongs to the visible state.
 * @param current Current content-search state before committing async data.
 * @param submittedQuery Query captured when the request started.
 * @returns True when the state still represents the same in-flight query.
 * @remarks Query edits and resets clear submittedQuery before stale responses land.
 */
function shouldCommitContentResponse(
  current: ContentSearchState,
  submittedQuery: string
): boolean {
  return current.searching && current.submittedQuery === submittedQuery
}

/**
 * Invalidates content search results whenever the input query changes.
 * @param query Current command input value.
 * @param invalidateContentSearch Callback that cancels pending and visible results.
 * @returns Nothing.
 * @remarks Content search stays manual; this only prevents stale query/result pairing.
 */
function useInvalidateContentSearchOnQueryChange(
  query: string,
  invalidateContentSearch: () => void
): void {
  const previousQueryRef = useRef(query)
  useEffect(() => {
    const previous = previousQueryRef.current
    previousQueryRef.current = query
    if (previous !== query) invalidateContentSearch()
  }, [query, invalidateContentSearch])
}

/**
 * Converts a successful backend response into renderable content-search state.
 * @param response Backend response containing matches and truncation metadata.
 * @returns Non-loading state with results and no error message.
 * @remarks scannedFiles and skippedFiles are intentionally not displayed here.
 */
function toContentSuccessState(
  response: SearchFilesResponse,
  submittedQuery: string
): ContentSearchState {
  return {
    results: response.results,
    searching: false,
    error: null,
    truncated: response.truncated,
    submittedQuery,
  }
}

/**
 * Converts a failed backend request into renderable content-search state.
 * @param error Unknown thrown value from the content search request.
 * @returns Non-loading state with no results and a displayable error message.
 * @remarks Stale request filtering happens before this helper is called.
 */
function toContentErrorState(
  error: unknown,
  submittedQuery: string
): ContentSearchState {
  return {
    results: [],
    searching: false,
    error: getErrorMessage(error),
    truncated: false,
    submittedQuery,
  }
}

/**
 * Normalizes unknown thrown values into displayable text.
 * @param error Unknown value caught from a backend request.
 * @returns Human-readable error message.
 * @remarks Non-Error values fall back to a stable generic message.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Search failed"
}

/**
 * Creates a settings updater that also persists to localStorage.
 * @param setSettings React state setter for content settings.
 * @returns Callback accepting a complete settings object.
 * @remarks Persistence errors are swallowed by saveContentSearchSettings.
 */
function useUpdateContentSettings(
  setSettings: (settings: ContentSearchSettings) => void
) {
  return useCallback(
    (settings: ContentSearchSettings) => {
      setSettings(settings)
      saveContentSearchSettings(settings)
    },
    [setSettings]
  )
}

/**
 * Builds selection and keyboard callbacks for all tabs.
 * @param base Shared dialog state.
 * @param conversations Conversation search state.
 * @param content Content search state.
 * @param onOpenChange Dialog open-state callback.
 * @returns Action callbacks consumed by the view.
 * @remarks File and content selections reveal parent folders before opening.
 */
function useSearchActions(
  base: ReturnType<typeof useBaseSearchState>,
  conversations: ReturnType<typeof useConversationSearch>,
  content: ReturnType<typeof useContentSearch>,
  onOpenChange: (open: boolean) => void
) {
  const { openTab } = useTabContext()
  const { openFilePreview } = useWorkspaceContext()
  const { revealInFileTree } = useAuxPanelContext()
  const handleSelectConversation = useSelectConversation(openTab, onOpenChange)
  const handleSelectFile = useSelectFile(
    revealInFileTree,
    openFilePreview,
    onOpenChange
  )
  const handleSelectContentResult = useSelectContentResult(
    revealInFileTree,
    openFilePreview,
    onOpenChange
  )
  const handleInputKeyDown = useContentEnterHandler(
    base.activeTab,
    content.runContentSearch
  )
  return {
    handleSelectConversation,
    handleSelectFile,
    handleSelectContentResult,
    handleInputKeyDown,
  }
}

/**
 * Creates a conversation selection callback.
 * @param openTab Function that activates a conversation tab.
 * @param onOpenChange Dialog open-state callback.
 * @returns Callback for selecting a conversation row.
 * @remarks The dialog closes only after routing to the selected conversation.
 */
function useSelectConversation(
  openTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType,
    focus?: boolean
  ) => void,
  onOpenChange: (open: boolean) => void
) {
  return useCallback(
    (conv: DbConversationSummary) => {
      openTab(conv.folder_id, conv.id, conv.agent_type, true)
      onOpenChange(false)
    },
    [openTab, onOpenChange]
  )
}

/**
 * Creates a file selection callback.
 * @param revealInFileTree Function that focuses a directory in the tree.
 * @param openFilePreview Function that opens file preview tabs.
 * @param onOpenChange Dialog open-state callback.
 * @returns Callback for selecting a file-tree row.
 * @remarks Directories are revealed without opening a preview tab.
 */
function useSelectFile(
  revealInFileTree: (path: string) => void,
  openFilePreview: (path: string) => Promise<void>,
  onOpenChange: (open: boolean) => void
) {
  return useCallback(
    (entry: FlatFileEntry) => {
      if (entry.kind === "dir") revealInFileTree(entry.relativePath)
      else
        openFileWithReveal(
          entry.relativePath,
          revealInFileTree,
          openFilePreview
        )
      onOpenChange(false)
    },
    [revealInFileTree, openFilePreview, onOpenChange]
  )
}

/**
 * Opens a file after revealing its parent directory.
 * @param path Relative file path to reveal and open.
 * @param revealInFileTree Function that focuses a directory in the tree.
 * @param openFilePreview Function that opens file preview tabs.
 * @returns Nothing.
 * @remarks Parent reveal is skipped for root-level files.
 */
function openFileWithReveal(
  path: string,
  revealInFileTree: (path: string) => void,
  openFilePreview: (path: string) => Promise<void>
): void {
  const parent = getParentPath(path)
  if (parent) revealInFileTree(parent)
  void openFilePreview(path)
}

/**
 * Creates a content-result selection callback.
 * @param revealInFileTree Function that focuses a directory in the tree.
 * @param openFilePreview Function that opens file preview tabs.
 * @param onOpenChange Dialog open-state callback.
 * @returns Callback for selecting a content-search row.
 * @remarks The query is forwarded for Task 5 Monaco find integration.
 */
function useSelectContentResult(
  revealInFileTree: (path: string) => void,
  openFilePreview: (
    path: string,
    options?: { line?: number; searchQuery?: string }
  ) => Promise<void>,
  onOpenChange: (open: boolean) => void
) {
  return useCallback(
    (match: SearchFileMatch, query: string) => {
      const parent = getParentPath(match.path)
      if (parent) revealInFileTree(parent)
      void openFilePreview(match.path, {
        line: match.lineNumber,
        searchQuery: query.trim(),
      })
      onOpenChange(false)
    },
    [revealInFileTree, openFilePreview, onOpenChange]
  )
}

/**
 * Returns the parent directory for a relative path.
 * @param path File or directory path using slash separators.
 * @returns Parent path, or an empty string for root-level paths.
 * @remarks The caller decides whether an empty parent should be revealed.
 */
function getParentPath(path: string): string {
  const lastSlash = path.lastIndexOf("/")
  return lastSlash > 0 ? path.slice(0, lastSlash) : ""
}

/**
 * Creates an Enter-key handler for manual content search.
 * @param activeTab Current search tab.
 * @param runContentSearch Function that performs the backend content search.
 * @returns Keyboard handler for the command input.
 * @remarks Enter is ignored outside the content tab to preserve existing tabs.
 */
function useContentEnterHandler(
  activeTab: SearchTab,
  runContentSearch: () => Promise<void>
) {
  return useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (activeTab !== "content" || event.key !== "Enter") return
      event.preventDefault()
      void runContentSearch()
    },
    [activeTab, runContentSearch]
  )
}

/**
 * Resets dialog state when it closes.
 * @param open Whether the dialog is currently visible.
 * @param base Shared tab and query state.
 * @param conversations Conversation search state setters.
 * @param files File-search reset helper.
 * @param content Content-search reset helper.
 * @returns Nothing.
 */
function useResetOnClose(
  open: boolean,
  base: ReturnType<typeof useBaseSearchState>,
  conversations: ReturnType<typeof useConversationSearch>,
  files: ReturnType<typeof useFileSearch>,
  content: ReturnType<typeof useContentSearch>
): void {
  const previousOpenRef = useRef(open)
  const resetDialogState = useResetDialogState(
    base,
    conversations,
    files,
    content
  )
  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = open
    if (open || !wasOpen) return
    resetDialogState()
  }, [open, resetDialogState])
}

/**
 * Creates a callback that restores dialog state to its closed baseline.
 * @param base Shared tab and query state.
 * @param conversations Conversation search state setters.
 * @param files File-search reset helper.
 * @param content Content-search reset helper.
 * @returns Callback used once when the dialog transitions from open to closed.
 * @remarks The callback is shared by the close effect to keep dependency lists small.
 */
function useResetDialogState(
  base: ReturnType<typeof useBaseSearchState>,
  conversations: ReturnType<typeof useConversationSearch>,
  files: ReturnType<typeof useFileSearch>,
  content: ReturnType<typeof useContentSearch>
) {
  const { setQuery, setActiveTab } = base
  const { setAgentFilter, setResults } = conversations
  const { resetFileTree } = files
  const { resetContentSearch } = content
  return useCallback(() => {
    setQuery("")
    setAgentFilter(null)
    setResults([])
    setActiveTab("conversations")
    resetFileTree()
    resetContentSearch()
  }, [
    setQuery,
    setAgentFilter,
    setResults,
    setActiveTab,
    resetFileTree,
    resetContentSearch,
  ])
}

/**
 * Renders the complete dialog from a prepared view model.
 * @param props View model returned by useSearchDialogModel.
 * @returns Dialog JSX.
 * @remarks This component intentionally contains no business logic.
 */
function SearchCommandDialogView({
  model,
}: {
  model: ReturnType<typeof useSearchDialogModel>
}) {
  const placeholder = getSearchPlaceholder(model.activeTab, model.t)
  return (
    <CommandDialog
      title={getDialogTitle(model)}
      open={model.open}
      onOpenChange={model.onOpenChange}
      shouldFilter={model.activeTab === "conversations"}
    >
      <FolderHeader folder={model.folder} t={model.t} />
      <SearchTabs
        activeTab={model.activeTab}
        setActiveTab={model.setActiveTab}
        t={model.t}
      />
      <CommandInput
        placeholder={placeholder}
        value={model.query}
        onValueChange={model.setQuery}
        onKeyDown={model.handleInputKeyDown}
      />
      <ConversationFilters model={model} />
      <ContentToolbar model={model} />
      <CommandList className="min-h-96">
        <ConversationResults model={model} />
        <FileResults model={model} />
        <ContentResults
          activeTab={model.activeTab}
          state={model.contentState}
          query={model.query}
          t={model.t}
          onSelect={model.handleSelectContentResult}
        />
      </CommandList>
    </CommandDialog>
  )
}

/**
 * Computes the dialog title from current folder context.
 * @param model Search dialog view model.
 * @returns Localized dialog title.
 * @remarks Folderless mode uses the generic search title.
 */
function getDialogTitle(
  model: ReturnType<typeof useSearchDialogModel>
): string {
  return model.folder
    ? model.t("dialogTitleWithFolder", { name: model.folder.name })
    : model.t("dialogTitle")
}

/**
 * Selects the command input placeholder for the active tab.
 * @param activeTab Current search tab.
 * @param t Translation function for Folder.search.
 * @returns Localized placeholder text.
 * @remarks Content tab uses a distinct text to communicate file-body search.
 */
function getSearchPlaceholder(
  activeTab: SearchTab,
  t: ReturnType<typeof useTranslations>
): string {
  if (activeTab === "conversations") return t("placeholder")
  return activeTab === "files" ? t("filePlaceholder") : t("contentPlaceholder")
}

/**
 * Renders the active folder header above tabs.
 * @param props Folder and translation function.
 * @returns Header JSX or null when no folder is active.
 * @remarks The header is informational and does not affect search scope.
 */
function FolderHeader({
  folder,
  t,
}: {
  folder: { name: string } | null | undefined
  t: ReturnType<typeof useTranslations>
}) {
  if (!folder) return null
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2.5">
      <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
      <span className="text-sm font-medium truncate">
        {t("dialogTitleWithFolder", { name: folder.name })}
      </span>
    </div>
  )
}

/**
 * Renders the three search tabs.
 * @param props Current tab, setter, and translations.
 * @returns Tab button row.
 * @remarks Buttons share markup through SearchTabButton for consistent styling.
 */
function SearchTabs({
  activeTab,
  setActiveTab,
  t,
}: {
  activeTab: SearchTab
  setActiveTab: (tab: SearchTab) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <div className="flex items-center gap-0 border-b px-3">
      <SearchTabButton
        tab="conversations"
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        label={t("tabConversations")}
      />
      <SearchTabButton
        tab="files"
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        label={t("tabFiles")}
      />
      <SearchTabButton
        tab="content"
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        label={t("tabContent")}
      />
    </div>
  )
}

/**
 * Renders one search tab button.
 * @param props Tab identity, active tab, setter, and label.
 * @returns Button JSX.
 * @remarks The underline is visual only; state lives in the parent.
 */
function SearchTabButton({
  tab,
  activeTab,
  setActiveTab,
  label,
}: {
  tab: SearchTab
  activeTab: SearchTab
  setActiveTab: (tab: SearchTab) => void
  label: string
}) {
  const active = activeTab === tab
  return (
    <button
      onClick={() => setActiveTab(tab)}
      className={cn(
        "relative h-9 px-3 text-sm font-medium transition-colors",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      {active && (
        <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
      )}
    </button>
  )
}

/**
 * Renders agent filters for the conversations tab.
 * @param props Search dialog view model.
 * @returns Filter buttons or null.
 * @remarks Hidden unless more than one agent exists in the active folder.
 */
function ConversationFilters({
  model,
}: {
  model: ReturnType<typeof useSearchDialogModel>
}) {
  if (model.activeTab !== "conversations" || model.availableAgents.length <= 1)
    return null
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b">
      <AgentFilterButton
        active={model.agentFilter === null}
        onClick={() => model.setAgentFilter(null)}
        label={model.t("allAgents")}
      />
      {model.availableAgents.map((at) => (
        <AgentFilterButton
          key={at}
          active={model.agentFilter === at}
          onClick={() => model.setAgentFilter(at)}
          label={AGENT_LABELS[at]}
          agentType={at}
        />
      ))}
    </div>
  )
}

/**
 * Renders one agent filter button.
 * @param props Active state, click callback, label, and optional agent icon.
 * @returns Button JSX.
 * @remarks Agent icon is omitted for the catch-all filter.
 */
function AgentFilterButton({
  active,
  onClick,
  label,
  agentType,
}: {
  active: boolean
  onClick: () => void
  label: string
  agentType?: AgentType
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {agentType && <AgentIcon agentType={agentType} className="w-3.5 h-3.5" />}
      {label}
    </button>
  )
}

/**
 * Renders manual content-search controls and settings.
 * @param props Search dialog view model.
 * @returns Toolbar JSX or null outside the content tab.
 * @remarks The search button is the primary trigger for backend scans.
 */
function ContentToolbar({
  model,
}: {
  model: ReturnType<typeof useSearchDialogModel>
}) {
  if (model.activeTab !== "content") return null
  return (
    <div className="space-y-2 border-b px-3 py-2">
      <ContentToolbarButtons model={model} />
      {model.showContentSettings && (
        <ContentSettingsPanel
          settings={model.contentSettings}
          onChange={model.updateContentSettings}
        />
      )}
    </div>
  )
}

/**
 * Renders content-search action buttons.
 * @param props Search dialog view model with labels and content actions.
 * @returns Button row for search execution and settings visibility.
 * @remarks The search button mirrors runner guards for pending and invalid input.
 */
function ContentToolbarButtons({
  model,
}: {
  model: ReturnType<typeof useSearchDialogModel>
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        disabled={isContentSearchButtonDisabled(model)}
        onClick={() => void model.runContentSearch()}
      >
        {model.t("searchContent")}
      </Button>
      <ContentSettingsToggle model={model} />
    </div>
  )
}

/**
 * Renders the settings-panel visibility toggle.
 * @param props Search dialog view model with settings visibility state.
 * @returns Ghost button that toggles content-search settings.
 * @remarks State lives in the parent hook so closing the dialog can reset it later.
 */
function ContentSettingsToggle({
  model,
}: {
  model: ReturnType<typeof useSearchDialogModel>
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => model.setShowContentSettings(!model.showContentSettings)}
    >
      {model.showContentSettings
        ? model.t("hideContentSettings")
        : model.t("showContentSettings")}
    </Button>
  )
}

/**
 * Determines whether the manual content search button can be triggered.
 * @param model Search dialog view model with query, folder, and loading state.
 * @returns True when clicking would be duplicate or invalid.
 * @remarks Disabled states prevent repeated in-flight backend scans.
 */
function isContentSearchButtonDisabled(
  model: ReturnType<typeof useSearchDialogModel>
): boolean {
  return (
    model.contentState.searching || !model.query.trim() || !model.folderPath
  )
}

/**
 * Renders editable content-search settings.
 * @param props Current settings and complete-settings change callback.
 * @returns Settings form JSX.
 * @remarks Comma text is kept raw until converted by toSearchFilesRequest.
 */
function ContentSettingsPanel({
  settings,
  onChange,
}: ContentSettingsPanelProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <SettingInput
        labelKey="searchDirs"
        field="searchDirsText"
        settings={settings}
        onChange={onChange}
      />
      <SettingInput
        labelKey="includeExtensions"
        field="includeExtensionsText"
        settings={settings}
        onChange={onChange}
      />
      <SettingInput
        labelKey="excludeDirs"
        field="excludeDirsText"
        settings={settings}
        onChange={onChange}
      />
      <SettingInput
        labelKey="excludeExtensions"
        field="excludeExtensionsText"
        settings={settings}
        onChange={onChange}
      />
      <NumericSettingInput
        labelKey="maxResults"
        field="maxResults"
        settings={settings}
        onChange={onChange}
      />
      <NumericSettingInput
        labelKey="maxFileBytesMb"
        field="maxFileBytesMb"
        settings={settings}
        onChange={onChange}
      />
    </div>
  )
}

/**
 * Renders a text setting input.
 * @param props Setting key, label key, current settings, and updater.
 * @returns Labeled input JSX.
 * @remarks The field is stored as typed to preserve comma-separated intent.
 */
function SettingInput({
  labelKey,
  field,
  settings,
  onChange,
}: {
  labelKey: keyof ContentSearchLabels
  field: keyof Pick<
    ContentSearchSettings,
    | "searchDirsText"
    | "includeExtensionsText"
    | "excludeDirsText"
    | "excludeExtensionsText"
  >
  settings: ContentSearchSettings
  onChange: (settings: ContentSearchSettings) => void
}) {
  const t = useTranslations("Folder.search")
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{t(labelKey)}</span>
      <Input
        value={settings[field]}
        onChange={(event) =>
          onChange({ ...settings, [field]: event.target.value })
        }
      />
    </label>
  )
}

/**
 * Renders a numeric content-search setting input.
 * @param props Numeric setting key, label key, current settings, and updater.
 * @returns Labeled number input JSX.
 * @remarks Invalid numeric text is held as zero until request clamping applies.
 */
function NumericSettingInput({
  labelKey,
  field,
  settings,
  onChange,
}: {
  labelKey: keyof ContentSearchLabels
  field: keyof Pick<ContentSearchSettings, "maxResults" | "maxFileBytesMb">
  settings: ContentSearchSettings
  onChange: (settings: ContentSearchSettings) => void
}) {
  const t = useTranslations("Folder.search")
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{t(labelKey)}</span>
      <Input
        type="number"
        value={settings[field]}
        onChange={(event) =>
          onChange({ ...settings, [field]: Number(event.target.value) })
        }
      />
    </label>
  )
}

interface ContentSearchLabels {
  searchDirs: string
  includeExtensions: string
  excludeDirs: string
  excludeExtensions: string
  maxResults: string
  maxFileBytesMb: string
}

/**
 * Renders conversation search results.
 * @param props Search dialog view model.
 * @returns Conversation result list or null for other tabs.
 * @remarks Empty text without filters shows an instructional empty state.
 */
function ConversationResults({
  model,
}: {
  model: ReturnType<typeof useSearchDialogModel>
}) {
  if (model.activeTab !== "conversations") return null
  return (
    <>
      <CommandEmpty>
        {model.searching
          ? model.t("searching")
          : !model.query.trim() && !model.agentFilter
            ? model.t("typeToSearch")
            : model.t("noResults")}
      </CommandEmpty>
      {model.results.length > 0 && (
        <CommandGroup>
          {model.results.map((conv) => (
            <ConversationItem key={conv.id} conv={conv} model={model} />
          ))}
        </CommandGroup>
      )}
    </>
  )
}

/**
 * Renders one conversation result row.
 * @param props Conversation and view model callbacks.
 * @returns Command item JSX.
 * @remarks The created-at timestamp is localized by the parent model.
 */
function ConversationItem({
  conv,
  model,
}: {
  conv: DbConversationSummary
  model: ReturnType<typeof useSearchDialogModel>
}) {
  return (
    <CommandItem
      value={`${conv.id}-${conv.title ?? ""}`}
      onSelect={() => model.handleSelectConversation(conv)}
    >
      <ConversationStatusDot status={conv.status as ConversationStatus} />
      <span className="flex-1 truncate">
        {conv.title || model.t("untitledConversation")}
      </span>
      <span className="text-xs text-muted-foreground shrink-0">
        {AGENT_LABELS[conv.agent_type]}
      </span>
      <span className="text-xs text-muted-foreground shrink-0">
        {formatDistanceToNow(new Date(conv.created_at), {
          addSuffix: true,
          locale: model.dateFnsLocale,
        })}
      </span>
    </CommandItem>
  )
}

/**
 * Renders filename search results.
 * @param props Search dialog view model.
 * @returns File result list or null for other tabs.
 * @remarks The existing file-tab browse behavior is preserved for empty query.
 */
function FileResults({
  model,
}: {
  model: ReturnType<typeof useSearchDialogModel>
}) {
  if (model.activeTab !== "files") return null
  return (
    <>
      <CommandEmpty>
        {model.filesLoading
          ? model.t("searching")
          : !model.query.trim()
            ? model.t("typeToSearchFiles")
            : model.t("noResults")}
      </CommandEmpty>
      {model.filteredFiles.length > 0 && (
        <CommandGroup>
          {model.filteredFiles.map((entry) => (
            <FileItem
              key={entry.relativePath}
              entry={entry}
              onSelect={model.handleSelectFile}
            />
          ))}
        </CommandGroup>
      )}
    </>
  )
}

/**
 * Renders one file or directory result row.
 * @param props Flat file entry and selection callback.
 * @returns Command item JSX.
 * @remarks Directories and files use distinct icons for quick scanning.
 */
function FileItem({
  entry,
  onSelect,
}: {
  entry: FlatFileEntry
  onSelect: (entry: FlatFileEntry) => void
}) {
  return (
    <CommandItem value={entry.relativePath} onSelect={() => onSelect(entry)}>
      {entry.kind === "dir" ? (
        <Folder className="w-4 h-4 shrink-0 text-blue-500" />
      ) : (
        <File className="w-4 h-4 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 truncate">{entry.name}</span>
      <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
        {entry.relativePath}
      </span>
    </CommandItem>
  )
}

/**
 * Renders content-search results and status messages.
 * @param props Content-search state, active query, and row selection callback.
 * @returns Content result list for the active content tab.
 * @remarks Error and truncation messages are shown above successful results.
 */
function ContentResults({
  activeTab,
  state,
  query,
  t,
  onSelect,
}: ContentResultsProps) {
  if (activeTab !== "content") return null
  const submittedQuery = getVisibleSubmittedQuery(state, query)
  return (
    <>
      <ContentStatusMessages state={state} query={query} t={t} />
      {submittedQuery && (
        <ContentResultList
          results={state.results}
          query={submittedQuery}
          onSelect={onSelect}
        />
      )}
    </>
  )
}

/**
 * Returns the submitted query that may safely own visible results.
 * @param state Current content-search state with submitted query metadata.
 * @param query Current command input value.
 * @returns Submitted query when it still matches the input, otherwise null.
 * @remarks Hides completed results after edits so rows cannot open with stale queries.
 */
function getVisibleSubmittedQuery(
  state: ContentSearchState,
  query: string
): string | null {
  const submittedQuery = state.submittedQuery?.trim()
  if (!submittedQuery || submittedQuery !== query.trim()) return null
  return state.results.length > 0 ? submittedQuery : null
}

/**
 * Renders content-search empty, error, and truncation messages.
 * @param props Content state, current input query, and translations.
 * @returns Status message JSX for the content tab.
 * @remarks Result rows are rendered separately so stale rows can be hidden cleanly.
 */
function ContentStatusMessages({
  state,
  query,
  t,
}: {
  state: ContentSearchState
  query: string
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <>
      <CommandEmpty>{getContentEmptyText(state, query, t)}</CommandEmpty>
      {state.error && (
        <div className="px-4 py-2 text-sm text-destructive">
          {t("contentSearchError", { message: state.error })}
        </div>
      )}
      {state.truncated && (
        <div className="px-4 py-2 text-sm text-muted-foreground">
          {t("contentResultsTruncated")}
        </div>
      )}
    </>
  )
}

/**
 * Renders visible content-search result rows for one submitted query.
 * @param props Search matches, owning submitted query, and selection callback.
 * @returns Command group containing content result items.
 * @remarks The submitted query, not the mutable input, is passed to selection.
 */
function ContentResultList({
  results,
  query,
  onSelect,
}: {
  results: SearchFileMatch[]
  query: string
  onSelect: (match: SearchFileMatch, query: string) => void
}) {
  return (
    <CommandGroup>
      {results.map((match) => (
        <ContentResultItem
          key={`${match.path}:${match.lineNumber}`}
          match={match}
          query={query}
          onSelect={onSelect}
        />
      ))}
    </CommandGroup>
  )
}

/**
 * Chooses the empty-state text for content search.
 * @param state Current content-search state.
 * @param query Current search query.
 * @param t Translation function for Folder.search.
 * @returns Localized empty-state text.
 * @remarks Blank queries explain that content search is manual.
 */
function getContentEmptyText(
  state: ContentSearchState,
  query: string,
  t: ReturnType<typeof useTranslations>
): string {
  if (state.searching) return t("searching")
  if (!query.trim()) return t("typeToSearchContent")
  return t("noResults")
}

/**
 * Renders one content-search match row.
 * @param props Match data, current query, and selection callback.
 * @returns Command item JSX.
 * @remarks lineText is the primary row text to expose match context.
 */
function ContentResultItem({
  match,
  query,
  onSelect,
}: {
  match: SearchFileMatch
  query: string
  onSelect: (match: SearchFileMatch, query: string) => void
}) {
  return (
    <CommandItem
      value={`${match.path}:${match.lineNumber}:${match.lineText}`}
      onSelect={() => onSelect(match, query)}
    >
      <File className="w-4 h-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{match.lineText}</span>
      <span className="text-xs font-medium text-muted-foreground shrink-0 truncate max-w-24">
        {match.name}
      </span>
      <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
        {match.path}:{match.lineNumber}
      </span>
    </CommandItem>
  )
}
