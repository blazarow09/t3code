import { AudioPreviewUnmountContext } from "../files/AudioPreview";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { MarkdownFindContext } from "./markdownFindContext";
import { useChatCanvas } from "./ChatCanvasContext";
import { WorkLogBlock } from "./WorkLog";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";
import type { WorktreeSetupSnapshot } from "@t3tools/contracts";
import { deriveTimelineMinimapItems } from "./timelineMinimapItems";
import {
  type AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2TurnItem,
  type RunAttemptId,
  type ServerProviderSkill,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { WorkflowOpening } from "@t3tools/client-runtime/state/subagentRuntime";
import { observeResize } from "~/lib/observeResize";
import { useStableCallback } from "~/hooks/useStableCallback";

const NOOP_USE_ARTIFACT_TEMPLATE = () => {};
const EMPTY_PENDING_APPROVALS: ReadonlyArray<PendingApproval> = [];
const EMPTY_RESPONDING_REQUEST_IDS: TimelineRowSharedState["respondingRequestIds"] = [];

const NOOP_OPEN_ATTACHMENT = (_attachment: ChatFileAttachment) => {};

import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import {
  memo,
  use,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type MaintainScrollAtEndOptions,
} from "@legendapp/list/react";
import { type PendingApproval, type TimelineEntry } from "../../session-logic";
import type { CodexArtifactTemplate } from "@t3tools/shared/codexArtifactTemplates";
import { type ChatFileAttachment, type TurnDiffSummary } from "../../types";
import { ArrowRightIcon, BotIcon, CircleAlertIcon, Minimize2Icon } from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  readTimelinePosition,
  type RememberedTimelinePosition,
  rememberTimelinePosition,
  timelineContentOverflowsViewport,
} from "./timelineScrollAnchoring";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { type AssistantCitationRequest } from "./AssistantCitationSource";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { resolveCitationPhase, type CitedHistory } from "./citationProcedure";
import {
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapCurrentIndex,
  isTimelineMinimapRowVisible,
  resolveTimelineMinimapVisibleRange,
  resolveTimelineMinimapHitStripWidth,
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
  type TimelineLatestRun,
} from "./MessagesTimeline.logic";
import { type ThreadFindMatch } from "./threadFind";
import { useThreadFindNavigation } from "./useThreadFindNavigation";
import { TooltipScrollDismissArea } from "../ui/tooltip";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { type HandoffTimelineRun } from "./V2LifecycleRow";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

import { forwardWheelToTimeline } from "./timelineMinimapWheel";
import { TimelineMinimap } from "./TimelineMinimap";
import {
  type TimelineRowSharedState,
  type TimelineRowActivityState,
  TimelineRowCtx,
  TimelineRowActivityCtx,
  type WorkGroupViewState,
  type TimelineRow,
} from "./timelineRowContext";
import { TimelineRowTimestamp, ActivityShimmerOverlay } from "./TimelineRowParts";
import {
  WorkGroupSection,
  WorkingTimelineRow,
  ThinkingTimelineRow,
  LiveWorkEntryTimelineRow,
  WorkGroupToggleTimelineRow,
} from "./TimelineWorkGroupRows";
import { UserMessageRow } from "./TimelineUserMessageRow";
import {
  AssistantTimelineRow,
  AssistantMetaTimelineRow,
  ProposedPlanTimelineRow,
  HtmlRenderTimelineRow,
  McpAppTimelineRow,
} from "./TimelineAssistantRows";
import { V2EventTimelineRow } from "./TimelineV2EventRow";
import { startTimelinePositionRestore } from "./useTimelinePositionRestore";
import {
  attachTimelineViewport,
  nextListOpening,
  type TimelineListOpening,
  type TimelineViewport,
} from "./timelineViewport";
import { useThreadFindPositionReader } from "./useThreadFindPositionReader";
import { ThreadActivityAnnouncer } from "./ThreadActivityAnnouncer";
import { useStableHandoffRuns, useIncrementalTimelineRows, useStableRows } from "./useTimelineRows";

function timelineListStateFor(identity: string): {
  readonly identity: string;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly workGroupViewState: WorkGroupViewState;
} {
  const rememberedPosition = readTimelinePosition(identity);
  return {
    identity,
    rememberedPosition,
    workGroupViewState: rememberedPosition?.disclosures?.workGroupState ?? {
      scrollPositions: new Map(),
      expandedEntries: new Set(),
    },
  };
}

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);
function TimelineListFooter({
  composerInset,
  onGrow,
  children,
}: {
  readonly composerInset: number;
  readonly onGrow: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports growth of the footer's content, which the list does not follow
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !onGrow) return;
    let height = content.offsetHeight;
    return observeResize(content, () => {
      const next = content.offsetHeight;
      if (next > height) onGrow();
      height = next;
    });
  }, [onGrow]);
  return (
    <div>
      <div ref={contentRef}>{children}</div>
      <div aria-hidden style={{ height: composerInset }} />
      <div aria-hidden className="h-3 sm:h-4" />
    </div>
  );
}

const EMPTY_TIMELINE_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    footerLayout: false,
    itemLayout: true,
    layout: true,
  },
} as const satisfies MaintainScrollAtEndOptions;
const EMPTY_RUN_IDS: ReadonlySet<RunId> = new Set();
const TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH = {
  ...TIMELINE_MAINTAIN_SCROLL_AT_END,
  animated: true,
} as const satisfies MaintainScrollAtEndOptions;

const CITED_HISTORY_LOADING: CitedHistory = { _tag: "loading" };

export interface MessagesTimelineHistoryControls {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onLoadEarlier: (throughEntryId?: string) => void;
}

interface MessagesTimelineProps {
  pendingApprovals?: ReadonlyArray<PendingApproval>;
  heldApprovalRequestIds?: ReadonlySet<string> | undefined;
  respondingRequestIds?: TimelineRowSharedState["respondingRequestIds"];
  canOperateThread?: boolean;
  onRespondToApproval?: TimelineRowSharedState["onRespondToApproval"];
  citationRequest?: AssistantCitationRequest | null;
  citationHistory?: CitedHistory;
  onCiteAssistantText?: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
  ) => boolean;
  isWorking: boolean;
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  worktreeSetup?: WorktreeSetupSnapshot | null;
  onCancelWorktreeSetup?: () => void;
  retryableWorkspacePreparationRunIds?: ReadonlySet<RunId>;
  onRetryWorkspacePreparation?: (runId: RunId) => void;
  onWorktreeSetupWorkLocally?: () => void;
  onOpenWorktreeSetupTerminal?: (terminalId: string) => void;
  isPreparingWorktree?: boolean;
  isCompacting?: boolean;
  awaitingUser?: "approval" | "input" | null;
  /** Which request is waiting, so a second one of the same kind is announced too. */
  awaitingRequestId?: string | null;
  footer?: ReactNode;

  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  /** The run the screen reader announcer follows; see announcedRun. */
  announcedRun?: { readonly runId: RunId; readonly status: TimelineLatestRun["status"] } | null;
  /** See isDetailBehindShell. */
  detailBehindShell?: boolean;
  runningRunId?: RunId | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  routeThreadKey: string;
  displayThreadKey?: string;
  /** Off where another region already speaks the thread's status, like a subagent's bar. */
  announceTurnStatus?: boolean;
  onOpenTurnDiff?: (runId: RunId, filePath?: string) => void;
  onOpenThread: (threadId: OrchestrationV2TurnItem["threadId"]) => void;
  renderHtmlRender?: TimelineRowSharedState["renderHtmlRender"];
  turnItemSource?: TimelineRowSharedState["turnItemSource"];
  /** The thread this one is a subagent of; `open` is absent when it cannot be opened from here. */
  parentThreadLink?: {
    readonly title: string;
    /** Where it runs, when that is another environment. */
    readonly environmentLabel?: string;
    readonly open?: () => void;
  } | null;
  workflowOpening?: WorkflowOpening | null;
  onForkFromRun?: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  onRevertToTurnCount: (targetTurnCount: number, messageId: MessageId) => void;
  onUseArtifactTemplate?: (template: CodexArtifactTemplate) => void;
  onSendAppMessage?: (text: string) => Promise<void>;
  onRunShellCommand?: (command: string) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onFileOpen?: (attachment: ChatFileAttachment) => void;
  onFileDownload?: (attachment: ChatFileAttachment) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<ServerProviderSkill>;
  runs: ReadonlyArray<HandoffTimelineRun>;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  contentInsetEndAdjustment: number;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  /** Disable while reading history to prevent LegendList re-pinning near the bottom. */
  liveFollowEnabled: boolean;
  onContentOverflowChange?: (overflows: boolean) => void;
  onToolOutputCollapsedAtEnd?: () => void;
  /** Receives the list's viewport when it mounts; the returned cleanup runs when it goes away. */
  onViewportAttach?: (viewport: TimelineViewport) => () => void;
  /** The footer's content grew, such as a new queued turn or status line. */
  onFooterGrow?: () => void;
  findOpen?: boolean;
  hideEmptyPlaceholder?: boolean;
  /** Composer space to center the empty state against; held steady through collapse. */
  emptyPlaceholderInset: number;
  topFadeEnabled?: boolean;
  historyControls?: MessagesTimelineHistoryControls | undefined;
  findExpanded?: boolean;
  findQuery?: string;
  activeFindMatch?: ThreadFindMatch | null;
  findNavigationId?: number;
}

export function MessagesTimeline(props: MessagesTimelineProps) {
  const find = useContext(ThreadFindTimelineContext);
  const findOpen = find?.findOpen ?? props.findOpen;
  return (
    <ConversationTimeline
      {...props}
      {...find}
      liveFollowEnabled={!findOpen && props.liveFollowEnabled}
    />
  );
}

