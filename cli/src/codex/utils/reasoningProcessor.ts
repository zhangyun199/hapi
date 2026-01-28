/**
 * Reasoning Processor - Handles streaming reasoning deltas and identifies reasoning tools
 * 
 * This processor accumulates agent_reasoning_delta events and identifies when
 * reasoning sections start with **[Title]** (with brackets) format, treating them as tool calls.
 *
 * Note: We intentionally require the bracketed form `**[Title]**` here to avoid
 * misclassifying normal markdown headings like `**Title**` (common in remote streams)
 * as tool calls, which would render as "cards" in the web UI.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

const TOOL_SECTION_PREFIX = '**[';
const TOOL_SECTION_SUFFIX = ']**';

export interface ReasoningToolCall {
    type: 'tool-call';
    name: 'CodexReasoning';
    callId: string;
    input: {
        title: string;
    };
    id: string;
}

export interface ReasoningToolResult {
    type: 'tool-call-result';
    callId: string;
    output: {
        content?: string;
        status?: 'completed' | 'canceled';
    };
    id: string;
}

export interface ReasoningMessage {
    type: 'reasoning';
    message: string;
    id: string;
}

export type ReasoningOutput = ReasoningToolCall | ReasoningToolResult | ReasoningMessage;

export class ReasoningProcessor {
    private accumulator: string = '';
    private inTitleCapture: boolean = false;
    private titleBuffer: string = '';
    private contentBuffer: string = '';
    private hasTitle: boolean = false;
    private currentCallId: string | null = null;
    private toolCallStarted: boolean = false;
    private currentTitle: string | null = null;
    private onMessage: ((message: any) => void) | null = null;

    constructor(onMessage?: (message: any) => void) {
        this.onMessage = onMessage || null;
        this.reset();
    }

    /**
     * Flush any buffered reasoning as a completed message.
     *
     * Some upstream streams emit `agent_reasoning_delta` but may omit a final
     * `agent_reasoning` completion event. In those cases we still want the UI to
     * display the reasoning collected so far.
     *
     * Returns the flushed text when a message was emitted.
     */
    flushCompleted(): string | null {
        if (!this.accumulator) {
            return null;
        }
        const flushed = this.accumulator;
        this.complete(flushed);
        return flushed;
    }

    /**
     * Set the message callback for sending messages directly
     */
    setMessageCallback(callback: (message: any) => void): void {
        this.onMessage = callback;
    }

    /**
     * Process a reasoning section break - indicates a new reasoning section is starting
     */
    handleSectionBreak(): string | null {
        let flushed: string | null = null;
        // When we're modeling reasoning as a tool call (`**[Title]**`), a section break
        // means we should finalize the current tool section and reset.
        if (this.toolCallStarted || this.inTitleCapture || this.hasTitle) {
            flushed = this.flushCompleted();
            if (!flushed) {
                this.resetState();
            }
            logger.debug('[ReasoningProcessor] Section break - reset tool section');
            return flushed;
        }

        // Otherwise treat section breaks as formatting separators inside a single
        // reasoning block (better UX than emitting separate "cards").
        if (this.accumulator.length > 0 && !this.accumulator.endsWith('\n\n')) {
            this.accumulator = this.accumulator.replace(/\n?$/, '\n\n');
            this.contentBuffer = this.accumulator;
        }
        logger.debug('[ReasoningProcessor] Section break - inserted separator');
        return null;
    }

    /**
     * Process a reasoning delta and accumulate content
     */
    processDelta(delta: string): void {
        this.accumulator += delta;

        // If we haven't started processing yet, check if this starts with **
        if (!this.inTitleCapture && !this.hasTitle && !this.contentBuffer) {
            if (this.accumulator.startsWith(TOOL_SECTION_PREFIX)) {
                // Start title capture
                this.inTitleCapture = true;
                this.titleBuffer = this.accumulator.substring(TOOL_SECTION_PREFIX.length); // Remove leading **[
                logger.debug('[ReasoningProcessor] Started title capture');
            } else if (TOOL_SECTION_PREFIX.startsWith(this.accumulator)) {
                // Prefix may be arriving in multiple deltas; wait until we can decide.
                return;
            } else if (this.accumulator.length > 0) {
                // This is untitled reasoning, just accumulate as content
                this.contentBuffer = this.accumulator;
            }
        } else if (this.inTitleCapture) {
            // We're capturing the title
            this.titleBuffer = this.accumulator.substring(TOOL_SECTION_PREFIX.length); // Keep updating from start
            
            // Check if we've found the closing ]**
            const titleEndIndex = this.titleBuffer.indexOf(TOOL_SECTION_SUFFIX);
            if (titleEndIndex !== -1) {
                // Found the end of title
                const title = this.titleBuffer.substring(0, titleEndIndex);
                const afterTitle = this.titleBuffer.substring(titleEndIndex + TOOL_SECTION_SUFFIX.length);
                
                this.hasTitle = true;
                this.inTitleCapture = false;
                this.currentTitle = title;
                this.contentBuffer = afterTitle;
                
                // Generate a call ID for this reasoning section
                this.currentCallId = randomUUID();
                
                logger.debug(`[ReasoningProcessor] Title captured: "${title}"`);
                
                // Send tool call immediately when title is detected
                this.sendToolCallStart(title);
            }
        } else if (this.hasTitle) {
            // We have a title, accumulate content after title
            const headerLength = TOOL_SECTION_PREFIX.length + this.currentTitle!.length + TOOL_SECTION_SUFFIX.length;
            this.contentBuffer = this.accumulator.length >= headerLength ? this.accumulator.substring(headerLength) : '';
        } else {
            // Untitled reasoning, just accumulate
            this.contentBuffer = this.accumulator;
        }
    }

    /**
     * Send the tool call start message
     */
    private sendToolCallStart(title: string): void {
        if (!this.currentCallId || this.toolCallStarted) {
            return;
        }

        const toolCall: ReasoningToolCall = {
            type: 'tool-call',
            name: 'CodexReasoning',
            callId: this.currentCallId,
            input: {
                title: title
            },
            id: randomUUID()
        };

        logger.debug(`[ReasoningProcessor] Sending tool call start for: "${title}"`);
        this.onMessage?.(toolCall);
        this.toolCallStarted = true;
    }

    /**
     * Complete the reasoning section with final text
     */
    complete(fullText: string): void {
        // Extract title and content if present
        let title: string | undefined;
        let content: string = fullText;
        
        if (fullText.startsWith(TOOL_SECTION_PREFIX)) {
            const titleEndIndex = fullText.indexOf(TOOL_SECTION_SUFFIX, TOOL_SECTION_PREFIX.length);
            if (titleEndIndex !== -1) {
                title = fullText.substring(TOOL_SECTION_PREFIX.length, titleEndIndex);
                content = fullText.substring(titleEndIndex + TOOL_SECTION_SUFFIX.length).trim();
            }
        }

        logger.debug(`[ReasoningProcessor] Complete reasoning - Title: "${title}", Has content: ${content.length > 0}`);
        
        if (title && !this.toolCallStarted) {
            // If we have a title but haven't sent the tool call yet, send it now
            this.currentCallId = this.currentCallId || randomUUID();
            this.sendToolCallStart(title);
        }

        if (this.toolCallStarted && this.currentCallId) {
            // Send tool call result for titled reasoning
            const toolResult: ReasoningToolResult = {
                type: 'tool-call-result',
                callId: this.currentCallId,
                output: {
                    content: content,
                    status: 'completed'
                },
                id: randomUUID()
            };
            logger.debug('[ReasoningProcessor] Sending tool call result');
            this.onMessage?.(toolResult);
        } else {
            // Send regular reasoning message for untitled reasoning
            const reasoningMessage: ReasoningMessage = {
                type: 'reasoning',
                message: content,
                id: randomUUID()
            };
            logger.debug('[ReasoningProcessor] Sending reasoning message');
            this.onMessage?.(reasoningMessage);
        }
        
        // Reset state after completion
        this.resetState();
    }

    /**
     * Abort the current reasoning section
     */
    abort(): void {
        logger.debug('[ReasoningProcessor] Abort called');
        this.finishCurrentToolCall('canceled');
        this.resetState();
    }

    /**
     * Reset the processor state
     */
    reset(): void {
        this.finishCurrentToolCall('canceled');
        this.resetState();
    }

    /**
     * Finish current tool call if one is in progress
     */
    private finishCurrentToolCall(status: 'completed' | 'canceled'): void {
        if (this.toolCallStarted && this.currentCallId) {
            // Send tool call result with canceled status
            const toolResult: ReasoningToolResult = {
                type: 'tool-call-result',
                callId: this.currentCallId,
                output: {
                    content: this.contentBuffer || '',
                    status: status
                },
                id: randomUUID()
            };
            logger.debug(`[ReasoningProcessor] Sending tool call result with status: ${status}`);
            this.onMessage?.(toolResult);
        }
    }

    /**
     * Reset internal state
     */
    private resetState(): void {
        this.accumulator = '';
        this.inTitleCapture = false;
        this.titleBuffer = '';
        this.contentBuffer = '';
        this.hasTitle = false;
        this.currentCallId = null;
        this.toolCallStarted = false;
        this.currentTitle = null;
    }

    /**
     * Get the current call ID for tool result matching
     */
    getCurrentCallId(): string | null {
        return this.currentCallId;
    }

    /**
     * Check if a tool call has been started
     */
    hasStartedToolCall(): boolean {
        return this.toolCallStarted;
    }
}
