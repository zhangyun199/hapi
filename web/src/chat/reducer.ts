import type { AgentState } from '@/types/api'
import type { ChatBlock, NormalizedMessage, UsageData } from '@/chat/types'
import { traceMessages, type TracedMessage } from '@/chat/tracer'
import { dedupeAgentEvents, foldApiErrorEvents } from '@/chat/reducerEvents'
import { collectTitleChanges, collectToolIdsFromMessages, ensureToolBlock, getPermissions } from '@/chat/reducerTools'
import { reduceTimeline } from '@/chat/reducerTimeline'
import { isObject } from '@hapi/protocol'

// Calculate context size from usage data
function calculateContextSize(usage: UsageData): number {
    return (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens
}

function readTokenNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }
    if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function pickTokenNumber(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
        const value = record[key]
        const parsed = readTokenNumber(value)
        if (parsed !== null) {
            return parsed
        }
    }
    return null
}

function pickTokenUsageRecord(info: Record<string, unknown>): Record<string, unknown> {
    const candidates: Array<Record<string, unknown> | null> = [
        // Prefer "last" usage for context remaining (represents the most recent prompt/context size).
        isObject(info.last_token_usage) ? info.last_token_usage as Record<string, unknown> : null,
        isObject(info.lastTokenUsage) ? info.lastTokenUsage as Record<string, unknown> : null,
        isObject(info.total_token_usage) ? info.total_token_usage as Record<string, unknown> : null,
        isObject(info.totalTokenUsage) ? info.totalTokenUsage as Record<string, unknown> : null,
        isObject(info.token_usage) ? info.token_usage as Record<string, unknown> : null,
        isObject(info.tokenUsage) ? info.tokenUsage as Record<string, unknown> : null,
        isObject(info.usage) ? info.usage as Record<string, unknown> : null,
    ]

    for (const candidate of candidates) {
        if (candidate) return candidate
    }

    return info
}

function extractTokenCountUsage(info: unknown): LatestUsage | null {
    if (!isObject(info)) return null
    const rootInfo = info as Record<string, unknown>
    const usageInfo = pickTokenUsageRecord(rootInfo)

    const contextLimitKeys = [
        'model_context_window',
        'modelContextWindow',
        'context_window',
        'contextWindow',
        'context_limit',
        'contextLimit',
    ]

    const contextLimitTokens = (
        pickTokenNumber(rootInfo, contextLimitKeys)
        ?? pickTokenNumber(usageInfo, contextLimitKeys)
    ) ?? undefined

    const inputTokens = pickTokenNumber(usageInfo, [
        'input_tokens',
        'inputTokens',
        'prompt_tokens',
        'promptTokens'
    ])
    const outputTokens = pickTokenNumber(usageInfo, [
        'output_tokens',
        'outputTokens',
        'completion_tokens',
        'completionTokens'
    ]) ?? 0

    const cacheCreation = pickTokenNumber(usageInfo, [
        'cache_creation_input_tokens',
        'cacheCreationInputTokens'
    ]) ?? 0
    const cacheRead = pickTokenNumber(usageInfo, [
        'cache_read_input_tokens',
        'cacheReadInputTokens',
        // App-server reports cached input tokens as an annotation, not additive.
        'cached_input_tokens',
        'cachedInputTokens'
    ]) ?? 0

    // Codex CLI defines "tokens in context window" as TokenUsage.total_tokens and uses that for the
    // context remaining gauge (with a baseline applied later when rendering the percent). Prefer that when
    // present so Web UI matches Codex TUI.
    const contextSizeCandidate = pickTokenNumber(usageInfo, [
        'total_tokens',
        'totalTokens',
        'context_size',
        'contextSize',
        'context_tokens',
        'contextTokens',
        'prompt_tokens',
        'promptTokens',
        'input_tokens',
        'inputTokens'
    ])

    const contextSize = contextSizeCandidate ?? inputTokens
    if (contextSize === null) return null

    return {
        inputTokens: inputTokens ?? contextSize,
        outputTokens,
        cacheCreation,
        cacheRead,
        contextSize: Math.max(0, Math.round(contextSize)),
        contextLimitTokens,
        timestamp: 0 // Caller sets based on message timestamp
    }
}

function isTokenCountEvent(value: unknown): value is { type: 'token_count'; info?: unknown } {
    return isObject(value) && (value as { type?: unknown }).type === 'token_count'
}

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize: number
    contextLimitTokens?: number
    timestamp: number
}

export function findLatestUsageFromMessages(normalized: NormalizedMessage[]): LatestUsage | null {
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.usage) {
            return {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
                cacheRead: msg.usage.cache_read_input_tokens ?? 0,
                contextSize: calculateContextSize(msg.usage),
                timestamp: msg.createdAt
            }
        }

        if (msg.role === 'event' && isTokenCountEvent(msg.content)) {
            const parsed = extractTokenCountUsage(msg.content.info)
            if (!parsed) {
                continue
            }
            return {
                ...parsed,
                timestamp: msg.createdAt
            }
        }
    }

    return null
}

function sortBlocksByCreatedAt(blocks: ChatBlock[]): ChatBlock[] {
    return blocks
        .map((block, index) => ({ block, index }))
        .sort((a, b) => {
            const delta = a.block.createdAt - b.block.createdAt
            return delta !== 0 ? delta : a.index - b.index
        })
        .map(({ block }) => block)
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined
): { blocks: ChatBlock[]; hasReadyEvent: boolean; latestUsage: LatestUsage | null } {
    const permissionsById = getPermissions(agentState)
    const toolIdsInMessages = collectToolIdsFromMessages(normalized)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    const traced = traceMessages(normalized)
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of traced) {
        if (msg.sidechainId) {
            const existing = groups.get(msg.sidechainId) ?? []
            existing.push(msg)
            groups.set(msg.sidechainId, existing)
        } else {
            root.push(msg)
        }
    }

    const consumedGroupIds = new Set<string>()
    const emittedTitleChangeToolUseIds = new Set<string>()
    const reducerContext = { permissionsById, groups, consumedGroupIds, titleChangesByToolUseId, emittedTitleChangeToolUseIds }
    const rootResult = reduceTimeline(root, reducerContext)
    let hasReadyEvent = rootResult.hasReadyEvent

    // Only create permission-only tool cards when there is no tool call/result in the transcript.
    for (const [id, entry] of permissionsById) {
        if (toolIdsInMessages.has(id)) continue
        if (rootResult.toolBlocksById.has(id)) continue

        const createdAt = entry.permission.createdAt ?? entry.permission.completedAt ?? Date.now()
        const block = ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
            createdAt,
            localId: null,
            name: entry.toolName,
            input: entry.input,
            description: null,
            permission: entry.permission
        })

        if (entry.permission.status === 'approved') {
            block.tool.state = 'completed'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined) {
                block.tool.result = 'Approved'
            }
        } else if (entry.permission.status === 'denied' || entry.permission.status === 'canceled') {
            block.tool.state = 'error'
            block.tool.completedAt = entry.permission.completedAt ?? createdAt
            if (block.tool.result === undefined && entry.permission.reason) {
                block.tool.result = { error: entry.permission.reason }
            }
        }
    }

    const blocks = sortBlocksByCreatedAt(rootResult.blocks)

    const latestUsage = findLatestUsageFromMessages(normalized)

    return { blocks: dedupeAgentEvents(foldApiErrorEvents(blocks)), hasReadyEvent, latestUsage }
}