const ConversationTimeline = memo(function ConversationTimeline({
  pendingApprovals = EMPTY_PENDING_APPROVALS,
  heldApprovalRequestIds,
  respondingRequestIds = EMPTY_RESPONDING_REQUEST_IDS,
  canOperateThread = false,
  onRespondToApproval,
  citationRequest = null,
  citationHistory = CITED_HISTORY_LOADING,
  onCiteAssistantText,
  isWorking,
  runlessWorkActive = false,
  activeTurnStartedAt = null,
  worktreeSetup = null,
  footer = null,
  onCancelWorktreeSetup,
  retryableWorkspacePreparationRunIds = EMPTY_RUN_IDS,
  onRetryWorkspacePreparation,
  onWorktreeSetupWorkLocally,
  onOpenWorktreeSetupTerminal,
  isPreparingWorktree = false,
  isCompacting = false,
  awaitingUser = null,
  awaitingRequestId = null,
  listRef,
  timelineEntries,
  findOpen = false,
  findExpanded = false,
  findQuery = "",
  activeFindMatch = null,
  findNavigationId = 0,
  latestRun,
  announcedRun = null,
  detailBehindShell = false,
  runningRunId = null,
  turnDiffSummaries,
  routeThreadKey,
  displayThreadKey,
  announceTurnStatus = true,
  onOpenTurnDiff,
  onOpenThread,
  renderHtmlRender,
  turnItemSource,
  parentThreadLink = null,
  workflowOpening = null,
  onForkFromRun,
  supportsConversationRollback,
  threadStartCheckpointReady = false,
  availableRevertTurnCounts,
  onRevertToTurnCount,
  onUseArtifactTemplate = NOOP_USE_ARTIFACT_TEMPLATE,
  onSendAppMessage,
  onRunShellCommand,
  isRevertingCheckpoint,
  onImageExpand,
  onFileOpen = NOOP_OPEN_ATTACHMENT,
  onFileDownload = NOOP_OPEN_ATTACHMENT,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  runs: runsProp,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  onIsAtEndChange,
  onContentOverflowChange,
  liveFollowEnabled,
  onToolOutputCollapsedAtEnd,
  onViewportAttach,
  onFooterGrow,
  hideEmptyPlaceholder = false,
  emptyPlaceholderInset,
  topFadeEnabled = false,
  historyControls,
}: MessagesTimelineProps) {
  const listIdentityKey = displayThreadKey ?? routeThreadKey;
  // Snapshot restore positions on identity changes; ongoing scroll writes must not move them.
  // Find open at the opening is part of the snapshot: opening find later
  // announces its own navigation (threadFindStore's announceOpening).
  const [listState, setListState] = useState(() => ({
    ...timelineListStateFor(listIdentityKey),
    findOpenAtOpening: findOpen,
  }));
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<RunId>>(
    () => listState.rememberedPosition?.disclosures?.runs ?? new Set(),
  );
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => listState.rememberedPosition?.disclosures?.workGroups ?? new Set(),
  );
  const [expandedAttemptIds, setExpandedAttemptIds] = useState<ReadonlySet<RunAttemptId>>(
    () => listState.rememberedPosition?.disclosures?.attempts ?? new Set(),
  );
  // A list that opens on a thread with find open takes the opening step below,
  // so the restore runs and releases follow once for find.
  const [positionedThreadKey, setPositionedThreadKey] = useState<string | null>(() =>
    listState.rememberedPosition?.atEnd === false || findOpen ? null : listIdentityKey,
  );
  const restoringThreadPosition = positionedThreadKey !== listIdentityKey;
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [settlingListIdentity, setSettlingListIdentity] = useState<string | null>(listIdentityKey);
  const [playingAudioRows, setPlayingAudioRows] = useState<ReadonlyMap<HTMLAudioElement, string>>(
    () => new Map(),
  );
  const [fullscreenAppRowId, setFullscreenAppRowId] = useState<string | null>(null);
  let paintedExpandedRunIds = expandedRunIds;
  let paintedExpandedWorkGroupIds = expandedWorkGroupIds;
  let paintedExpandedAttemptIds = expandedAttemptIds;
  const identityChanged = listState.identity !== listIdentityKey;
  const { rememberedPosition, workGroupViewState } = identityChanged
    ? timelineListStateFor(listIdentityKey)
    : listState;
  if (identityChanged) {
    setPlayingAudioRows(new Map());
    setListState({
      identity: listIdentityKey,
      rememberedPosition,
      workGroupViewState,
      findOpenAtOpening: findOpen,
    });
    setPositionedThreadKey(null);
    setSettlingListIdentity(listIdentityKey);
    // A viewer pinned in another thread must not keep live follow off here,
    // nor when that thread comes back.
    setFullscreenAppRowId(null);
    paintedExpandedRunIds = rememberedPosition?.disclosures?.runs ?? new Set();
    paintedExpandedWorkGroupIds = rememberedPosition?.disclosures?.workGroups ?? new Set();
    paintedExpandedAttemptIds = rememberedPosition?.disclosures?.attempts ?? new Set();
    setExpandedRunIds(paintedExpandedRunIds);
    setExpandedWorkGroupIds(paintedExpandedWorkGroupIds);
    setExpandedAttemptIds(paintedExpandedAttemptIds);
  }
  const citationThreadRef = parseScopedThreadKey(routeThreadKey);
  const openPullRequest = useOpenPrLink(citationThreadRef ?? undefined);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const normalizedFindQuery = findQuery.trim();
  const findActive = findExpanded;

  const disclosurePinsEndRef = useRef(false);
  const disclosureCollapsedRef = useRef(false);
  const pinDisclosureToEnd = () => {
    if (!disclosurePinsEndRef.current) return;
    const element = listRef.current?.getScrollableNode();
    if (element) element.scrollTop = element.scrollHeight;
  };

  const scheduleDisclosureSettle = () => {
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      pinDisclosureToEnd();
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        pinDisclosureToEnd();
        disclosurePinsEndRef.current = false;
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
        if (
          disclosureCollapsedRef.current &&
          resolveTimelineIsAtEnd(listRef.current?.getState()) === true
        ) {
          onToolOutputCollapsedAtEnd?.();
        }
      });
    });
  };

  const suspendEndScrollMaintenanceForDisclosure = (anchorKey: string, collapsed = false) => {
    disclosureAnchorKeyRef.current = anchorKey;
    disclosureCollapsedRef.current = collapsed;
    disclosurePinsEndRef.current = resolveTimelineIsAtEnd(listRef.current?.getState()) === true;
    setDisclosureToggleSettling(true);
    scheduleDisclosureSettle();
  };

  const shouldRestoreVisibleContentPosition = (row: MessagesTimelineRow) => {
    if (disclosurePinsEndRef.current) return false;
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  };

  const onToggleTurnFold = (runId: RunId) => {
    suspendEndScrollMaintenanceForDisclosure(`turn-fold:${runId}`);
    setExpandedRunIds((existing) => {
      const next = new Set(existing);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };
  const onToggleWorkGroup = (groupId: string, anchorKey: string) => {
    suspendEndScrollMaintenanceForDisclosure(anchorKey, expandedWorkGroupIds.has(groupId));
    setExpandedWorkGroupIds((existing) => {
      const next = new Set(existing);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };
  const onToggleAttemptFold = (attemptId: RunAttemptId) => {
    suspendEndScrollMaintenanceForDisclosure(`attempt-fold:${attemptId}`);
    setExpandedAttemptIds((existing) => {
      const next = new Set(existing);
      if (next.has(attemptId)) {
        next.delete(attemptId);
      } else {
        next.add(attemptId);
      }
      return next;
    });
  };

  // An interrupted run opens its fold; a newer run closes the previous run's.
  const [observedLatestRun, setObservedLatestRun] = useState({
    identity: listIdentityKey,
    runId: latestRun?.runId,
    status: latestRun?.status,
  });
  if (
    observedLatestRun.identity !== listIdentityKey ||
    observedLatestRun.runId !== latestRun?.runId ||
    observedLatestRun.status !== latestRun?.status
  ) {
    setObservedLatestRun({
      identity: listIdentityKey,
      runId: latestRun?.runId,
      status: latestRun?.status,
    });
    const previousRunId = observedLatestRun.runId;
    if (
      observedLatestRun.identity === listIdentityKey &&
      latestRun &&
      previousRunId !== undefined
    ) {
      if (latestRun.runId === previousRunId) {
        if (observedLatestRun.status === "running" && latestRun.status === "interrupted") {
          setExpandedRunIds((existing) => new Set(existing).add(latestRun.runId));
        }
      } else {
        setExpandedRunIds((existing) => {
          if (!existing.has(previousRunId)) return existing;
          const next = new Set(existing);
          next.delete(previousRunId);
          return next;
        });
      }
    }
  }

  // Imported turns and post-steer work fold under synthetic keys, not the entries' run ids.
  const findFoldRunIds = findActive
    ? timelineTurnFoldRunIdsByEntryId({
        timelineEntries,
        latestRun,
        runningRunId,
        isWorking,
        runlessWorkActive,
      })
    : null;
  const activeFindRunId =
    findActive && activeFindMatch ? findFoldRunIds?.get(activeFindMatch.entryId) : undefined;
  const [expandedFindRunId, setExpandedFindRunId] = useState<RunId | undefined>();
  if (expandedFindRunId !== activeFindRunId) {
    setExpandedFindRunId(activeFindRunId);
    if (activeFindRunId) {
      setExpandedRunIds((previous) =>
        previous.has(activeFindRunId) ? previous : new Set(previous).add(activeFindRunId),
      );
    }
  }
  // A cited response folded inside a turn opens its fold once per activation;
  // the user can fold it again. Only a citation that can still land opens one.
  // The marker stops the O(entries) fold lookup once the entry is found, since
  // the href stays in the URL after the citation settles.
  const [citationExpandedFor, setCitationExpandedFor] = useState<string | null>(null);
  // Back/Forward can restore an earlier activation key, so the marker clears
  // between activations and a revisit opens the fold again.
  if (!citationRequest && citationExpandedFor !== null) setCitationExpandedFor(null);
  const citedEntry =
    citationRequest &&
    citationExpandedFor !== citationRequest.key &&
    citationHistory._tag !== "failed"
      ? timelineEntries.find(
          (entry) =>
            entry.kind === "message" &&
            entry.message.role === "assistant" &&
            entry.message.id === citationRequest.citation.messageId,
        )
      : undefined;
  if (citationRequest && citedEntry) {
    const citedRunId = (
      findFoldRunIds ??
      timelineTurnFoldRunIdsByEntryId({
        timelineEntries,
        latestRun,
        runningRunId,
        isWorking,
        runlessWorkActive,
      })
    ).get(citedEntry.id);
    setCitationExpandedFor(citationRequest.key);
    if (citedRunId) {
      setExpandedRunIds((previous) =>
        previous.has(citedRunId) ? previous : new Set(previous).add(citedRunId),
      );
    }
    const citedAttempt = citedEntry.attempt;
    if (citedAttempt?.status === "superseded") {
      setExpandedAttemptIds((previous) =>
        previous.has(citedAttempt.id) ? previous : new Set(previous).add(citedAttempt.id),
      );
    }
  }
  const visibleExpandedRunIds =
    !activeFindRunId || paintedExpandedRunIds.has(activeFindRunId)
      ? paintedExpandedRunIds
      : new Set(paintedExpandedRunIds).add(activeFindRunId);

  const activeFindAttemptId = activeFindMatch
    ? timelineEntries.find((entry) => entry.id === activeFindMatch.entryId)?.attempt?.id
    : undefined;
  const [expandedFindAttemptId, setExpandedFindAttemptId] = useState<RunAttemptId | undefined>();
  if (expandedFindAttemptId !== activeFindAttemptId) {
    setExpandedFindAttemptId(activeFindAttemptId);
    if (activeFindAttemptId) {
      setExpandedAttemptIds((previous) =>
        previous.has(activeFindAttemptId) ? previous : new Set(previous).add(activeFindAttemptId),
      );
    }
  }
  const visibleExpandedAttemptIds =
    activeFindAttemptId && !paintedExpandedAttemptIds.has(activeFindAttemptId)
      ? new Set(paintedExpandedAttemptIds).add(activeFindAttemptId)
      : paintedExpandedAttemptIds;

  const pendingApprovalsByRequestId = new Map(
    pendingApprovals
      .filter((approval) => !heldApprovalRequestIds?.has(approval.requestId))
      .map((approval) => [approval.requestId, approval]),
  );
  const pendingApprovalRequestIds = new Set(pendingApprovalsByRequestId.keys());
  const rawRows = useIncrementalTimelineRows(`${listIdentityKey}\0${workspaceRoot ?? ""}`, {
    timelineEntries,
    pendingApprovalRequestIds,
    latestRun,
    runningRunId,
    expandedRunIds: visibleExpandedRunIds,
    expandedAttemptIds: visibleExpandedAttemptIds,
    expandedWorkGroupIds,
    isWorking,
    runlessWorkActive,
    activeTurnStartedAt,
    turnDiffSummaries,
    supportsConversationRollback,
    threadStartCheckpointReady,
    availableRevertTurnCounts,
    worktreeSetup,
  });
  const rows = useStableRows(rawRows, listIdentityKey);
  const unmatchedPendingApprovals = new Map(pendingApprovalsByRequestId);
  if (unmatchedPendingApprovals.size > 0) {
    for (const row of rows) {
      const entries =
        row.kind === "work" ? row.groupedEntries : row.kind === "work-live" ? [row.entry] : [];
      for (const entry of entries) {
        const item = entry.projectedItem?.item;
        if (item?.type === "approval_request") unmatchedPendingApprovals.delete(item.requestId);
      }
    }
  }
  // Run status/timestamps change per stream event; keep them out of shared row context.
  const runs = useStableHandoffRuns(runsProp);
  const minimapItems = deriveTimelineMinimapItems(rows);
  const minimapRowIndices = minimapItems.map((item) => item.rowIndex);
  const restoreRowIndex =
    restoringThreadPosition && rememberedPosition?.atEnd === false
      ? rows.findIndex((row) => row.id === rememberedPosition.rowId)
      : -1;
  const restoringAlwaysRender =
    restoringThreadPosition && restoreRowIndex >= 0 ? { indices: [restoreRowIndex] } : undefined;
  const showsEmptyState =
    rows.length === 0 &&
    unmatchedPendingApprovals.size === 0 &&
    !isWorking &&
    parentThreadLink === null &&
    historyControls === undefined &&
    footer === null;
  const [listOpening, setListOpening] = useState<TimelineListOpening>(() =>
    nextListOpening({ mounted: false }, !showsEmptyState, listIdentityKey),
  );
  const nextOpening = nextListOpening(listOpening, !showsEmptyState, listIdentityKey);
  if (nextOpening !== listOpening) setListOpening(nextOpening);
  const listOpenedOn = nextOpening.mounted ? nextOpening.identity : null;
  const viewportRef = useRef<TimelineViewport | null>(null);
  const navigateTimeline = () => viewportRef.current?.navigate({ releasesFollow: true });
  const restoreReady = restoringThreadPosition && rows.length > 0;
  // Z: syncs LegendList's scroll position with which thread it shows. The list
  // is not keyed per thread and reports no "new data" event, and the restore
  // must land before paint, after LegendList's own layout effects applied the
  // new data. A citation request that arrives mid-restore takes over.
  const { findOpenAtOpening } = identityChanged ? { findOpenAtOpening: findOpen } : listState;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores LegendList's scroll position for the shown thread before paint, after the list's own layout
  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = viewportRef.current;
    if (!restoreReady || !list || !viewport) return;
    return startTimelinePositionRestore({
      list,
      viewport,
      listIdentityKey,
      listOpenedOn,
      rememberedPosition,
      citationPending: citationRequest !== null,
      releaseForFind: findOpenAtOpening,
      onPositioned: setPositionedThreadKey,
    });
  }, [
    citationRequest,
    findOpenAtOpening,
    listIdentityKey,
    listOpenedOn,
    listRef,
    rememberedPosition,
    restoreReady,
    viewportRef,
  ]);

  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const {
    target: readyCitationRequest,
    positioning: citationPositioning,
    onListLoad: onCitationListLoad,
    alwaysRender: citationAlwaysRender,
  } = useAssistantCitationTarget({
    request: citationRequest,
    phase: citationRequest
      ? resolveCitationPhase({
          history: citationHistory,
          messageId: citationRequest.citation.messageId,
          entries: timelineEntries,
          rows,
        })
      : null,
    viewport: timelineViewportElement,
    onManualNavigation: navigateTimeline,
  });
  const [findListReady, setFindListReady] = useState(false);
  const handleListLoad = () => {
    onCitationListLoad();
    setFindListReady(true);
  };
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  // Every full-screen viewer reports false when it unmounts, so a row that leaves the list
  // while full screen releases its pin too.
  const onAppFullscreenChange = (rowId: string, fullscreen: boolean) => {
    setFullscreenAppRowId((current) => (fullscreen ? rowId : current === rowId ? null : current));
  };
  const alwaysRenderIndices = restoringAlwaysRender?.indices ?? [];
  // Screen readers can only reach headings in the DOM. Keeping the first and
  // last messages mounted lets heading navigation wrap to either end.
  const firstMessageRow = rows.find(isMessageRow);
  const lastMessageRow = rows.findLast(isMessageRow);
  const alwaysRenderKeys = [
    ...(firstMessageRow ? [firstMessageRow.id] : []),
    ...(lastMessageRow && lastMessageRow !== firstMessageRow ? [lastMessageRow.id] : []),
    ...(citationAlwaysRender?.keys ?? []),
    ...(fullscreenAppRowId === null ? [] : [fullscreenAppRowId]),
    ...new Set(
      [...playingAudioRows].filter(([audio]) => audio.isConnected).map(([, rowId]) => rowId),
    ),
  ];
  const alwaysRender =
    alwaysRenderIndices.length === 0 && alwaysRenderKeys.length === 0
      ? undefined
      : {
          ...(alwaysRenderIndices.length === 0 ? {} : { indices: alwaysRenderIndices }),
          ...(alwaysRenderKeys.length === 0 ? {} : { keys: alwaysRenderKeys }),
        };
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(null);
  const handleAnchorReady = (info: { anchorIndex: number | undefined }) => {
    if (anchorMessageId !== null && info.anchorIndex !== undefined) {
      onAnchorReady(anchorMessageId, info.anchorIndex);
    }
  };
  const handleAnchorSizeChanged = (size: number) => {
    if (anchorMessageId !== null) {
      onAnchorSizeChanged(anchorMessageId, size);
    }
  };
  const anchoredEndSpaceConfig = resolveChatListAnchoredEndSpace(
    rows,
    anchorMessageId,
    (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
    { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
  );
  const anchoredEndSpace = anchoredEndSpaceConfig
    ? {
        ...anchoredEndSpaceConfig,
        onReady: handleAnchorReady,
        onSizeChanged: handleAnchorSizeChanged,
      }
    : undefined;
  const maintainVisibleContentPosition = {
    data: true,
    size: true,
    shouldRestorePosition: shouldRestoreVisibleContentPosition,
  };
  const measureContentOverflow = () =>
    timelineContentOverflowsViewport(listRef.current?.getState?.(), {
      composerInset: contentInsetEndAdjustment,
      anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
    });
  // Read next frame, after LegendList's layout effects settle row positions.
  const contentOverflowFrameRef = useRef<number | null>(null);
  const cancelContentOverflowFrame = () => {
    if (contentOverflowFrameRef.current !== null) {
      cancelAnimationFrame(contentOverflowFrameRef.current);
      contentOverflowFrameRef.current = null;
    }
  };
  const reportContentOverflow = () => {
    if (!onContentOverflowChange || contentOverflowFrameRef.current !== null) return;
    contentOverflowFrameRef.current = requestAnimationFrame(() => {
      contentOverflowFrameRef.current = null;
      onContentOverflowChange(measureContentOverflow());
    });
  };

  const refreshMinimap = useStableCallback(() => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== rows) return;
    if (!state || minimapItems.length === 0) {
      return;
    }

    const firstBufferedIndex = state.startBuffered;
    const firstBufferedRow: HTMLElement | undefined =
      firstBufferedIndex == null ? undefined : state.elementAtIndex(firstBufferedIndex);
    const firstBufferedTop =
      firstBufferedIndex == null ? undefined : state.positionAtIndex(firstBufferedIndex);
    const viewport: HTMLElement | undefined = listRef.current?.getScrollableNode();
    // Cached row positions exclude the header and pending scroll adjustments.
    const scroll =
      firstBufferedRow && viewport && firstBufferedTop !== undefined
        ? firstBufferedTop +
          viewport.getBoundingClientRect().top -
          firstBufferedRow.getBoundingClientRect().top
        : state.scroll;
    const visibleRange = resolveTimelineMinimapVisibleRange({ ...state, scroll });
    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      const inView = isTimelineMinimapRowVisible(
        item.rowIndex,
        visibleRange.start,
        visibleRange.end,
      );
      const next = inView ? "true" : "false";
      // Avoid dirtying style state on every scroll tick for unchanged strips.
      if (strip && strip.dataset.inView !== next) {
        strip.dataset.inView = next;
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      visibleStart: visibleRange.start,
      visibleEnd: visibleRange.end,
      rowIndices: minimapRowIndices,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  });

  const minimapRefreshFrameRef = useRef<number | null>(null);
  const scheduleMinimapRefresh = () => {
    if (minimapRefreshFrameRef.current !== null) return;
    // LegendList recycles row containers before React commits their positions.
    minimapRefreshFrameRef.current = requestAnimationFrame(() => {
      minimapRefreshFrameRef.current = null;
      refreshMinimap();
    });
  };

  // The measurement the last remember wrote, so a follow release can rewrite
  // it without reading render state from a listener.
  const lastRememberedRef = useRef<{
    readonly data: unknown;
    readonly threadKey: string;
    readonly position: Parameters<typeof rememberTimelinePosition>[1];
  } | null>(null);
  const rememberPosition = (followingEnd: boolean) => {
    const state = listRef.current?.getState?.();
    if (restoringThreadPosition || state?.data !== rows) return;
    const isAtEnd = resolveTimelineIsAtEnd(state);
    const position = state.data.length ? resolveWorkGroupScrollAnchor(state) : undefined;
    if (position && isAtEnd !== undefined) {
      const index = state.indexByKey(position.rowId);
      const row = index === undefined ? undefined : state.elementAtIndex(index);
      const element = listRef.current?.getScrollableNode();
      if (row && element) {
        const measured = {
          ...position,
          offsetWithinRow: element.getBoundingClientRect().top - row.getBoundingClientRect().top,
          scrollOffset: element.scrollTop,
          atEnd: isAtEnd,
          disclosures: {
            runs: paintedExpandedRunIds,
            workGroups: paintedExpandedWorkGroupIds,
            attempts: paintedExpandedAttemptIds,
            workGroupState: workGroupViewState,
          },
        };
        lastRememberedRef.current = { data: rows, threadKey: listIdentityKey, position: measured };
        rememberTimelinePosition(listIdentityKey, measured, followingEnd);
      }
    }
    return isAtEnd;
  };
  // A follow release without a scroll after it would leave the position
  // remembered as following.
  const rememberReleasedPosition = () => {
    const last = lastRememberedRef.current;
    if (last && listRef.current?.getState().data === last.data) {
      rememberTimelinePosition(last.threadKey, last.position, false);
    }
  };

  const handleScroll = () => {
    if (restoringThreadPosition || listRef.current?.getState?.().data !== rows) return;
    const isAtEnd = rememberPosition(liveFollowEnabled && !anchoredEndSpace);
    if (isAtEnd !== undefined && !citationPositioning) {
      onIsAtEndChange(isAtEnd);
    }
    reportContentOverflow();
    scheduleMinimapRefresh();
  };

  const handleItemSizeChanged = () => {
    if (disclosurePinsEndRef.current) {
      queueMicrotask(pinDisclosureToEnd);
      scheduleDisclosureSettle();
    }
    reportContentOverflow();
    scheduleMinimapRefresh();
  };

  const measureTimelineGutter = (viewportElement: HTMLElement) => {
    const viewportWidth = viewportElement.getBoundingClientRect().width;
    const contentWidth =
      viewportElement.querySelector<HTMLElement>("[data-timeline-root]")?.getBoundingClientRect()
        .width ?? viewportWidth;
    const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(
      viewportWidth,
      contentWidth,
    );
    setMinimapHasPersistentGutter((current) =>
      current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
    );
    setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth));
  };
  // Rows added, removed or rewrapped (chat width) change the content size,
  // which moves the scroll position, the overflow, and the content lane width.
  const handleContentSizeChanged = useStableCallback((laidOutData: unknown) => {
    // The first laid-out content of a newly shown thread ends its settling; a
    // frame the previous thread scheduled laid out the previous thread's rows.
    if (laidOutData === rows) {
      setSettlingListIdentity((current) => (current === listIdentityKey ? null : current));
    }
    handleScroll();
  });
  // The content lane only changes width with the viewport or the chat width
  // setting, never with streamed content; measuring per content frame would
  // force a layout on every chunk.
  const measuredLaneWidthRef = useRef<number | null>(null);
  const observeLaneWidth = (lane: HTMLDivElement | null) => {
    if (!lane) return;
    return observeResize(lane, (entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width === undefined || width === measuredLaneWidthRef.current) return;
      measuredLaneWidthRef.current = width;
      const viewportElement = lane.closest<HTMLElement>("[data-assistant-citation-viewport]");
      if (viewportElement) measureTimelineGutter(viewportElement);
    });
  };
  const attachTimelineViewportElement = (viewportElement: HTMLDivElement | null) => {
    setTimelineViewportElement(viewportElement);
    if (!viewportElement) return;
    const stopObserving = observeResize(viewportElement, () =>
      measureTimelineGutter(viewportElement),
    );
    return () => {
      stopObserving();
      setTimelineViewportElement(null);
    };
  };

  const sharedState: TimelineRowSharedState = {
    pendingApprovals: pendingApprovalsByRequestId,
    respondingRequestIds,
    canOperateThread,
    onRespondToApproval,
    citationRequest: readyCitationRequest,
    listRef,
    timestampFormat,
    routeThreadKey,
    threadRef: citationThreadRef,
    markdownCwd,
    resolvedTheme,
    workspaceRoot,
    skills,
    runs,
    activeThreadEnvironmentId,
    onRevertToTurnCount,
    onRunShellCommand,
    findActive,
    onImageExpand,
    onFileOpen,
    onUseArtifactTemplate,
    onSendAppMessage,
    onAppFullscreenChange,
    onFileDownload,
    openPullRequest,
    onOpenTurnDiff,
    onOpenThread,
    renderHtmlRender,
    turnItemSource,
    workflowOpening,
    onForkFromRun,
    onToggleTurnFold,
    onToggleAttemptFold,
    onToggleWorkGroup,
    onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
    onCancelWorktreeSetup: onCancelWorktreeSetup ?? null,
    retryableWorkspacePreparationRunIds,
    onRetryWorkspacePreparation: onRetryWorkspacePreparation ?? null,
    onWorktreeSetupWorkLocally: onWorktreeSetupWorkLocally ?? null,
    onOpenWorktreeSetupTerminal: onOpenWorktreeSetupTerminal ?? null,
    workGroupViewState,
  };
  const compactionAwaitingRow =
    isCompacting &&
    !rows.some(
      (row) =>
        (row.kind === "context-compaction" && row.active) ||
        (row.kind === "working" && row.compacting),
    );
  const backgroundWorktreeSetup =
    worktreeSetup !== null &&
    worktreeSetup.phase === "running" &&
    worktreeSetupAgentStarted(worktreeSetup) &&
    latestRun?.startedAt != null
      ? worktreeSetup
      : null;
  const activityState: TimelineRowActivityState = {
    isWorking,
    isCompacting: compactionAwaitingRow,
    isRevertingCheckpoint,
    backgroundWorktreeSetup,
    awaitingUser: awaitingUser !== null,
    isPreparingWorktree,
    latestRunId: latestRun?.runId ?? null,
  };
  // Mounted in both the empty and filled timeline so a thread's first turn
  // starts from a baseline instead of a fresh, silent region.
  const activityAnnouncer = (
    <ThreadActivityAnnouncer
      threadKey={announceTurnStatus ? listIdentityKey : null}
      status={awaitingUser ?? (isWorking ? "working" : "idle")}
      requestId={awaitingRequestId}
      runId={announcedRun?.runId ?? null}
      runStatus={announcedRun?.status ?? null}
      detailBehind={detailBehindShell}
    />
  );
  const listHeaderLeadingContent =
    parentThreadLink === null ? (
      topFadeEnabled ? (
        TIMELINE_LIST_FADE_HEADER
      ) : (
        TIMELINE_LIST_HEADER
      )
    ) : (
      <div className="messages-timeline-row-frame">
        <div className="chat-content-lane pt-1 sm:pt-2">
          <TimelineSystemDivider
            label="Subagent of"
            detail={
              parentThreadLink.environmentLabel === undefined
                ? parentThreadLink.title
                : `${parentThreadLink.title} on ${parentThreadLink.environmentLabel}`
            }
            icon={BotIcon}
            {...(parentThreadLink.open === undefined
              ? {}
              : { actionLabel: "Open parent thread", onAction: parentThreadLink.open })}
          />
        </div>
      </div>
    );
  const listHeader = (
    <>
      {parentThreadLink === null ? listHeaderLeadingContent : null}
      {historyControls ? <TimelineHistoryControl {...historyControls} /> : null}
      {parentThreadLink !== null ? listHeaderLeadingContent : null}
    </>
  );

  const canvas = useChatCanvas();
  const registerTimeline = canvas?.registerTimeline;
  const setTimelineList = (list: LegendListRef | null) => {
    listRef.current = list;
    const scrollNode: HTMLElement | null = list?.getScrollableNode() ?? null;
    registerTimeline?.(scrollNode);
    const viewport = scrollNode ? attachTimelineViewport(scrollNode) : null;
    viewportRef.current = viewport;
    const detachViewport = viewport ? onViewportAttach?.(viewport) : undefined;
    const stopRememberingRelease = viewport?.onFollowReleased(rememberReleasedPosition);
    let contentSizeFrame: number | null = null;
    // LegendList lays rows out from layout effects; the next frame sees them settled.
    let scheduledData: unknown = null;
    const scheduleContentSizeChanged = () => {
      if (!list) return;
      const laidOutData = list.getState().data;
      if (contentSizeFrame !== null) {
        if (scheduledData === laidOutData) return;
        cancelAnimationFrame(contentSizeFrame);
      }
      scheduledData = laidOutData;
      contentSizeFrame = requestAnimationFrame(() => {
        contentSizeFrame = null;
        handleContentSizeChanged(laidOutData);
      });
    };
    const stopListeningToContentSize = list
      ?.getState()
      .listen("totalSize", () => scheduleContentSizeChanged());
    scheduleContentSizeChanged();
    return () => {
      stopListeningToContentSize?.();
      stopRememberingRelease?.();
      onContentOverflowChange?.(false);
      if (contentSizeFrame !== null) cancelAnimationFrame(contentSizeFrame);
      detachViewport?.();
      viewport?.dispose();
      if (viewportRef.current === viewport) viewportRef.current = null;
      // Refresh frames only read the list; disclosure frames still run so the
      // settle flag clears.
      cancelContentOverflowFrame();
      if (minimapRefreshFrameRef.current !== null) {
        cancelAnimationFrame(minimapRefreshFrameRef.current);
        minimapRefreshFrameRef.current = null;
      }
      listRef.current = null;
      registerTimeline?.(null);
    };
  };

  useThreadFindPositionReader({
    threadKey: listIdentityKey,
    navigate: navigateTimeline,
    timelineViewportElement,
    findFoldRunIds,
    timelineEntries,
    latestRun,
    runningRunId,
    isWorking,
    runlessWorkActive,
    rows,
    contentInsetEndAdjustment,
  });

  useThreadFindNavigation({
    // Find reveals its match only after the opening restore settles; both
    // scroll the list directly, so the restore would otherwise pull it back.
    listReady: findListReady && !restoringThreadPosition,
    historyControls,
    entries: timelineEntries,
    container: timelineViewportElement,
    query: normalizedFindQuery,
    match: activeFindMatch,
    navigationId: findNavigationId,
    rowIndex: activeFindMatch ? rows.findIndex((row) => row.id === activeFindMatch.entryId) : -1,
    listRef,
    contentInsetEndAdjustment,
  });

  // LegendList moves rows one commit late; per-row providers prevent thread context leaks.
  const onAudioPlaybackChange = (rowId: string, event: SyntheticEvent) => {
    const audio = event.target;
    if (!(audio instanceof HTMLAudioElement)) return;
    setPlayingAudioRows((current) => {
      const playing = !audio.paused && !audio.ended;
      if (playing === current.has(audio)) return current;
      const next = new Map(current);
      if (playing) next.set(audio, rowId);
      else next.delete(audio);
      return next;
    });
  };
  const onAudioUnmount = useStableCallback((audio: HTMLAudioElement) => {
    setPlayingAudioRows((current) => {
      if (!current.has(audio)) return current;
      const next = new Map(current);
      next.delete(audio);
      return next;
    });
  });
  const renderItem = ({ item }: { item: MessagesTimelineRow }) => (
    <TimelineRowCtx value={sharedState}>
      <div
        className="messages-timeline-row-frame"
        onPlayCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onPauseCapture={(event) => onAudioPlaybackChange(item.id, event)}
        onEndedCapture={(event) => onAudioPlaybackChange(item.id, event)}
      >
        <div
          ref={observeLaneWidth}
          className="@container/chat-lane chat-content-lane overflow-x-clip"
          data-timeline-root="true"
        >
          <AudioPreviewUnmountContext value={onAudioUnmount}>
            <TimelineRowContent row={item} />
          </AudioPreviewUnmountContext>
        </div>
      </div>
    </TimelineRowCtx>
  );
  const listExtraData = { identity: listIdentityKey, rowCount: rows.length, sharedState };
  const timelineListFooter = (
    <TimelineListFooter
      composerInset={anchoredEndSpace ? 0 : contentInsetEndAdjustment}
      onGrow={onFooterGrow}
    >
      {footer}
      {unmatchedPendingApprovals.size > 0 ? (
        <TimelineRowCtx value={sharedState}>
          <div className="messages-timeline-row-frame">
            <div
              className="@container/chat-lane chat-content-lane overflow-x-clip"
              data-timeline-root="true"
            >
              <WorkLogBlock>
                {[...unmatchedPendingApprovals.values()].map((approval) => (
                  <TimelinePendingApprovalRow key={approval.requestId} approval={approval} />
                ))}
              </WorkLogBlock>
            </div>
          </div>
        </TimelineRowCtx>
      ) : null}
    </TimelineListFooter>
  );

  const forwardMinimapWheel = (event: WheelEvent) => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode) forwardWheelToTimeline(event, scrollNode);
  };

  if (showsEmptyState) {
    if (hideEmptyPlaceholder) {
      return (
        <>
          {activityAnnouncer}
          <div className="h-full min-h-0 bg-background" data-timeline-loading="true" />
        </>
      );
    }
    return (
      <>
        {activityAnnouncer}
        <div
          className="flex h-full items-center justify-center ps-(--chat-lane-inset-start) pe-(--chat-lane-inset-end)"
          style={{ paddingBottom: emptyPlaceholderInset }}
        >
          <p className="text-sm text-muted-foreground">Send a message to start the conversation.</p>
        </div>
      </>
    );
  }

  return (
    <>
      {activityAnnouncer}
      <MarkdownFindContext value={findActive}>
        <TimelineRowActivityCtx value={activityState}>
          <TooltipScrollDismissArea
            ref={attachTimelineViewportElement}
            className="relative h-full min-h-0"
            data-assistant-citation-viewport="true"
          >
            {onCiteAssistantText && citationThreadRef ? (
              <AssistantSelectionToolbar
                viewport={timelineViewportElement}
                threadRef={citationThreadRef}
                onCite={onCiteAssistantText}
              />
            ) : null}
            <LegendList<MessagesTimelineRow>
              ref={setTimelineList}
              data={rows}
              extraData={listExtraData}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              renderItem={renderItem}
              estimatedItemSize={90}
              initialScrollAtEnd={
                !findActive && citationRequest === null && rememberedPosition?.atEnd !== false
              }
              // Legend needs a data refresh to mount new pins without a scroll event.
              dataVersion={`${readyCitationRequest?.key ?? listIdentityKey}:${alwaysRenderKeys.join(",")}`}
              {...(alwaysRender ? { alwaysRender } : {})}
              onLoad={handleListLoad}
              {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
              contentInsetEndAdjustment={anchoredEndSpace ? contentInsetEndAdjustment : 0}
              maintainScrollAtEnd={
                citationPositioning ||
                (restoringThreadPosition && rememberedPosition?.atEnd === false) ||
                anchoredEndSpace ||
                !liveFollowEnabled ||
                fullscreenAppRowId !== null ||
                disclosureToggleSettling
                  ? false
                  : isWorking && !prefersReducedMotion && settlingListIdentity === null
                    ? TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH
                    : TIMELINE_MAINTAIN_SCROLL_AT_END
              }
              maintainVisibleContentPosition={
                findActive ||
                citationPositioning ||
                (restoringThreadPosition && rememberedPosition?.atEnd === false)
                  ? false
                  : maintainVisibleContentPosition
              }
              maintainScrollAtEndThreshold={1}
              onScroll={handleScroll}
              onItemSizeChanged={handleItemSizeChanged}
              // A viewport resize changes how much of the content fits.
              onLayout={reportContentOverflow}
              className={cn(
                "messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
                topFadeEnabled && "topbar-scroll-fade",
              )}
              ListHeaderComponent={listHeader}
              ListFooterComponent={timelineListFooter}
            />
            <TimelineMinimap
              items={minimapItems}
              hasPersistentGutter={minimapHasPersistentGutter}
              hitStripWidth={minimapHitStripWidth}
              currentIndex={minimapCurrentIndex}
              stripMap={minimapStripMap}
              onWheel={forwardMinimapWheel}
              onSelect={(item) => {
                navigateTimeline();
                void listRef.current?.scrollToIndex({
                  index: item.rowIndex,
                  animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                  viewOffset: 24,
                });
              }}
            />
          </TooltipScrollDismissArea>
        </TimelineRowActivityCtx>
      </MarkdownFindContext>
    </>
  );
});

