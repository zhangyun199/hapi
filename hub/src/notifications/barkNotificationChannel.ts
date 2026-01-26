import type { Session } from '../sync/syncEngine'
import type { NotificationChannel } from './notificationTypes'
import { getAgentName, getSessionName } from './sessionInfo'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

type BarkNotificationChannelOptions = {
    key: string
    baseUrl: string
    appUrl: string
    visibilityTracker: VisibilityTracker
    group?: string
    sound?: string
    icon?: string
    timeoutMs?: number
    notifyWhenControlledByUser?: boolean
    notifyWhenVisible?: boolean
}

export class BarkNotificationChannel implements NotificationChannel {
    private readonly key: string
    private readonly baseUrl: string
    private readonly appUrl: string
    private readonly visibilityTracker: VisibilityTracker
    private readonly group: string | null
    private readonly sound: string | null
    private readonly icon: string | null
    private readonly timeoutMs: number
    private readonly notifyWhenControlledByUser: boolean
    private readonly notifyWhenVisible: boolean

    constructor(options: BarkNotificationChannelOptions) {
        this.key = options.key
        this.baseUrl = options.baseUrl.replace(/\/+$/, '')
        this.appUrl = options.appUrl
        this.visibilityTracker = options.visibilityTracker
        this.group = options.group ?? null
        this.sound = options.sound ?? null
        this.icon = options.icon ?? null
        this.timeoutMs = options.timeoutMs ?? 5_000
        this.notifyWhenControlledByUser = options.notifyWhenControlledByUser ?? false
        this.notifyWhenVisible = options.notifyWhenVisible ?? false
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }
        if (!this.shouldNotify(session)) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        await this.sendBarkNotification({
            title: 'Permission Request',
            body: `${name}${toolName}`,
            url: this.buildSessionUrl(session.id),
            group: this.group ?? `hapi-${session.id}`
        })
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }
        if (!this.shouldNotify(session)) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        await this.sendBarkNotification({
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            url: this.buildSessionUrl(session.id),
            group: this.group ?? `hapi-${session.id}`
        })
    }

    private shouldNotify(session: Session): boolean {
        if (!this.notifyWhenVisible && this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            return false
        }

        if (!this.notifyWhenControlledByUser && session.agentState?.controlledByUser === true) {
            return false
        }

        return true
    }

    private buildSessionUrl(sessionId: string): string | null {
        try {
            const url = new URL(this.appUrl)
            const basePath = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname
            url.pathname = `${basePath}/sessions/${sessionId}`
            return url.toString()
        } catch {
            return null
        }
    }

    private buildBarkRequestUrl(payload: {
        title: string
        body: string
        url: string | null
        group: string | null
    }): string | null {
        let url: URL
        try {
            url = new URL(
                `${this.baseUrl}/${encodeURIComponent(this.key)}` +
                `/${encodeURIComponent(payload.title)}` +
                `/${encodeURIComponent(payload.body)}`
            )
        } catch {
            return null
        }

        if (payload.url) {
            url.searchParams.set('url', payload.url)
        }
        if (payload.group) {
            url.searchParams.set('group', payload.group)
        }
        if (this.sound) {
            url.searchParams.set('sound', this.sound)
        }
        if (this.icon) {
            url.searchParams.set('icon', this.icon)
        }

        return url.toString()
    }

    private async sendBarkNotification(payload: {
        title: string
        body: string
        url: string | null
        group: string | null
    }): Promise<void> {
        const requestUrl = this.buildBarkRequestUrl(payload)
        if (!requestUrl) {
            return
        }

        const abortController = new AbortController()
        const timeout = setTimeout(() => abortController.abort(), this.timeoutMs)

        try {
            const response = await fetch(requestUrl, {
                method: 'GET',
                signal: abortController.signal
            })

            if (!response.ok) {
                const text = await response.text().catch(() => '')
                const suffix = text ? ` - ${text}` : ''
                console.error(`[Bark] Notification failed: ${response.status} ${response.statusText}${suffix}`)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[Bark] Notification failed: ${message}`)
        } finally {
            clearTimeout(timeout)
        }
    }
}
