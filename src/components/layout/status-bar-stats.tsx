"use client"

import { ChartNoAxesColumn, MonitorCloud } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useRemoteConnection } from "@/contexts/remote-connection-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * The workspace-stats cluster at the left end of the status bar.
 *
 * The conversation count doubles as the entry point to the Token Usage
 * dashboard — clicking it swaps the workbench route instead of opening a
 * popover, so the number is a door, not a dead end. The per-agent breakdown
 * the old popover held lives on that page in far richer form.
 */
export function StatusBarStats() {
  const t = useTranslations("Folder.statusBar.stats")
  const stats = useAppWorkspaceStore((s) => s.stats)
  // Non-null only in a remote-desktop window (a Tauri client bound to a remote
  // codeg-server); local windows have no RemoteConnection in context.
  const remoteConnection = useRemoteConnection()?.connection ?? null
  const { routeId, setRoute } = useWorkbenchRoute()

  if (!remoteConnection && !stats) return null

  return (
    <div className="flex items-center gap-3">
      {remoteConnection && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex max-w-40 items-center gap-1.5">
                <MonitorCloud className="h-3 w-3 shrink-0" />
                <span className="truncate">{remoteConnection.name}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              <p className="font-medium">{remoteConnection.name}</p>
              <p className="text-background/70">{remoteConnection.base_url}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {stats && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setRoute("tokenUsage")}
                className={cn(
                  "flex items-center gap-1.5 transition-colors hover:text-foreground",
                  routeId === "tokenUsage" && "text-foreground"
                )}
              >
                <ChartNoAxesColumn className="h-3 w-3" />
                <span>
                  {t("conversations", { count: stats.total_conversations })}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              {t("openUsage")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  )
}