function TimelineHistoryControl(props: MessagesTimelineHistoryControls) {
  if (!props.hasMoreHistory && props.error === null) {
    return null;
  }
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
        {props.hasMoreHistory ? (
          <button
            type="button"
            disabled={props.loading}
            aria-label="Load earlier turns"
            onClick={() => props.onLoadEarlier()}
            className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          >
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
            <span className="shrink-0">
              {props.loading ? "Loading earlier turns…" : "Load earlier turns"}
            </span>
            <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          </button>
        ) : null}
        {props.error !== null ? (
          <p role="status" className="text-center text-muted-foreground text-xs">
            {props.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function isMessageRow(row: MessagesTimelineRow) {
  return row.kind === "message" && row.message.role !== "system";
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// LegendList averages by type; length buckets prevent inflated estimates and nested-update loops.
function getItemType(item: MessagesTimelineRow) {
  if (item.kind !== "message") return item.kind;
  const lengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return `message:${item.message.role}:${lengthBucket}`;
}

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isSubagentGroup = row.kind === "event" && row.projectedItem.item.type === "subagent";
  const isWorkLogRow =
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "thinking";
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" || row.kind === "work-live" || row.kind === "thinking") &&
    row.expanded === true;

  return (
    <div
      className={cn(
        isWorkLogRow || isSubagentGroup
          ? undefined
          : row.kind === "turn-fold" || row.kind === "working"
            ? "pb-1.5"
            : (row.kind === "message" &&
                  row.message.role === "assistant" &&
                  !row.showAssistantMeta) ||
                row.kind === "worktree-setup" ||
                row.kind === "event" ||
                row.kind === "attempt-fold" ||
                row.kind === "html-render" ||
                row.kind === "mcp-app"
              ? "pb-2"
              : "pb-4",
        (row.kind === "message" && row.message.role === "assistant") ||
          row.kind === "assistant-meta"
          ? "group/assistant"
          : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={
        row.kind === "message" || row.kind === "assistant-meta" ? row.message.id : undefined
      }
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {isWorkLogRow ? (
        <WorkLogBlock
          continues={row.continuesWorkLog}
          layout={
            isExpandedToolGroup
              ? "group-content"
              : isExpandedToolGroupHeader
                ? "group-header"
                : "standalone"
          }
        >
          {row.kind === "work" ? (
            <WorkGroupSection
              anchorKey={row.id}
              groupedEntries={row.groupedEntries}
              isExpandedToolGroup={row.isExpandedToolGroup}
              displayLabel={row.displayLabel}
            />
          ) : null}
          {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
          {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
          {row.kind === "thinking" ? <ThinkingTimelineRow row={row} /> : null}
        </WorkLogBlock>
      ) : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "attempt-fold" ? <AttemptFoldTimelineRow row={row} /> : null}
      {row.kind === "context-compaction" ? <ContextCompactionTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserMessageRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "assistant-meta" ? <AssistantMetaTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "html-render" ? <HtmlRenderTimelineRow row={row} /> : null}
      {row.kind === "mcp-app" ? <McpAppTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "worktree-setup" ? <WorktreeSetupTimelineRow row={row} /> : null}
      {row.kind === "event" ? <V2EventTimelineRow row={row} /> : null}
    </div>
  );
});

function WorktreeSetupTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "worktree-setup" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const terminalId = row.snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  return (
    <WorktreeSetupCard
      snapshot={row.snapshot}
      embedded={row.embedded}
      onCancel={row.embedded ? null : ctx.onCancelWorktreeSetup}
      onWorkLocally={
        !row.embedded && row.snapshot.phase === "running" ? ctx.onWorktreeSetupWorkLocally : null
      }
      onOpenTerminal={onOpenTerminal}
    />
  );
}

function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  const label =
    row.title && row.label.startsWith("Context compacted")
      ? row.title + row.label.slice("Context compacted".length)
      : row.label;
  const content = (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <Minimize2Icon aria-hidden="true" className="size-3" />
      )}
      {row.tokenCounts ? (
        <>
          {row.title ?? "Context compacted"} {row.tokenCounts.before}
          <ArrowRightIcon aria-hidden="true" className="size-3" />
          {row.tokenCounts.after} tokens
        </>
      ) : (
        label
      )}
      {row.failure ? (
        <span className="min-w-0 truncate opacity-80">&middot; {row.failure}</span>
      ) : null}
    </span>
  );
  return (
    <div
      role="separator"
      aria-label={row.failure ? `${label}: ${row.failure}` : label}
      className={cn(
        "mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-xs",
        row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
      <span
        ref={row.active ? observeVisibleAnimation : undefined}
        className="relative min-w-0 overflow-hidden"
      >
        {content}
        {row.active ? <ActivityShimmerOverlay>{content}</ActivityShimmerOverlay> : null}
      </span>
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
    </div>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.runId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <MorphIcon className="size-3.5" icon={row.expanded ? ChevronDown : ChevronRight} />
      </button>
      <TimelineRowTimestamp
        createdAt={row.createdAt}
        timestampFormat={ctx.timestampFormat}
        className="ms-auto"
      />
    </div>
  );
}

function AttemptFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "attempt-fold" }> }) {
  const ctx = use(TimelineRowCtx);

  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      data-scroll-anchor-ignore
      data-superseded-attempt-id={row.attemptId}
      onClick={() => ctx.onToggleAttemptFold(row.attemptId)}
      className="flex w-full cursor-pointer select-none items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      <MorphIcon
        className="size-3.5 shrink-0 text-muted-foreground"
        icon={row.expanded ? ChevronDown : ChevronRight}
      />
      <span className="text-xs font-medium text-foreground/80">{row.label}</span>
      <span className="text-2xs text-muted-foreground">Cut off by a steer</span>
    </button>
  );
}

  const renderEntry = ({ item }: { item: TimelineWorkEntry }) => (
    <SimpleWorkEntryRow key={item.id} workEntry={item} workspaceRoot={workspaceRoot} />
  );

  const updateExpandedContentHeight = () => {
    const state = listRef.current?.getState();
    let height = 0;
    for (const entryId of viewState.expandedEntries) {
      if (state?.indexByKey(entryId) === undefined) continue;
      height += Math.max(
        0,
        (state.sizes.get(entryId) ?? compactWorkEntryHeight) - compactWorkEntryHeight,
      );
    }
    setExpandedContentHeight(height);
  };

  useLayoutEffect(updateExpandedContentHeight, [entries, updateExpandedContentHeight]);

  return (
    <WorkGroupViewCtx value={groupView}>
      <WorkLogList>
        <LegendList
          ref={listRef}
          data={entries}
          extraData={workspaceRoot}
          keyExtractor={workEntryKey}
          renderItem={renderEntry}
          estimatedItemSize={compactWorkEntryHeight}
          drawDistance={240}
          recycleItems
          {...(initialScrollIndex ? { initialScrollIndex } : {})}
          maintainScrollAtEnd={
            appendState.follow ? { animated: false, on: { dataChange: true } } : false
          }
          maintainScrollAtEndThreshold={1 / Math.max(1, fades.viewportHeight)}
          // Measure the restored row even when an intra-row offset puts its
          // estimated bounds outside the list's small bootstrap render window.
          {...(restoringPosition && initialScrollIndex
            ? { alwaysRender: { indices: [initialScrollIndex.index] } }
            : {})}
          maintainVisibleContentPosition
          onLoad={handleLoad}
          onScroll={handleScroll}
          onLayout={updateScrollFades}
          onItemSizeChanged={updateExpandedContentHeight}
          tabIndex={0}
          role="region"
          aria-label="Tool calls"
          data-tool-group-scroll
          style={{ maxHeight: `calc(min(18rem, 50dvh) + ${expandedContentHeight}px)` }}
          className={cn(
            "scrollbar-gutter-stable scroll-py-6 overflow-x-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
            getVirtualizedScrollFadeClassName(fades),
          )}
        />
      </WorkLogList>
    </WorkGroupViewCtx>
  );
}

