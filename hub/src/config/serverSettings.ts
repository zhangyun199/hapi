/**
 * Hub Settings Management
 *
 * Handles loading and persistence of hub configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a value is loaded from environment variable and not present in settings.json,
 * it will be saved to settings.json for future use
 */

import { getSettingsFile, readSettings, writeSettings } from './settings'

export interface ServerSettings {
    telegramBotToken: string | null
    telegramNotification: boolean
    barkNotification: boolean
    barkBaseUrl: string
    barkGroup: string | null
    barkSound: string | null
    barkIcon: string | null
    barkTimeoutMs: number
    barkNotifyWhenControlledByUser: boolean
    barkNotifyWhenVisible: boolean
    listenHost: string
    listenPort: number
    publicUrl: string
    corsOrigins: string[]
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        telegramBotToken: 'env' | 'file' | 'default'
        telegramNotification: 'env' | 'file' | 'default'
        barkNotification: 'env' | 'file' | 'default'
        barkBaseUrl: 'env' | 'file' | 'default'
        barkGroup: 'env' | 'file' | 'default'
        barkSound: 'env' | 'file' | 'default'
        barkIcon: 'env' | 'file' | 'default'
        barkTimeoutMs: 'env' | 'file' | 'default'
        barkNotifyWhenControlledByUser: 'env' | 'file' | 'default'
        barkNotifyWhenVisible: 'env' | 'file' | 'default'
        listenHost: 'env' | 'file' | 'default'
        listenPort: 'env' | 'file' | 'default'
        publicUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
    }
    savedToFile: boolean
}

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }

    const trimmed = value.trim()
    return trimmed ? trimmed : null
}

function parsePositiveInteger(value: unknown): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) {
            return null
        }
        return Math.floor(value)
    }

    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return null
        }
        return parsed
    }

    return null
}

/**
 * Parse and normalize CORS origins
 */
function parseCorsOrigins(str: string): string[] {
    const entries = str
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)

    if (entries.includes('*')) {
        return ['*']
    }

    const normalized: string[] = []
    for (const entry of entries) {
        try {
            normalized.push(new URL(entry).origin)
        } catch {
            // Keep raw value if it's already an origin-like string
            normalized.push(entry)
        }
    }
    return normalized
}

/**
 * Derive CORS origins from public URL
 */
function deriveCorsOrigins(publicUrl: string): string[] {
    try {
        return [new URL(publicUrl).origin]
    } catch {
        return []
    }
}

/**
 * Load hub settings with priority: env > file > default
 * Saves new env values to file when not already present
 */
