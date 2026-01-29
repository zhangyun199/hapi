import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, ModelMode, PermissionMode, Session } from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { findLatestUsageFromMessages, reduceChatBlocks, type LatestUsage } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { SessionHeader } from '@/components/SessionHeader'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useVoiceOptional } from '@/lib/voice-context'
import { RealtimeVoiceSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'

function pickNewerUsage(a: LatestUsage | null, b: LatestUsage | null): LatestUsage | null {
    if (!a) return b
    if (!b) return a
    return a.timestamp >= b.timestamp ? a : b
}

export function SessionChat(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    pendingCount: number
    messagesVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    onSend: (text: string, attachments?: AttachmentMetadata[]) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
}) {
    const { haptic } = usePlatform()
    const navigate = useNavigate()
    const sessionInactive = !props.session.active
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const lastKnownUsageRef = useRef<LatestUsage | null>(null)
    const lastKnownUsageSessionIdRef = useRef<string | null>(null)
    const usageBootstrapRunIdRef = useRef(0)
    const usageBootstrapRunningRef = useRef<{ sessionId: string; runId: number } | null>(null)
    const [usageBootstrapRefreshToken, forceUsageBootstrapRefresh] = useState(0)
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const { abortSession, switchSession, setPermissionMode, setModelMode } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor
    )

    // Voice assistant integration
    const voice = useVoiceOptional()

    // Register session store for voice client tools
    useEffect(() => {
        registerSessionStore({
            getSession: () => props.session as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage: (_sessionId: string, message: string) => props.onSend(message),
            approvePermission: async (_sessionId: string, requestId: string) => {
                await props.api.approvePermission(props.session.id, requestId)
                props.onRefresh()
            },
            denyPermission: async (_sessionId: string, requestId: string) => {
                await props.api.denyPermission(props.session.id, requestId)
                props.onRefresh()
            }
        })
    }, [props.session, props.api, props.onSend, props.onRefresh])

    useEffect(() => {
        registerVoiceHooksStore(
            (sessionId) => (sessionId === props.session.id ? props.session : null),
            (sessionId) => (sessionId === props.session.id ? props.messages : [])
        )
    }, [props.session, props.messages])

    // Track and report new messages to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevMessagesRef = useRef<DecryptedMessage[]>([])

    useEffect(() => {
        const prevIds = new Set(prevMessagesRef.current.map(m => m.id))
        const newMessages = props.messages.filter(m => !prevIds.has(m.id))

        if (newMessages.length > 0) {
            voiceHooks.onMessages(props.session.id, newMessages)
        }

        prevMessagesRef.current = props.messages
    }, [props.messages, props.session.id])

    // Report ready event when thinking stops
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevThinkingRef = useRef(props.session.thinking)

    useEffect(() => {
        // Detect transition: thinking → not thinking
        if (prevThinkingRef.current && !props.session.thinking) {
            voiceHooks.onReady(props.session.id)
        }

        prevThinkingRef.current = props.session.thinking
    }, [props.session.thinking, props.session.id])

    // Report permission requests to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevRequestIdsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const currentIds = new Set(Object.keys(requests))

        for (const [requestId, request] of Object.entries(requests)) {
            if (!prevRequestIdsRef.current.has(requestId)) {
                voiceHooks.onPermissionRequested(
                    props.session.id,
                    requestId,
                    (request as { tool?: string }).tool ?? 'unknown',
                    (request as { arguments?: unknown }).arguments
                )
            }
        }

        prevRequestIdsRef.current = currentIds
    }, [props.session.agentState?.requests, props.session.id])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            await voice.stopVoice()
        } else {
            await voice.startVoice(props.session.id)
        }
    }, [voice, props.session.id])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
        lastKnownUsageRef.current = null
        lastKnownUsageSessionIdRef.current = props.session.id
        usageBootstrapRunningRef.current = null
    }, [props.session.id])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of props.messages) {
            seen.add(message.id)
            const cached = cache.get(message.id)
            if (cached && cached.source === message) {
                if (cached.normalized) normalized.push(cached.normalized)
                continue
            }
            const next = normalizeDecryptedMessage(message)
            cache.set(message.id, { source: message, normalized: next })
            if (next) normalized.push(next)
        }
        for (const id of cache.keys()) {
            if (!seen.has(id)) {
                cache.delete(id)
            }
        }
        return normalized
    }, [props.messages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState),
        [normalizedMessages, props.session.agentState]
    )

    // token_count telemetry can be outside the current message window (because we only keep a visible slice
    // for performance). Cache the latest known usage (by timestamp) so the status bar doesn't "disappear"
    // or regress when loading older history trims the newest messages out of the current window.
    const cachedUsageForSession = lastKnownUsageSessionIdRef.current === props.session.id
        ? lastKnownUsageRef.current
        : null
    const usageForStatus = useMemo(
        () => pickNewerUsage(reduced.latestUsage, cachedUsageForSession),
        [reduced.latestUsage, cachedUsageForSession, usageBootstrapRefreshToken]
    )

    useEffect(() => {
        const cached = cachedUsageForSession
        if (usageForStatus && usageForStatus !== cached) {
            lastKnownUsageRef.current = usageForStatus
            lastKnownUsageSessionIdRef.current = props.session.id
        }
    }, [usageForStatus, cachedUsageForSession, props.session.id])

    // Bootstrap Codex usage without forcing the user to scroll into older history.
    // We keep token_count out of the transcript, and message windows are trimmed for performance, so the
    // latest token_count event may not be in the currently loaded slice.
    useEffect(() => {
        if (agentFlavor !== 'codex') return
        if (props.isLoadingMessages || props.isLoadingMoreMessages) return
        if (!props.hasMoreMessages) return
        if (props.messages.length === 0) return
        const cachedForSession = lastKnownUsageSessionIdRef.current === props.session.id
            ? lastKnownUsageRef.current
            : null
        if (reduced.latestUsage || cachedForSession) return
        if (usageBootstrapRunningRef.current) return

        const bootstrapSessionId = props.session.id
        const runId = usageBootstrapRunIdRef.current + 1
        usageBootstrapRunIdRef.current = runId
        usageBootstrapRunningRef.current = { sessionId: bootstrapSessionId, runId }
        let cancelled = false

        void (async () => {
            try {
                // Avoid re-fetching the latest page (the message window already loaded it). Start from
                // the oldest currently loaded sequence so we page backwards into older history only.
                let beforeSeq: number | null = null
                for (const msg of props.messages) {
                    if (typeof msg.seq !== 'number') continue
                    beforeSeq = beforeSeq === null ? msg.seq : Math.min(beforeSeq, msg.seq)
                }
                const MAX_PAGES = 8
                const PAGE_LIMIT = 200

                for (let i = 0; i < MAX_PAGES && !cancelled; i++) {
                    const response = await props.api.getMessages(bootstrapSessionId, { limit: PAGE_LIMIT, beforeSeq })
                    if (cancelled) return
                    const normalized = response.messages
                        .map((msg) => normalizeDecryptedMessage(msg))
                        .filter((msg): msg is NormalizedMessage => msg !== null)

                    const found = findLatestUsageFromMessages(normalized)
                    if (found) {
                        if (cancelled) return
                        const cached = lastKnownUsageSessionIdRef.current === bootstrapSessionId
                            ? lastKnownUsageRef.current
                            : null
                        if (!cached || found.timestamp > cached.timestamp) {
                            lastKnownUsageRef.current = found
                            lastKnownUsageSessionIdRef.current = bootstrapSessionId
                        }
                        if (cancelled) return
                        forceUsageBootstrapRefresh((v) => v + 1)
                        return
                    }

                    if (!response.page.hasMore || response.page.nextBeforeSeq === null) {
                        return
                    }
                    beforeSeq = response.page.nextBeforeSeq
                }
            } catch (error) {
                // Best-effort: context remaining is a nice-to-have. Don't spam console in production.
                if (import.meta.env.DEV) {
                    console.debug('[SessionChat] Failed to bootstrap Codex token_count usage', error)
                }
            } finally {
                const current = usageBootstrapRunningRef.current
                if (current && current.runId === runId) {
                    usageBootstrapRunningRef.current = null
                }
            }
        })()

        return () => {
            cancelled = true
            const current = usageBootstrapRunningRef.current
            if (current && current.runId === runId) {
                usageBootstrapRunningRef.current = null
            }
        }
    }, [
        agentFlavor,
        props.api,
        props.session.id,
        props.isLoadingMessages,
        props.isLoadingMoreMessages,
        props.hasMoreMessages,
        props.messages.length,
        props.messagesVersion,
        reduced.latestUsage,
    ])
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelModeChange = useCallback(async (mode: ModelMode) => {
        try {
            await setModelMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model mode:', e)
        }
    }, [setModelMode, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleViewFiles = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleSend = useCallback((text: string, attachments?: AttachmentMetadata[]) => {
        props.onSend(text, attachments)
        setForceScrollToken((token) => token + 1)
    }, [props.onSend])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: reconciled.blocks,
        isSending: props.isSending,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true
    })

    return (
        <div className="flex h-full flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                onViewFiles={props.session.metadata?.path ? handleViewFiles : undefined}
                api={props.api}
                onSessionDeleted={props.onBack}
            />

            {sessionInactive ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Sending will resume it automatically.
                    </div>
                </div>
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        key={props.session.id}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onFlushPending={props.onFlushPending}
                        onAtBottomChange={props.onAtBottomChange}
                        isLoadingMessages={props.isLoadingMessages}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={props.messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                    />

                    <HappyComposer
                        disabled={props.isSending}
                        permissionMode={props.session.permissionMode}
                        modelMode={props.session.modelMode}
                        agentFlavor={agentFlavor}
                        active={props.session.active}
                        allowSendWhenInactive
                        thinking={props.session.thinking}
                        agentState={props.session.agentState}
                        contextSize={usageForStatus?.contextSize}
                        contextLimitTokens={usageForStatus?.contextLimitTokens}
                        controlledByUser={props.session.agentState?.controlledByUser === true}
                        onPermissionModeChange={handlePermissionModeChange}
                        onModelModeChange={handleModelModeChange}
                        onSwitchToRemote={handleSwitchToRemote}
                        onTerminal={props.session.active ? handleViewTerminal : undefined}
                        autocompleteSuggestions={props.autocompleteSuggestions}
                        voiceStatus={voice?.status}
                        voiceMicMuted={voice?.micMuted}
                        onVoiceToggle={voice ? handleVoiceToggle : undefined}
                        onVoiceMicToggle={voice ? handleVoiceMicToggle : undefined}
                    />
                </div>
            </AssistantRuntimeProvider>

            {/* Voice session component - renders nothing but initializes ElevenLabs */}
            {voice && (
                <RealtimeVoiceSession
                    api={props.api}
                    micMuted={voice.micMuted}
                    onStatusChange={voice.setStatus}
                />
            )}
        </div>
    )
}