const workEntryKey = (entry: TimelineWorkEntry) => entry.id;

function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

const failedToolIconClassName = "text-tool-error-icon/40";

function toolIconAcceptsTint(toolIcon: ToolActivityIcon | undefined): boolean {
  return toolIcon === undefined;
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isCompacting, isPreparingWorktree, backgroundWorktreeSetup } =
    use(TimelineRowActivityCtx);
  const shimmer = isPreparingWorktree || isCompacting;
  const label = isPreparingWorktree ? (
    "Setting up worktree…"
  ) : isCompacting ? (
    <CompactingLabel />
  ) : row.createdAt ? (
    <>
      Working for <WorkingTimer createdAt={row.createdAt} />
    </>
  ) : (
    "Working..."
  );
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          ref={shimmer ? observeVisibleAnimation : undefined}
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
        >
          {label}
          {shimmer ? <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay> : null}
        </span>
        {backgroundWorktreeSetup ? (
          <BackgroundWorktreeSetupChip snapshot={backgroundWorktreeSetup} />
        ) : null}
      </div>
    </div>
  );
}

function BackgroundWorktreeSetupChip({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  const ctx = use(TimelineRowCtx);
  const terminalId = snapshot.setupScript?.terminalId ?? null;
  const openTerminal = ctx.onOpenWorktreeSetupTerminal;
  const onOpenTerminal = openTerminal && terminalId ? () => openTerminal(terminalId) : null;
  const scriptName = snapshot.setupScript?.name ?? "Setup script";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="micro"
            className="ml-auto min-w-0 shrink-0"
            aria-label={`${scriptName} is still running. Show setup progress.`}
          />
        }
      >
        <Spinner className="size-3 shrink-0" />
        <span className="truncate">{scriptName}</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <WorktreeSetupCard
          snapshot={snapshot}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />
      </PopoverPopup>
    </Popover>
  );
}