export async function loadServerSettings(dataDir: string): Promise<ServerSettingsResult> {
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettings(settingsFile)

    // If settings file exists but couldn't be parsed, fail fast
    if (settings === null) {
        throw new Error(
            `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
        )
    }

    let needsSave = false
    const sources: ServerSettingsResult['sources'] = {
        telegramBotToken: 'default',
        telegramNotification: 'default',
        barkNotification: 'default',
        barkBaseUrl: 'default',
        barkGroup: 'default',
        barkSound: 'default',
        barkIcon: 'default',
        barkTimeoutMs: 'default',
        barkNotifyWhenControlledByUser: 'default',
        barkNotifyWhenVisible: 'default',
        listenHost: 'default',
        listenPort: 'default',
        publicUrl: 'default',
        corsOrigins: 'default',
    }
    // telegramBotToken: env > file > null
    let telegramBotToken: string | null = null
    if (process.env.TELEGRAM_BOT_TOKEN) {
        telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
        sources.telegramBotToken = 'env'
        if (settings.telegramBotToken === undefined) {
            settings.telegramBotToken = telegramBotToken
            needsSave = true
        }
    } else if (settings.telegramBotToken !== undefined) {
        telegramBotToken = settings.telegramBotToken
        sources.telegramBotToken = 'file'
    }

    // telegramNotification: env > file > true (default enabled for backward compatibility)
    let telegramNotification = true
    if (process.env.TELEGRAM_NOTIFICATION !== undefined) {
        telegramNotification = process.env.TELEGRAM_NOTIFICATION === 'true'
        sources.telegramNotification = 'env'
        if (settings.telegramNotification === undefined) {
            settings.telegramNotification = telegramNotification
            needsSave = true
        }
    } else if (settings.telegramNotification !== undefined) {
        telegramNotification = settings.telegramNotification
        sources.telegramNotification = 'file'
    }

    // barkNotification: env > file > true (default enabled)
    let barkNotification = true
    if (process.env.BARK_NOTIFICATION !== undefined) {
        barkNotification = process.env.BARK_NOTIFICATION === 'true'
        sources.barkNotification = 'env'
        if (settings.barkNotification === undefined) {
            settings.barkNotification = barkNotification
            needsSave = true
        }
    } else if (settings.barkNotification !== undefined) {
        barkNotification = settings.barkNotification
        sources.barkNotification = 'file'
    }

    // barkBaseUrl: env > file > default
    let barkBaseUrl = 'https://api.day.app'
    if (process.env.BARK_BASE_URL) {
        const normalized = normalizeOptionalString(process.env.BARK_BASE_URL)
        if (normalized) {
            barkBaseUrl = normalized
            sources.barkBaseUrl = 'env'
            if (settings.barkBaseUrl === undefined) {
                settings.barkBaseUrl = barkBaseUrl
                needsSave = true
            }
        }
    } else if (settings.barkBaseUrl !== undefined) {
        const normalized = normalizeOptionalString(settings.barkBaseUrl)
        if (normalized) {
            barkBaseUrl = normalized
            sources.barkBaseUrl = 'file'
        }
    }

    // barkGroup: env > file > null
    let barkGroup: string | null = null
    if (process.env.BARK_GROUP) {
        const normalized = normalizeOptionalString(process.env.BARK_GROUP)
        if (normalized) {
            barkGroup = normalized
            sources.barkGroup = 'env'
            if (settings.barkGroup === undefined) {
                settings.barkGroup = barkGroup
                needsSave = true
            }
        }
    } else if (settings.barkGroup !== undefined) {
        barkGroup = normalizeOptionalString(settings.barkGroup)
        sources.barkGroup = 'file'
    }

    // barkSound: env > file > null
    let barkSound: string | null = null
    if (process.env.BARK_SOUND) {
        const normalized = normalizeOptionalString(process.env.BARK_SOUND)
        if (normalized) {
            barkSound = normalized
            sources.barkSound = 'env'
            if (settings.barkSound === undefined) {
                settings.barkSound = barkSound
                needsSave = true
            }
        }
    } else if (settings.barkSound !== undefined) {
        barkSound = normalizeOptionalString(settings.barkSound)
        sources.barkSound = 'file'
    }

    // barkIcon: env > file > null
    let barkIcon: string | null = null
    if (process.env.BARK_ICON) {
        const normalized = normalizeOptionalString(process.env.BARK_ICON)
        if (normalized) {
            barkIcon = normalized
            sources.barkIcon = 'env'
            if (settings.barkIcon === undefined) {
                settings.barkIcon = barkIcon
                needsSave = true
            }
        }
    } else if (settings.barkIcon !== undefined) {
        barkIcon = normalizeOptionalString(settings.barkIcon)
        sources.barkIcon = 'file'
    }

    // barkTimeoutMs: env > file > 5000
    let barkTimeoutMs = 5_000
    if (process.env.BARK_TIMEOUT_MS) {
        const parsed = parsePositiveInteger(process.env.BARK_TIMEOUT_MS)
        if (parsed) {
            barkTimeoutMs = parsed
            sources.barkTimeoutMs = 'env'
            if (settings.barkTimeoutMs === undefined) {
                settings.barkTimeoutMs = barkTimeoutMs
                needsSave = true
            }
        }
    } else if (settings.barkTimeoutMs !== undefined) {
        const parsed = parsePositiveInteger(settings.barkTimeoutMs)
        if (parsed) {
            barkTimeoutMs = parsed
            sources.barkTimeoutMs = 'file'
        }
    }

    // barkNotifyWhenControlledByUser: env > file > false
    let barkNotifyWhenControlledByUser = false
    if (process.env.BARK_NOTIFY_WHEN_CONTROLLED_BY_USER !== undefined) {
        barkNotifyWhenControlledByUser = process.env.BARK_NOTIFY_WHEN_CONTROLLED_BY_USER === 'true'
        sources.barkNotifyWhenControlledByUser = 'env'
        if (settings.barkNotifyWhenControlledByUser === undefined) {
            settings.barkNotifyWhenControlledByUser = barkNotifyWhenControlledByUser
            needsSave = true
        }
    } else if (settings.barkNotifyWhenControlledByUser !== undefined) {
        barkNotifyWhenControlledByUser = settings.barkNotifyWhenControlledByUser
        sources.barkNotifyWhenControlledByUser = 'file'
    }

    // barkNotifyWhenVisible: env > file > false
    let barkNotifyWhenVisible = false
    if (process.env.BARK_NOTIFY_WHEN_VISIBLE !== undefined) {
        barkNotifyWhenVisible = process.env.BARK_NOTIFY_WHEN_VISIBLE === 'true'
        sources.barkNotifyWhenVisible = 'env'
        if (settings.barkNotifyWhenVisible === undefined) {
            settings.barkNotifyWhenVisible = barkNotifyWhenVisible
            needsSave = true
        }
    } else if (settings.barkNotifyWhenVisible !== undefined) {
        barkNotifyWhenVisible = settings.barkNotifyWhenVisible
        sources.barkNotifyWhenVisible = 'file'
    }

    // listenHost: env > file (new or old name) > default
    let listenHost = '127.0.0.1'
    if (process.env.HAPI_LISTEN_HOST) {
        listenHost = process.env.HAPI_LISTEN_HOST
        sources.listenHost = 'env'
        if (settings.listenHost === undefined) {
            settings.listenHost = listenHost
            needsSave = true
        }
    } else if (settings.listenHost !== undefined) {
        listenHost = settings.listenHost
        sources.listenHost = 'file'
    } else if (settings.webappHost !== undefined) {
        // Migrate from old field name
        listenHost = settings.webappHost
        sources.listenHost = 'file'
        settings.listenHost = listenHost
        delete settings.webappHost
        needsSave = true
    }

    // listenPort: env > file (new or old name) > default
    let listenPort = 3006
    if (process.env.HAPI_LISTEN_PORT) {
        const parsed = parseInt(process.env.HAPI_LISTEN_PORT, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('HAPI_LISTEN_PORT must be a valid port number')
        }
        listenPort = parsed
        sources.listenPort = 'env'
        if (settings.listenPort === undefined) {
            settings.listenPort = listenPort
            needsSave = true
        }
    } else if (settings.listenPort !== undefined) {
        listenPort = settings.listenPort
        sources.listenPort = 'file'
    } else if (settings.webappPort !== undefined) {
        // Migrate from old field name
        listenPort = settings.webappPort
        sources.listenPort = 'file'
        settings.listenPort = listenPort
        delete settings.webappPort
        needsSave = true
    }

    // publicUrl: env > file (new or old name) > default
    let publicUrl = `http://localhost:${listenPort}`
    if (process.env.HAPI_PUBLIC_URL) {
        publicUrl = process.env.HAPI_PUBLIC_URL
        sources.publicUrl = 'env'
        if (settings.publicUrl === undefined) {
            settings.publicUrl = publicUrl
            needsSave = true
        }
    } else if (settings.publicUrl !== undefined) {
        publicUrl = settings.publicUrl
        sources.publicUrl = 'file'
    } else if (settings.webappUrl !== undefined) {
        // Migrate from old field name
        publicUrl = settings.webappUrl
        sources.publicUrl = 'file'
        settings.publicUrl = publicUrl
        delete settings.webappUrl
        needsSave = true
    }

    // corsOrigins: env > file > derived from publicUrl
    let corsOrigins: string[]
    if (process.env.CORS_ORIGINS) {
        corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS)
        sources.corsOrigins = 'env'
        if (settings.corsOrigins === undefined) {
            settings.corsOrigins = corsOrigins
            needsSave = true
        }
    } else if (settings.corsOrigins !== undefined) {
        corsOrigins = settings.corsOrigins
        sources.corsOrigins = 'file'
    } else {
        corsOrigins = deriveCorsOrigins(publicUrl)
    }

    // Save settings if any new values were added
    if (needsSave) {
        await writeSettings(settingsFile, settings)
    }

    return {
        settings: {
            telegramBotToken,
            telegramNotification,
            barkNotification,
            barkBaseUrl,
            barkGroup,
            barkSound,
            barkIcon,
            barkTimeoutMs,
            barkNotifyWhenControlledByUser,
            barkNotifyWhenVisible,
            listenHost,
            listenPort,
            publicUrl,
            corsOrigins,
        },
        sources,
        savedToFile: needsSave,
    }
}