function CompactingLabel() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Minimize2Icon aria-hidden="true" className="size-3" />
      Compacting…
    </span>
  );
}

function ThinkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "thinking" }> }) {
  const ctx = use(TimelineRowCtx);
  const { isCompacting, isPreparingWorktree } = use(TimelineRowActivityCtx);
  if (isPreparingWorktree || isCompacting) return <WorkLogRow label="" />;
  const activity = <LiveActivityRow label="Thinking" iconName="brain" active shimmer />;
  const { groupId } = row;
  if (groupId === undefined) return activity;
  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded === true}
      onClick={() => ctx.onToggleWorkGroup(groupId, row.id)}
    >
      {activity}
    </button>
  );
}

function LiveActivityRow({
  label,
  iconName,
  toolIcon,
  failed = false,
  active = false,
  shimmer = false,
}: {
  label: ReactNode;
  iconName?: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  active?: boolean;
  shimmer?: boolean;
}) {
  const animated = active && !failed;
  const showShimmer = animated && shimmer;
  return (
    <div
      ref={animated ? observeVisibleAnimation : undefined}
      className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
    >
      <LiveActivityContent
        label={label}
        iconName={iconName}
        toolIcon={toolIcon}
        failed={failed}
        announceFailure={failed}
        active={animated && !shimmer}
      />
      {showShimmer ? (
        <ActivityShimmerOverlay>
          <LiveActivityContent label={label} iconName={iconName} toolIcon={toolIcon} highlighted />
        </ActivityShimmerOverlay>
      ) : null}
    </div>
  );
}

function LiveActivityContent({
  label,
  iconName,
  toolIcon,
  failed = false,
  announceFailure = false,
  active = false,
  highlighted = false,
}: {
  label: ReactNode;
  iconName: WorkEntryIconName | undefined;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean;
  announceFailure?: boolean;
  active?: boolean;
  highlighted?: boolean;
}) {
  const showTrailingFailureMark =
    failed && iconName !== undefined && !toolIconAcceptsTint(toolIcon);

  return (
    <WorkLogRow
      icon={
        iconName ? (
          <span
            className={cn(
              "flex size-4 items-center justify-center",
              failed
                ? failedToolIconClassName
                : highlighted
                  ? "text-foreground"
                  : "text-icon-muted",
            )}
            role={announceFailure ? "img" : undefined}
            aria-label={announceFailure ? "Tool call failed" : undefined}
          >
            <ToolActivityIconView
              icon={toolIcon}
              fallbackName={iconName}
              className="block size-4 shrink-0 stroke-2"
              muted={!highlighted}
            />
          </span>
        ) : null
      }
      label={
        <span
          className={cn(
            "block truncate",
            highlighted && "text-foreground",
            active && "live-tool-shine",
          )}
        >
          {label}
        </span>
      }
      trailing={
        showTrailingFailureMark ? (
          <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
        ) : null
      }
    />
  );
}

function useThreadReadTarget(entry: TimelineWorkEntry, environmentId: EnvironmentId) {
  const rawThreadId = threadReadTargetId(entry);
  const threadId = rawThreadId === null ? null : ThreadId.make(rawThreadId);
  const shell = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const title = threadReadTargetTitle(shell);
  return threadId && title ? { threadId, title } : null;
}

function threadReadLabel(label: string, target: ReturnType<typeof useThreadReadTarget>) {
  const prefix = target && threadReadLabelPrefix(label);
  return prefix ? { ...target, prefix, text: `${prefix} “${target.title}”` } : null;
}

function ThreadReadLabel({
  label,
  environmentId,
  linked,
}: {
  label: NonNullable<ReturnType<typeof threadReadLabel>>;
  environmentId: EnvironmentId;
  linked: boolean;
}) {
  return (
    <span className="flex min-w-0">
      <span className="shrink-0">{label.prefix} “</span>
      {linked ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: label.threadId }}
          className="min-w-0 truncate rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={stopRowToggle}
          onKeyDown={stopRowToggle}
        >
          {label.title}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{label.title}</span>
      )}
      <span className="shrink-0">”</span>
    </span>
  );
}

function LiveWorkEntryTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "work-live" }> }) {
  const ctx = use(TimelineRowCtx);
  const threadTarget = useThreadReadTarget(row.entry, ctx.activeThreadEnvironmentId);
  const questionHeading = row.entry.questionAnswer
    ? getQuestionTextPreview(row.entry.questionAnswer)
    : "";
  const label = questionHeading || liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const threadLabel = threadReadLabel(label, threadTarget);

  const failed = workEntryDisplayIndicatesToolFailure(row.entry);
  const thoughtLine = row.thought && !row.expanded ? liveThoughtLine(row.thought.detail ?? "") : "";
  const thoughtIsStatus = thoughtLine !== "" && row.entry === row.thought;

  return (
    <button
      type="button"
      className={cn(
        "group/live-work flex w-full max-w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        thoughtLine ? "flex-col items-start" : "min-h-6 items-center",
      )}
      aria-label={
        failed
          ? `${thoughtLine ? `${thoughtLine} ` : ""}${threadLabel?.text ?? label}, tool call failed`
          : undefined
      }
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      {thoughtLine ? (
        <WorkLogRow
          icon={
            <span className="flex size-4 items-center justify-center text-icon-muted">
              <ToolActivityIconView
                icon={undefined}
                fallbackName="brain"
                className="block size-4 shrink-0 stroke-2"
                muted
              />
            </span>
          }
          label={
            <span className="line-clamp-4">
              <ChatMarkdown
                inline
                text={thoughtLine}
                cwd={ctx.markdownCwd}
                parseRawHtml={false}
                extraRemarkPlugins={[[remarkThoughtPreview, "Thought"]]}
              />
            </span>
          }
          wrapLabel
        />
      ) : null}
      <LiveActivityRow
        label={
          thoughtIsStatus ? (
            row.active ? (
              "Thinking"
            ) : (
              "Thought"
            )
          ) : row.entry.questionAnswer && hasQuestionAnswer(row.entry.questionAnswer) ? (
            <span className="flex min-w-0 gap-1.5">
              <span className="min-w-0 truncate">{label}</span>
              <span className="min-w-0 truncate text-foreground">
                {getQuestionAnswerPreview(row.entry.questionAnswer)}
              </span>
            </span>
          ) : row.entry.itemType === "reasoning" ? (
            <ChatMarkdown
              inline
              text={row.entry.detail ?? label}
              cwd={ctx.markdownCwd}
              parseRawHtml={false}
              extraRemarkPlugins={[[remarkThoughtPreview, row.active ? "Thinking" : "Thought"]]}
            />
          ) : threadLabel ? (
            <ThreadReadLabel
              label={threadLabel}
              environmentId={ctx.activeThreadEnvironmentId}
              linked={false}
            />
          ) : (
            label
          )
        }
        iconName={workEntryIconName(row.entry)}
        toolIcon={row.entry.toolIcon ?? row.entry.toolSource?.icon}
        failed={failed}
        active={row.active}
      />
    </button>
  );
}

function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "pull-request":
    case "link-pr":
    case "unlink-pr":
    case "list-prs":
    case "watch-pr":
    case "unwatch-pr":
      return "pull-request";
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "thread-create":
      return "t3-code";
    case "browser":
      return "browser";
    case "device":
      return "device";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "reasoning":
      return "brain";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <WorkGroupHeader
      label={row.summary}
      iconName={row.summaryToolIcon ?? row.toolSurface ?? toolGroupSummaryIconName(row.summaryKind)}
      toolIcon={row.toolIcon}
      failed={row.hasFailure}
      expanded={row.expanded}
      createdAt={row.createdAt}
      timestampFormat={ctx.timestampFormat}
      onToggle={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    />
  );
}

function WorkGroupHeader(props: {
  label: string;
  iconName: WorkEntryIconName;
  toolIcon?: ToolActivityIcon | undefined;
  failed?: boolean | undefined;
  active?: boolean | undefined;
  expanded: boolean;
  createdAt: string;
  timestampFormat: TimestampFormat;
  onToggle: () => void;
}) {
  return (
    <WorkLogButton
      ref={props.active && !props.failed ? observeVisibleAnimation : undefined}
      aria-label={props.failed ? `${props.label}, tool call failed` : props.label}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
      icon={
        <ToolActivityIconView
          icon={props.toolIcon}
          fallbackName={props.iconName}
          className="size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <span className={cn("block truncate", props.active && !props.failed && "live-tool-shine")}>
          {props.label}
        </span>
      }
      trailing={
        <TimelineRowTimestamp createdAt={props.createdAt} timestampFormat={props.timestampFormat} />
      }
    />
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.runId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const allDirectoriesExpanded = persistedExpanded ?? false;

  const thread = useThreadShell(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);

  return (
    <ChangedFilesCard
      runId={turnSummary.runId}
      files={checkpointFiles}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() =>
        setExpanded(routeThreadKey, turnSummary.runId, !allDirectoriesExpanded)
      }
      onOpenTurnDiff={onOpenTurnDiff}
      onFileContextMenu={(filePath, event) =>
        onFileContextMenu(
          {
            environmentId: ctx.activeThreadEnvironmentId,
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            repositoryRoot:
              thread?.worktreePath == null
                ? activeProject?.repositoryIdentity?.rootPath
                : undefined,
          },
          event,
        )
      }
    />
  );
}

function UserMessageMentionChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "mention" }>;
  copyMarkdown: string;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="mention"
            render={<button type="button" />}
            aria-label={`Preview ${props.record.path}`}
            data-markdown-copy={props.copyMarkdown}
            onClick={() => {
              if (ctx.threadRef)
                useRightPanelStore.getState().openFile(ctx.threadRef, props.record.path);
            }}
          >
            <WorkspaceEntryIcon
              path={props.record.path}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.workspaceRoot}
              theme={ctx.resolvedTheme}
            />
            <ContextChipLabel>{props.record.label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup>
        <WorkspaceEntryTooltip
          path={props.record.path}
          environmentId={ctx.activeThreadEnvironmentId}
          cwd={ctx.workspaceRoot}
        />
      </TooltipPopup>
    </Tooltip>
  );
}

function UserMessageContextChip(props: {
  icon: ReactNode;
  label: string;
  kindLabel?: string;
  copyMarkdown: string;
  tooltip?: string;
  kind: ContextChipKind;
}) {
  return (
    <ContextChipShell
      kind={props.kind}
      icon={props.icon}
      label={props.label}
      aria-label={props.kindLabel ? `${props.kindLabel}, ${props.label}` : undefined}
      data-markdown-copy={props.copyMarkdown}
      tooltip={props.tooltip}
    />
  );
}

function UserMessagePullRequestContextChip(props: {
  record: Extract<KnownComposerContextRecord, { kind: "review-comment" }>;
  copyMarkdown: string;
  kind: ContextChipKind;
}) {
  const { activeThreadEnvironmentId, openPullRequest } = use(TimelineRowCtx);
  const metadata = props.record.pullRequest;
  if (metadata === undefined) return null;
  return (
    <PullRequestChip
      metadata={metadata}
      environmentId={activeThreadEnvironmentId}
      label={reviewCommentContextLabel(props.record)}
      kindLabel={pullRequestContextKindLabel(props.record)}
      kind={props.kind}
      copyMarkdown={props.copyMarkdown}
      onOpen={openPullRequest}
    />
  );
}

function UserMessagePreviewAnnotationDetails(props: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  image: ChatImageAttachment | null;
}) {
  const ctx = use(TimelineRowCtx);
  const visibleElements = props.record.elements ?? [];
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="block max-h-64 w-full cursor-zoom-in overflow-hidden border-b border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="max-h-64 w-full object-contain"
          />
        </button>
      ) : (
        <div className="border-b border-border/70 bg-muted/40 px-3 py-2 text-secondary-label text-xs">
          Screenshot unavailable
        </div>
      )}
      <div className="min-w-0 px-3 py-2.5">
        <div className="text-message-foreground text-xs font-medium">
          {props.record.pageTitle?.trim() || props.record.pageUrl || "Preview annotation"}
        </div>
        {props.record.comment ? (
          <div className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">
            {props.record.comment}
          </div>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-secondary-label text-3xs">
          {props.record.targetSummary ? (
            <span className="truncate">{props.record.targetSummary}</span>
          ) : null}
          {(props.record.styleChanges?.length ?? 0) > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.record.styleChanges?.length ?? 0}
            </span>
          ) : null}
        </div>
        {visibleElements.length > 0 ? (
          <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
            {visibleElements.map((element) => {
              const source = element.source;
              const sourceLabel = source?.fileName
                ? `${source.fileName}${source.lineNumber === null ? "" : `:${source.lineNumber}`}`
                : null;
              return (
                <div
                  key={`${element.selector}\u0000${element.tagName}\u0000${sourceLabel ?? ""}\u0000${element.htmlPreview}`}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <code className="truncate text-message-foreground">
                      {element.selector || `<${element.tagName}>`}
                    </code>
                    {sourceLabel ? (
                      <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
                    ) : null}
                  </div>
                  {element.htmlPreview?.trim() ? (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1.5 text-3xs leading-relaxed">
                      {element.htmlPreview.trim()}
                    </pre>
                  ) : null}
                </div>
              );
            })}
            {(props.record.elements?.length ?? 0) > visibleElements.length ? (
              <div className="text-secondary-label text-3xs">
                {(props.record.elements?.length ?? 0) - visibleElements.length} more selected
                elements
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMessageElementDetails({
  record,
}: {
  record: Extract<KnownComposerContextRecord, { kind: "element" }>;
}) {
  const sourceLabel = record.source?.fileName
    ? `${record.source.fileName}${record.source.lineNumber === null ? "" : `:${record.source.lineNumber}`}`
    : null;
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      <div className="border-b border-border/70 px-3 py-2.5">
        <div className="truncate text-message-foreground text-xs font-medium">
          {record.pageTitle?.trim() || record.pageUrl}
        </div>
        <div className="mt-0.5 truncate text-secondary-label text-3xs">{record.pageUrl}</div>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <code className="truncate text-message-foreground">
            {record.selector || `<${record.tagName}>`}
          </code>
          {sourceLabel ? (
            <span className="ml-auto shrink-0 text-secondary-label">{sourceLabel}</span>
          ) : null}
        </div>
        {record.htmlPreview?.trim() ? (
          <div className="flex h-40 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="element.html" text={record.htmlPreview} />
          </div>
        ) : null}
        {record.styles?.trim() ? (
          <div className="flex h-32 flex-col overflow-hidden rounded border border-border">
            <ReadOnlySourcePreview name="styles.css" text={record.styles} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface UserMessageContextRenderContext {
  reference: ChatMarkdownContextReference;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  resolvedTheme: "light" | "dark";
  copyMarkdown: string;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
}

function UnavailableUserMessageContextChip(props: UserMessageContextRenderContext) {
  return (
    <UnresolvedChip
      label={props.reference.label}
      copyMarkdown={props.copyMarkdown}
      tooltip="This context is no longer available."
    />
  );
}

const userMessageContextPresentationRegistry = createContextPresentationRegistry<
  KnownComposerContextRecord,
  UserMessageContextRenderContext,
  ReactNode
>({
  requiredKinds: COMPOSER_CONTEXT_KINDS,
  handlers: [
    {
      kind: "mention",
      canRender: (record) => record.kind === "mention",
      render: (record, context) =>
        record.kind === "mention" ? (
          <UserMessageMentionChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "skill",
      canRender: (record) => record.kind === "skill",
      render: (record, context) =>
        record.kind === "skill" ? (
          <UserMessageContextChip
            icon={<SkillChipIcon />}
            label={record.label || record.name}
            kindLabel="Skill"
            tooltip={`$${record.name}`}
            copyMarkdown={context.copyMarkdown}
            kind="skill"
          />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "thread",
      canRender: (record) => record.kind === "thread",
      render: (record, context) =>
        record.kind === "thread" ? (
          <ThreadContextChip record={record} copyMarkdown={context.copyMarkdown} />
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "image",
      canRender: (record, context) =>
        record.kind === "image" &&
        context.attachment !== null &&
        isImageAttachment(context.attachment),
      render: (record, context) => {
        if (
          record.kind !== "image" ||
          context.attachment === null ||
          !isImageAttachment(context.attachment)
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        return (
          <ImageChipButton
            name={record.name}
            previewUrl={attachment.previewUrl}
            size={formatAttachmentSize(record.sizeBytes)}
            data-markdown-copy={context.copyMarkdown}
            onClick={() => context.onExpandImage(attachment)}
          />
        );
      },
    },
    {
      kind: "file",
      canRender: (record, context) =>
        record.kind === "file" && context.attachment !== null && context.attachment.type === "file",
      render: (record, context) => {
        if (
          record.kind !== "file" ||
          context.attachment === null ||
          context.attachment.type !== "file"
        ) {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const attachment = context.attachment;
        const isVideo = isVideoAttachment(attachment);
        const disabled =
          attachment.downloadable === false && (!isVideo || attachment.previewUrl === undefined);
        const size = formatAttachmentSize(record.sizeBytes);
        return (
          <FileChip
            name={record.name}
            size={size}
            isVideo={isVideo}
            theme={context.resolvedTheme}
            disabled={disabled}
            accessibleLabel={`${isVideo ? "Video" : "File"} attachment, ${record.name}, ${size}`}
            copyMarkdown={context.copyMarkdown}
            onOpen={() =>
              isVideo ? context.onExpandVideo(attachment) : context.onOpenFile(attachment)
            }
            tooltip={`${record.name}\n${size}`}
          />
        );
      },
    },
    {
      kind: "terminal",
      canRender: (record) => record.kind === "terminal",
      render: (record, context, definition) =>
        record.kind === "terminal" ? (
          <span data-markdown-copy={context.copyMarkdown}>
            <TerminalContextInlineChip
              label={record.label}
              terminalLabel={record.terminalLabel}
              lineStart={record.lineStart}
              lineEnd={record.lineEnd}
              text={record.text}
              detailsMode={definition.capabilities.details}
            />
          </span>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "element",
      canRender: (record) => record.kind === "element",
      render: (record, context) =>
        record.kind === "element" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`Browser element, ${record.label}`}
            kind="element"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessageElementDetails record={record} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
    {
      kind: "review-comment",
      canRender: (record) => record.kind === "review-comment",
      render: (record, context) => {
        if (record.kind !== "review-comment") {
          return <UnavailableUserMessageContextChip {...context} />;
        }
        const isPullRequest = isPullRequestSummaryContext(record);
        const label = reviewCommentContextLabel(record);
        const kindLabel = isPullRequest ? pullRequestContextKindLabel(record) : "Review comment";
        const pullRequestState = pullRequestContextDisplayState(record) ?? "unknown";
        if (isPullRequest && record.pullRequest !== undefined) {
          return (
            <UserMessagePullRequestContextChip
              record={record}
              copyMarkdown={context.copyMarkdown}
              kind={PULL_REQUEST_CHIP_KINDS[pullRequestState]}
            />
          );
        }
        return (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`${kindLabel}, ${label}${record.pullRequest ? `, ${record.pullRequest.title}` : ""}`}
            kind={isPullRequest ? PULL_REQUEST_CHIP_KINDS[pullRequestState] : "review-comment"}
            icon={isPullRequest ? <PullRequestGlyph.pullRequest /> : <MessageCircleIcon />}
            label={label}
          >
            <UserMessageReviewCommentCard
              comment={{
                id: record.contextId,
                sectionId: record.sectionId,
                sectionTitle: record.sectionTitle,
                filePath: record.filePath,
                startIndex: record.startIndex,
                endIndex: record.endIndex,
                rangeLabel: record.rangeLabel,
                text: record.text,
                diff: record.diff,
                ...(record.fenceLanguage !== undefined
                  ? { fenceLanguage: record.fenceLanguage }
                  : {}),
                ...(record.pullRequest !== undefined ? { pullRequest: record.pullRequest } : {}),
              }}
            />
          </UserMessageContextPopover>
        );
      },
    },
    {
      kind: "preview-annotation",
      canRender: (record) => record.kind === "preview-annotation",
      render: (record, context) =>
        record.kind === "preview-annotation" ? (
          <UserMessageContextPopover
            copyMarkdown={context.copyMarkdown}
            accessibleLabel={`Preview annotation, ${record.label}`}
            kind="preview-annotation"
            icon={<MousePointerClickIcon />}
            label={record.label}
          >
            <UserMessagePreviewAnnotationDetails record={record} image={context.annotationImage} />
          </UserMessageContextPopover>
        ) : (
          <UnavailableUserMessageContextChip {...context} />
        ),
    },
  ],
  fallback: (_kind, _record, context) => <UnavailableUserMessageContextChip {...context} />,
});

function UserMessageContextReferenceChip(props: {
  reference: ChatMarkdownContextReference;
  record: KnownComposerContextRecord | undefined;
  annotationImage: ChatImageAttachment | null;
  attachment: ChatImageAttachment | ChatFileAttachment | null;
  onExpandImage: (image: ChatImageAttachment) => void;
  onExpandVideo: (file: ChatFileAttachment) => void;
  onOpenFile: (file: ChatFileAttachment) => void;
}) {
  const { resolvedTheme } = use(TimelineRowCtx);
  const copyMarkdown = formatComposerContextReference({
    kind: props.reference.kind,
    contextId: props.reference.contextId as ComposerContextId,
    label: props.reference.label,
  });
  return userMessageContextPresentationRegistry.render(props.reference.kind, props.record, {
    reference: props.reference,
    annotationImage: props.annotationImage,
    attachment: props.attachment,
    resolvedTheme,
    copyMarkdown,
    onExpandImage: props.onExpandImage,
    onExpandVideo: props.onExpandVideo,
    onOpenFile: props.onOpenFile,
  });
}

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealForFind = () => setExpanded(true);
  const revealRef = findRevealRef(revealForFind);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;
  const showCollapseControl = canCollapse;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            renderContextReference={props.renderContextReference}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {showCollapseControl || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            showCollapseControl && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {showCollapseControl ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  renderContextReference?: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  if (props.text.length === 0) {
    return null;
  }
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
      parseRawHtml={false}
      renderContextReference={props.renderContextReference}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const renderedAppearance = useRenderedAppearance();
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-2xs text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="wrap-break-word text-sm">
          <ChatMarkdown
            text={comment.text}
            cwd={ctx.markdownCwd}
            skills={ctx.skills}
            parseRawHtml={false}
            lineBreaks
          />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === "files" && (
        <DiffWorkerPoolProvider>
          {renderablePatch.files.map((fileDiff) => (
            <FileDiff
              key={resolveFileDiffPath(fileDiff)}
              fileDiff={fileDiff}
              options={{
                collapsed: false,
                diffStyle: "unified",
                theme: resolveDiffThemeName(renderedAppearance),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
              }}
            />
          ))}
        </DiffWorkerPoolProvider>
      )}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

function handoffRunsSignature(runs: ReadonlyArray<HandoffTimelineRun>): string {
  return runs
    .map(
      (run) =>
        `${run.id}\0${run.providerInstanceId}\0${run.ordinal}\0${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
    )
    .join("\n");
}

function useStableHandoffRuns(
  runs: ReadonlyArray<HandoffTimelineRun>,
): ReadonlyArray<HandoffTimelineRun> {
  const [state, setState] = useState<{
    readonly source: ReadonlyArray<HandoffTimelineRun> | null;
    readonly signature: string;
    readonly value: ReadonlyArray<HandoffTimelineRun>;
  }>({ source: null, signature: "", value: EMPTY_TIMELINE_RUNS });
  if (state.source === runs) return state.value;
  const signature = handoffRunsSignature(runs);
  const value =
    signature === state.signature
      ? state.value
      : runs.map((run) => ({
          id: run.id,
          ordinal: run.ordinal,
          providerInstanceId: run.providerInstanceId,
          modelSelection: run.modelSelection,
        }));
  setState({ source: runs, signature, value });
  return value;
}

type MessagesTimelineRowsInput = MessagesTimelineRowsProjection["input"];

// Expanded-id sets can be rebuilt during render; comparing them by content keeps
// the render-time state update below from repeating forever.
function sameRowsInput(left: MessagesTimelineRowsInput, right: MessagesTimelineRowsInput): boolean {
  for (const key of Object.keys(right) as Array<keyof MessagesTimelineRowsInput>) {
    const previous = left[key];
    const next = right[key];
    if (Object.is(previous, next)) continue;
    if (previous instanceof Set && next instanceof Set && shallow(previous, next)) continue;
    return false;
  }
  return Object.keys(left).length === Object.keys(right).length;
}

/**
 * Rows derived from the previous projection of the same list, so a streamed
 * text update patches its message rows instead of deriving every row again.
 */
function useIncrementalTimelineRows(
  identity: string,
  input: MessagesTimelineRowsInput,
): MessagesTimelineRow[] {
  const [state, setState] = useState(() => ({
    identity,
    input,
    projection: deriveMessagesTimelineRowsWithState(input),
  }));
  if (state.identity === identity && sameRowsInput(state.input, input)) {
    return state.projection.rows;
  }
  const projection = deriveMessagesTimelineRowsWithState(
    input,
    state.identity === identity ? state.projection : null,
  );
  setState({ identity, input, projection });
  return projection.rows;
}

function useStableRows(rows: MessagesTimelineRow[], identity: string): MessagesTimelineRow[] {
  const [state, setState] = useState<{
    readonly identity: string;
    readonly source: MessagesTimelineRow[] | null;
    readonly stable: StableMessagesTimelineRowsState;
  }>({ identity, source: null, stable: { byId: new Map(), result: [] } });
  if (state.identity === identity && state.source === rows) return state.stable.result;
  const stable = computeStableMessagesTimelineRows(
    rows,
    state.identity === identity ? state.stable : { byId: new Map(), result: [] },
  );
  setState({ identity, source: rows, stable });
  return stable.result;
}

type WorkEntryIconName =
  | "bot"
  | "brain"
  | "browser"
  | "check"
  | "circle-alert"
  | "computer"
  | "code"
  | "device"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "search"
  | "square-pen"
  | "terminal"
  | "pull-request"
  | "t3-code"
  | "wrench"
  | "x"
  | "zap";

function BrowserAppIcon({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <circle cx="7.4" cy="7.2" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11.2 7.2h4.3" />
      <path d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ToolActivityIconView(props: {
  icon: ToolActivityIcon | undefined;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { resolvedTheme } = use(TimelineRowCtx);
  const fallbackClassName = cn(props.className, props.muted && "opacity-70 light:brightness-60");
  if (!props.icon) {
    return <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />;
  }
  if (props.icon._tag === "website") {
    const src = toolActivityFaviconUrl(props.icon, resolvedTheme, 32);
    return src ? (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    ) : (
      <WorkEntryIcon name={props.fallbackName} className={fallbackClassName} />
    );
  }
  if (props.icon._tag === "themed-logo") {
    const src =
      resolvedTheme === "dark"
        ? (props.icon.logoUrlDark ?? props.icon.logoUrl)
        : props.icon.logoUrl;
    return (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    );
  }
  return (
    <NativeAppToolActivityIcon
      app={props.icon.app}
      fallbackName={props.fallbackName}
      className={cn(props.className, "size-5")}
      muted={props.muted}
    />
  );
}

function NativeAppToolActivityIcon(props: {
  app: Extract<ToolActivityIcon, { readonly _tag: "native-app" }>["app"];
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const asset = useAssetUrlState(activeThreadEnvironmentId, {
    _tag: "native-app-icon",
    app: props.app,
  });
  if (asset._tag !== "Success") {
    return (
      <WorkEntryIcon
        name={props.fallbackName}
        className={cn(props.className, props.muted && "opacity-70 light:brightness-60")}
      />
    );
  }
  const cacheKey = getProjectFaviconCacheKey(
    activeThreadEnvironmentId,
    JSON.stringify(props.app),
    asset.url,
  );
  return (
    <ToolActivityImageIcon
      key={cacheKey}
      cacheKey={cacheKey}
      src={asset.url}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

const loadedToolActivityIconSrcs = new Map<string, string>();

function ToolActivityImageIcon(props: {
  cacheKey: string;
  src: string;
  fallbackName: WorkEntryIconName;
  className: string;
  muted: boolean;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedToolActivityIconSrcs.get(props.cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== props.src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedToolActivityIconSrcs.get(props.cacheKey) === failedSrc) {
      loadedToolActivityIconSrcs.delete(props.cacheKey);
    }
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };
  return (
    <>
      {displayedSrc === null ? (
        <WorkEntryIcon
          name={props.fallbackName}
          className={cn(props.className, props.muted && "opacity-70 light:brightness-60")}
        />
      ) : null}
      {displayedSrc ? (
        <span
          className={cn(
            props.className,
            "inline-block overflow-hidden rounded-xs bg-background",
            props.muted && "opacity-70",
          )}
        >
          <img
            src={displayedSrc}
            alt=""
            aria-hidden
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn("block size-full object-contain", props.muted && "light:brightness-60")}
            onError={() => handleLoadError(displayedSrc)}
          />
        </span>
      ) : null}
      {isLoading ? (
        <img
          src={props.src}
          alt=""
          aria-hidden
          decoding="async"
          referrerPolicy="no-referrer"
          className="hidden"
          onLoad={() => {
            loadedToolActivityIconSrcs.set(props.cacheKey, props.src);
            setDisplayedSrc(props.src);
          }}
          onError={() => handleLoadError(props.src)}
        />
      ) : null}
    </>
  );
}

function WorkEntryIcon({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "pull-request":
      return <PullRequestGlyph.pullRequest className={className} aria-hidden />;
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "brain":
      return <BrainIcon className={className} aria-hidden />;
    case "browser":
    case "computer":
      return <BrowserAppIcon className={className} />;
    case "code":
      return <Code2Icon className={className} aria-hidden />;
    case "device":
      return <SmartphoneIcon className={className} aria-hidden />;
    case "t3-code":
      return <T3Wordmark className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "search":
      return <SearchIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "brain",
      className: "text-icon-muted",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>([visibleLabel.trim()]);
  const addBlock = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) {
    const input =
      workEntry.structuredPayload?.type === "dynamic_tool"
        ? workEntry.structuredPayload.input
        : workEntry.toolData !== null &&
            typeof workEntry.toolData === "object" &&
            "input" in workEntry.toolData
          ? workEntry.toolData.input
          : undefined;
    if (input !== undefined) addBlock(`Tool input\n${JSON.stringify(input, null, 2)}`);
  }
  const command = workEntry.command?.trim();
  const raw = workEntryRawCommand(workEntry);
  if (command === visibleLabel.trim()) {
    seen.add(command);
  } else {
    addBlock(raw ?? command);
  }
  const detail = workEntry.detail?.trim();
  if (detail !== viewedImagePath?.trim()) {
    addBlock(detail);
  }
  const viewedImagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath.trim(), formatWorkspaceRelativePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const changedFiles = (workEntry.changedFiles ?? []).flatMap((filePath) => {
    const formattedPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
    return viewedImagePaths.has(filePath) ||
      viewedImagePaths.has(formattedPath) ||
      filePath.trim() === detail ||
      formattedPath === detail
      ? []
      : [formattedPath];
  });
  if (changedFiles.length > 0) {
    addBlock([...new Set(changedFiles)].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (workEntry.structuredPayload?.type === "notification") {
    if (workEntry.structuredPayload.outcome === "failed") return "circle-alert";
    const source = workEntry.structuredPayload.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "bot";
      case "command":
        return "terminal";
      case "monitor":
        return "eye";
      case "background_task":
        return "zap";
      case "system":
        return "t3-code";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (workEntry.itemType === "user_input_request" || workEntry.itemType === "approval_request") {
    return "message-circle";
  }
  if (workEntry.toolSurface) return workEntry.toolSurface;
  if (
    workEntry.structuredPayload?.type === "dynamic_tool" &&
    isJavaScriptReplTool(workEntry.structuredPayload.toolName)
  )
    return "code";
  const toolPresentation = resolveWorkEntryToolPresentation(workEntry);
  if (toolPresentation) return toolPresentation.icon;
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "dynamic_tool":
      return "wrench";
    case "subagent":
      return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Compact reasoning keeps formulas while flattening other Markdown into label text. */
export function remarkThoughtPreview(fallback: string) {
  return (tree: Root) => {
    const children: RootContent[] = [];
    const append = (value: string) => {
      const last = children.at(-1);
      const text = value.replace(/\s+/g, " ");
      if (last?.type === "text") last.value = (last.value + text).replace(/\s+/g, " ");
      else children.push({ type: "text", value: text });
    };
    const visit = (node: Root | RootContent) => {
      if (node.type === "html" || node.type === "definition") return;
      if (node.type === "math" || node.type === "inlineMath") {
        children.push({
          type: "inlineMath",
          value: node.value,
          position: node.position,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [{ type: "text", value: node.value }],
          },
        });
      } else if ("alt" in node) append(node.alt ?? "");
      else if ("value" in node) append(node.value);
      else if ("children" in node) {
        node.children.forEach((child, index) => {
          if (
            index &&
            ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type)
          )
            append(" ");
          visit(child);
        });
      } else if (node.type === "break") append(" ");
    };
    visit(tree);
    const first = children[0];
    const last = children.at(-1);
    if (first?.type === "text") first.value = first.value.trimStart();
    if (last?.type === "text") last.value = last.value.trimEnd();
    tree.children = children.some((child) => child.type !== "text" || child.value)
      ? children
      : [{ type: "text", value: fallback }];
  };
}

function ReasoningTraceContent({ entries }: { entries: ReadonlyArray<TimelineWorkEntry> }) {
  const ctx = use(TimelineRowCtx);
  const { isWorking, latestRunId } = use(TimelineRowActivityCtx);
  const isStreaming = (entry: TimelineWorkEntry) =>
    isWorking && entry.runId === latestRunId && entry.toolLifecycleStatus === "inProgress";
  return (
    <WorkLogDetails followLive={entries.some(isStreaming)}>
      {entries.map((entry) => (
        <ChatMarkdown
          key={entry.id}
          className="text-foreground"
          text={entry.detail ?? ""}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          isStreaming={isStreaming(entry)}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
          onUseArtifactTemplate={ctx.onUseArtifactTemplate}
          onImageExpand={ctx.onImageExpand}
          lineBreaks
        />
      ))}
    </WorkLogDetails>
  );
}

type WorkEntryRowProps = {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  displayLabel?: string | undefined;
  onToggleEntry?: ((collapsed: boolean) => void) | undefined;
};

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: WorkEntryRowProps) {
  const ctx = use(TimelineRowCtx);
  const item = props.workEntry.projectedItem?.item;
  const childThreadId =
    item?.type === "notification" ? notificationChildThreadId(item.source) : undefined;
  if (item?.type !== "notification" || childThreadId === undefined) {
    return <WorkEntryLogRow {...props} />;
  }
  return (
    <SubagentNotificationLink
      parentRef={scopeThreadRef(ctx.activeThreadEnvironmentId, item.threadId)}
      childThreadId={childThreadId}
      outcome={item.outcome}
      createdAt={props.workEntry.createdAt}
      timestampFormat={ctx.timestampFormat}
      onOpenThread={ctx.onOpenThread}
      fallback={<WorkEntryLogRow {...props} />}
    />
  );
});

function WorkEntryLogRow(props: WorkEntryRowProps) {
  const { workEntry, workspaceRoot, displayLabel } = props;
  const ctx = use(TimelineRowCtx);
  const { threadRef, onImageExpand, timestampFormat } = ctx;
  const { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation } = ctx;
  const threadTarget = useThreadReadTarget(workEntry, ctx.activeThreadEnvironmentId);
  const createdThread =
    workEntry.projectedItem?.item.type === "thread_created"
      ? workEntry.projectedItem.item
      : undefined;
  const notifiedSubagentThreadId =
    workEntry.projectedItem?.item.type === "notification"
      ? notificationChildThreadId(workEntry.projectedItem.item.source)
      : undefined;
  const groupView = use(WorkGroupViewCtx);
  const [expanded, setExpanded] = useState(
    () => groupView?.state.expandedEntries.has(workEntry.id) ?? false,
  );
  const toggleExpanded = () => {
    const next = !expanded;
    if (groupView) {
      groupView.onToggleEntry(!next);
      if (next) groupView.state.expandedEntries.add(workEntry.id);
      else groupView.state.expandedEntries.delete(workEntry.id);
    } else {
      props.onToggleEntry?.(!next);
    }
    setExpanded(next);
  };
  const failureItem = workEntry.projectedItem?.item;
  if (failureItem?.type === "error" && failureItem.status === "failed") {
    const warning = failureItem.failure.class === "usage_limit";
    const resetAt = failureItem.failure.resetAt;
    const resetTime = resetAt ? formatUpcomingTimestamp(resetAt, timestampFormat) : null;
    const label = warning
      ? `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`
      : workEntry.label;
    const retryRunId =
      failureItem.runId !== null &&
      retryableWorkspacePreparationRunIds.has(failureItem.runId) &&
      failureItem.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
        ? failureItem.runId
        : null;
    return (
      <WorkLogRow
        data-v2-item-type="error"
        data-v2-item-visibility={workEntry.projectedItem?.visibility}
        wrapLabel
        icon={
          <CircleAlertIcon
            className={cn("size-4", warning ? "text-warning" : "text-destructive")}
          />
        }
        label={
          <span
            className={cn("text-sm font-medium", warning ? "text-warning" : "text-destructive")}
          >
            {label}
          </span>
        }
        trailing={
          <TimelineRowTimestamp
            createdAt={workEntry.createdAt}
            timestampFormat={timestampFormat}
            alwaysVisible
          />
        }
      >
        {!warning ? (
          <p className="ms-7 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80">
            {failureItem.failure.message}
          </p>
        ) : null}
        {retryRunId !== null && onRetryWorkspacePreparation ? (
          <div className="ms-7 pb-1">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => onRetryWorkspacePreparation(retryRunId)}
            >
              <RotateCcwIcon aria-hidden />
              Retry
            </Button>
          </div>
        ) : null}
      </WorkLogRow>
    );
  }
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const showFailedIndicator =
    !showWarningIndicator && workEntryDisplayIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    !showWarningIndicator &&
    showFailedIndicator &&
    (workEntrySignalsSevereFailure(workEntry) || !workLogEntryIsToolLike(workEntry));
  const entryIconName =
    showWarningIndicator || showDestructiveRowStyle ? "circle-alert" : workEntryIconName(workEntry);
  const entryToolIcon =
    showWarningIndicator || showDestructiveRowStyle
      ? undefined
      : (workEntry.toolIcon ?? workEntry.toolSource?.icon);
  const isReasoning = workEntry.itemType === "reasoning";
  const questionHeading = workEntry.questionAnswer
    ? getQuestionTextPreview(workEntry.questionAnswer)
    : "";
  const previewText =
    isReasoning && expanded
      ? workEntry.toolLifecycleStatus === "inProgress"
        ? "Thinking"
        : "Thought"
      : questionHeading || (displayLabel ?? workEntryDisplayLabel(workEntry, workspaceRoot));
  const answerPreview =
    workEntry.questionAnswer && hasQuestionAnswer(workEntry.questionAnswer)
      ? getQuestionAnswerPreview(workEntry.questionAnswer)
      : null;
  const viewedImagePath = workEntryViewedImagePath(workEntry);
  const payload = workEntry.structuredPayload;
  const skill =
    payload?.type === "dynamic_tool"
      ? claudeSkillInvocation(payload.toolName, payload.input)
      : undefined;
  const plainOutput =
    toolGroupAction(workEntry) === "read"
      ? workEntryReadOutput(workEntry, workspaceRoot)
      : skill
        ? (skill.args ?? null)
        : undefined;
  const viewedImage =
    viewedImagePath && threadRef
      ? resolveViewedImageAsset(viewedImagePath, {
          threadId: threadRef.threadId,
          workspaceRoot,
        })
      : null;
  const canExpand =
    previewText.trim().length > 0 ||
    (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) ||
    Boolean(
      workEntryRawCommand(workEntry) ||
      workEntry.command?.trim() ||
      workEntry.detail?.trim() ||
      workEntry.changedFiles?.length ||
      viewedImage,
    );
  const expandedBody =
    expanded && !isReasoning
      ? plainOutput !== undefined
        ? plainOutput
        : buildToolCallExpandedBody(
            workEntry,
            workspaceRoot,
            previewText,
            viewedImage ? viewedImagePath : null,
          )
      : null;
  const plainOutputFetches =
    plainOutput !== undefined &&
    workEntry.projectedItem !== undefined &&
    turnItemNeedsDetailFetch(workEntry.projectedItem.item);
  const canExpandProjectedItem =
    plainOutput !== undefined
      ? Boolean(plainOutput || viewedImage || workEntry.questionAnswer || plainOutputFetches)
      : workEntry.projectedItem === undefined
        ? canExpand
        : isReasoning
          ? Boolean(workEntry.detail?.trim())
          : Boolean(
              viewedImage ||
              workEntry.questionAnswer ||
              turnItemHasDetail(workEntry.projectedItem.item),
            );
  const iconWrapperClass = cn(
    "flex size-4 items-center justify-center",
    showWarningIndicator
      ? "text-warning"
      : showDestructiveRowStyle
        ? "text-destructive"
        : showFailedIndicator
          ? failedToolIconClassName
          : workEntry.tone === "tool"
            ? "text-icon-muted"
            : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : workLogEntryIsToolLike(workEntry)
        ? "text-secondary-label"
        : "text-foreground/80";
  const threadLabel = isReasoning ? null : threadReadLabel(previewText, threadTarget);
  const accessiblePreview = [threadLabel?.text ?? previewText, answerPreview]
    .filter(Boolean)
    .join(": ");
  const accessibleDisplayText = showFailedIndicator
    ? `${accessiblePreview}, tool call failed`
    : accessiblePreview;
  const rowToggleProps = canExpandProjectedItem
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": accessibleDisplayText,
        "aria-expanded": expanded,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <WorkLogRow
      data-v2-item-type={workEntry.projectedItem?.item.type}
      data-v2-item-visibility={workEntry.projectedItem?.visibility}
      {...rowToggleProps}
      icon={
        <span
          className={iconWrapperClass}
          role={showFailedIndicator ? "img" : undefined}
          aria-label={showFailedIndicator ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={entryToolIcon}
            fallbackName={entryIconName}
            className="block size-4 shrink-0 stroke-2"
            muted
          />
        </span>
      }
      label={
        <div className="min-w-0 flex-1 overflow-hidden">
          <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
            <span
              className={cn(answerPreview ? "min-w-0" : "min-w-0 flex-1", "truncate", headingClass)}
            >
              {isReasoning && !expanded ? (
                <ChatMarkdown
                  inline
                  text={workEntry.detail ?? previewText}
                  cwd={ctx.markdownCwd}
                  parseRawHtml={false}
                  extraRemarkPlugins={[
                    [
                      remarkThoughtPreview,
                      workEntry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought",
                    ],
                  ]}
                />
              ) : threadLabel ? (
                <ThreadReadLabel
                  label={threadLabel}
                  environmentId={ctx.activeThreadEnvironmentId}
                  linked
                />
              ) : (
                previewText
              )}
            </span>
            {answerPreview ? (
              <span
                className={cn(
                  "min-w-0 truncate",
                  !expanded &&
                    workEntry.questionAnswer &&
                    hasQuestionAnswer(workEntry.questionAnswer)
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {answerPreview}
              </span>
            ) : null}
          </p>
        </div>
      }
      trailing={
        <>
          {createdThread ? (
            <button
              type="button"
              className="shrink-0 rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={`Open ${createdThread.title ?? "created thread"}`}
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(createdThread.targetThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open chat
            </button>
          ) : null}
          {notifiedSubagentThreadId ? (
            <InlineButton
              aria-label="Open subagent thread"
              onClick={(event) => {
                event.stopPropagation();
                ctx.onOpenThread(notifiedSubagentThreadId);
              }}
              onKeyDown={stopRowToggle}
            >
              Open subagent
            </InlineButton>
          ) : null}
          {showFailedIndicator &&
          !showDestructiveRowStyle &&
          !toolIconAcceptsTint(entryToolIcon) ? (
            <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} />
          ) : null}
          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpandProjectedItem && "invisible",
            )}
            aria-hidden
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </>
      }
    >
      {expanded && viewedImage && threadRef ? (
        <WorkLogDetails kind="media">
          <ChatMarkdownAssetImage
            environmentId={threadRef.environmentId}
            resource={viewedImage.resource}
            alt={viewedImage.alt}
            srcFragment={viewedImage.srcFragment}
            workspaceRoot={workspaceRoot}
            maxHeightRem={16}
            onImageExpand={onImageExpand}
          />
        </WorkLogDetails>
      ) : null}
      {expanded && workEntry.questionAnswer ? (
        <QuestionAnswerHistory answer={workEntry.questionAnswer} />
      ) : null}
      {expanded && isReasoning ? <ReasoningTraceContent entries={[workEntry]} /> : null}
      {expanded &&
      !isReasoning &&
      !workEntry.questionAnswer &&
      canExpandProjectedItem &&
      (expandedBody ||
        plainOutputFetches ||
        (workEntry.projectedItem && plainOutput === undefined)) ? (
        <WorkLogDetails kind="panel">
          {workEntry.projectedItem && plainOutput === undefined ? (
            <V2ItemInspector
              projectedItem={workEntry.projectedItem}
              environmentId={ctx.activeThreadEnvironmentId}
              cwd={ctx.markdownCwd}
              workspaceRoot={workspaceRoot}
              onOpenThread={ctx.onOpenThread}
              onOpenTurnDiff={ctx.onOpenTurnDiff}
              onRollbackCheckpoint={ctx.onRollbackCheckpoint}
              onImageExpand={ctx.onImageExpand}
            />
          ) : (
            <>
              {expandedBody ? (
                <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre>
              ) : null}
              {plainOutputFetches && workEntry.projectedItem ? (
                <FetchedToolOutput
                  projectedItem={workEntry.projectedItem}
                  environmentId={ctx.activeThreadEnvironmentId}
                  onImageExpand={onImageExpand}
                />
              ) : null}
            </>
          )}
        </WorkLogDetails>
      ) : null}
    </WorkLogRow>
  );
}

function QuestionAnswerHistory({
  answer,
}: {
  answer: import("@t3tools/contracts").UserInputAttachmentAnswerPayload;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  const attachments = Object.values(answer.attachmentsByQuestionId).flat();
  const resources = attachments.map((attachment) => ({
    _tag: "attachment" as const,
    attachmentId: attachment.id,
  }));
  const urls = useAssetUrls(activeThreadEnvironmentId, resources);
  return (
    <div className="ms-7 mt-2 space-y-2" onClick={stopRowToggle}>
      {[
        ...new Set([
          ...Object.keys(answer.questionTextById ?? {}),
          ...Object.keys(answer.answers),
          ...Object.keys(answer.attachmentsByQuestionId),
        ]),
      ].map((questionId) => (
        <div key={questionId} className="space-y-1">
          {answer.questionTextById?.[questionId] ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {answer.questionTextById[questionId]}
            </p>
          ) : null}
          {getQuestionAnswerText(answer.answers[questionId]) ? (
            <p className="ms-3 whitespace-pre-wrap text-sm text-muted-foreground">
              {getQuestionAnswerText(answer.answers[questionId])}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(answer.attachmentsByQuestionId[questionId] ?? []).map((attachment) => {
              const url = urls[attachments.indexOf(attachment)];
              return (
                <a
                  key={attachment.id}
                  href={url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  {attachment.type === "image" && url ? (
                    <img
                      src={url}
                      alt={attachment.name}
                      className="h-20 max-w-32 rounded object-contain"
                    />
                  ) : (
                    attachment.name
                  )}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
>>>>>>> effdfbbb29 (feat: reference other conversations and relay work between them)
