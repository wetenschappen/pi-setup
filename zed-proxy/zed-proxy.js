import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ZED_ENDPOINT = "https://cloud.zed.dev/completions";
const ZED_VERSION = "0.228.0+stable.203.8421009ef8a022df1196d54bb42fd94366ec0988";

// Persistent HTTPS keep-alive agent
const zedAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 2,
});

// In-memory token cache
const homeDir = process.env.HOME || '/home/albertshalaj';
const authJsonPath = path.join(homeDir, '.zed-proxy/auth.json');
let _cachedToken = null;

function loadToken() {
    if (!fs.existsSync(authJsonPath)) {
        throw new Error(`Auth file not found at ${authJsonPath}. Please run sudo zed-token first.`);
    }
    const data = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
    const zedAi = data['zed-ai'];
    if (!zedAi || (!zedAi.key && !zedAi.token)) {
        throw new Error("Zed token missing in auth.json. Please run sudo zed-token first.");
    }
    _cachedToken = (zedAi.token || zedAi.key).trim().replace(/\s+/g, '');
    
    // Warn if token is close to expiry
    if (zedAi.expires) {
        const timeRemainingSec = Math.floor((zedAi.expires - Date.now()) / 1000);
        if (timeRemainingSec <= 0) {
            console.warn('\x1b[33mWarning: Intercepted token in auth.json has EXPIRED.\x1b[0m');
        } else if (timeRemainingSec < 900) { // 15 mins
            console.warn(`\x1b[33mWarning: Intercepted token in auth.json will expire in ${Math.floor(timeRemainingSec / 60)} minutes.\x1b[0m`);
        }
    }
    console.log('Token loaded/refreshed from auth.json.');
}

loadToken();

if (fs.existsSync(authJsonPath)) {
    fs.watch(authJsonPath, () => {
        try { loadToken(); } catch (e) { console.warn('Token reload failed:', e.message); }
    });
}

function getZedToken() {
    if (!_cachedToken) loadToken();
    return _cachedToken;
}

const platform = process.platform === 'win32' ? 'windows'
               : process.platform === 'darwin' ? 'macos'
               : 'linux';

// Hash first message content to derive a stable session thread ID per conversation.
// This optimizes backend prompt caching and prevents multiple concurrent Pi instances from clashing on one ID.
function getSessionThreadId(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return crypto.randomUUID();
    }
    const firstMsg = messages[0];
    let contentStr = "";
    if (typeof firstMsg.content === "string") {
        contentStr = firstMsg.content;
    } else if (Array.isArray(firstMsg.content)) {
        contentStr = JSON.stringify(firstMsg.content);
    }
    const hash = crypto.createHash('sha256').update(contentStr).digest('hex');
    // Format hash into UUID-v4 style: 8-4-4-4-12
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// ── Cost optimisation tunables ──────────────────────────────────────────────
// Thinking blocks from older turns have no value but cost a lot to re-read.
// Keep the thinking content only in the most recent N assistant turns.
const KEEP_THINKING_IN_LAST_N_TURNS = 2;
// Tool results larger than this character limit get truncated.
// ~4 chars ≈ 1 token; 6000 chars ≈ 1500 tokens — enough for most outputs.
const MAX_TOOL_RESULT_CHARS = 6000;
// ─────────────────────────────────────────────────────────────────────────────

function buildZedPayload(originalBody) {
    const { messages = [], system, tools, max_tokens, temperature } = originalBody;

    const sessionThreadId = getSessionThreadId(messages);

    let detectedTtl = undefined;
    if (Array.isArray(tools)) {
        for (const t of tools) {
            if (t.cache_control?.ttl) {
                detectedTtl = t.cache_control.ttl;
            }
        }
    }
    if (!detectedTtl && Array.isArray(system)) {
        for (const b of system) {
            if (b.cache_control?.ttl) {
                detectedTtl = b.cache_control.ttl;
            }
        }
    }
    if (!detectedTtl && Array.isArray(messages)) {
        for (const m of messages) {
            if (Array.isArray(m.content)) {
                for (const b of m.content) {
                    if (b.cache_control?.ttl) {
                        detectedTtl = b.cache_control.ttl;
                    }
                }
            }
        }
    }
    const injectedCacheControl = detectedTtl
        ? { type: 'ephemeral', ttl: detectedTtl }
        : { type: 'ephemeral' };

    let cleanTools;
    if (Array.isArray(tools)) {
        cleanTools = tools.map(t => {
            const inputSchema = t.input_schema || t.parameters;
            return {
                name: t.name || t.id,
                description: t.description,
                input_schema: inputSchema,
                ...(t.cache_control && { cache_control: t.cache_control }),
            };
        }).filter(t => t.name);
    }

    // ── Pass 1: identify which assistant turn indices are "recent" ────────────
    // We need the raw index in the filtered array, so build a list first.
    const filteredMessages = messages.filter(m => m.role === "user" || m.role === "assistant");
    const assistantIndices = filteredMessages
        .map((m, i) => m.role === 'assistant' ? i : -1)
        .filter(i => i !== -1);
    const recentAssistantIndices = new Set(
        assistantIndices.slice(-KEEP_THINKING_IN_LAST_N_TURNS)
    );

    const cleanMessages = filteredMessages.map((m, msgIndex) => {
            let content = m.content;
            if (typeof content === "string") {
                content = [{ type: "text", text: content }];
            } else if (Array.isArray(content)) {
                content = content.map(block => {
                    if ((block.type === "tool_use" || block.type === "tool") && !block.name) {
                        return {
                            type: "tool_use",
                            id: block.id || block.callID || crypto.randomUUID(),
                            name: block.tool || block.name,
                            input: block.input || block.args || {}
                        };
                    }
                    if (block.type === "tool_result") {
                        // Normalise tool_use_id if missing
                        const base = (!block.tool_use_id) ? {
                            type: "tool_result",
                            tool_use_id: block.id || block.callID || block.tool_use_id,
                            content: [{
                                type: "text",
                                text: typeof block.output === "string"
                                    ? block.output
                                    : JSON.stringify(block.output || block.content || "")
                            }]
                        } : block;

                        // ── Optimization 2: truncate large tool results ───────
                        if (Array.isArray(base.content)) {
                            base.content = base.content.map(c => {
                                if (c.type === "text" && c.text && c.text.length > MAX_TOOL_RESULT_CHARS) {
                                    const truncated = c.text.slice(0, MAX_TOOL_RESULT_CHARS);
                                    const dropped = c.text.length - MAX_TOOL_RESULT_CHARS;
                                    return {
                                        ...c,
                                        text: truncated + `\n\n[… ${dropped} chars truncated by proxy to reduce token cost]`
                                    };
                                }
                                return c;
                            });
                        }
                        return base;
                    }
                    return block;
                });

                // ── Optimization 1: strip old thinking blocks ─────────────────
                if (m.role === 'assistant' && !recentAssistantIndices.has(msgIndex)) {
                    content = content.filter(
                        b => b.type !== 'thinking' && b.type !== 'redacted_thinking'
                    );
                }
            }
            return { role: m.role, content };
        });

    if (cleanMessages.length >= 6) {
        const lastAssistant = [...cleanMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant && Array.isArray(lastAssistant.content) && lastAssistant.content.length > 0) {
            const lastNonThinkingBlock = [...lastAssistant.content].reverse()
                .find(b => b.type !== 'thinking' && b.type !== 'redacted_thinking');
            if (lastNonThinkingBlock && !lastNonThinkingBlock.cache_control) {
                lastNonThinkingBlock.cache_control = injectedCacheControl;
            }
        }
    }

    const systemParam = system || "";
    const systemText = Array.isArray(system)
        ? system.map(b => b.text || "").join("\n")
        : (system || "");

    const { thinking } = originalBody;
    const thinkingActive = thinking && thinking.type !== "disabled";

    return {
        thread_id: sessionThreadId,
        prompt_id: crypto.randomUUID(),
        intent: "user_prompt",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        provider_request: {
            model: "claude-sonnet-4-6",
            max_tokens: max_tokens || 64000,
            messages: cleanMessages,
            ...(cleanTools && cleanTools.length > 0 && { tools: cleanTools }),
            system: systemParam,
            ...(thinking && { thinking }),
            ...(!thinkingActive && { temperature: temperature || 1.0 }),
        },
        system: systemText,
        ...(!thinkingActive && { temperature: temperature || 1.0 }),
    };
}

function makeZedRequest(zedPayload, token) {
    return new Promise((resolve, reject) => {
        const headers = {
            "accept": "*/*",
            "authorization": `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": `Zed/${ZED_VERSION} (${platform}; x86_64)`,
            "x-zed-client-supports-status-messages": "true",
            "x-zed-client-supports-stream-ended-request-completion-status": "true",
            "x-zed-version": ZED_VERSION
        };

        const zedReq = https.request(ZED_ENDPOINT, {
            method: 'POST',
            headers: headers,
            agent: zedAgent,
        }, resolve);

        zedReq.on('error', reject);
        zedReq.write(JSON.stringify(zedPayload));
        zedReq.end();
    });
}

async function requestWithRetry(zedPayload, token, maxRetries = 3) {
    let lastStatus = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const zedRes = await makeZedRequest(zedPayload, token);
        lastStatus = zedRes.statusCode;
        if (zedRes.statusCode === 429 || zedRes.statusCode === 503) {
            const wait = (attempt + 1) * 1500;
            console.warn(`Zed returned ${zedRes.statusCode}, retrying in ${wait}ms...`);
            zedRes.resume();
            await new Promise(r => setTimeout(r, wait));
            continue;
        }
        return zedRes;
    }
    throw new Error(`Zed request failed with status ${lastStatus} after ${maxRetries} retries`);
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const originalBody = JSON.parse(body);
                const zedPayload = buildZedPayload(originalBody);
                const token = getZedToken();

                const zedRes = await requestWithRetry(zedPayload, token);

                if (zedRes.statusCode !== 200) {
                    // Read Zed's error body and translate to Anthropic format
                    let errorBody = '';
                    for await (const chunk of zedRes) errorBody += chunk.toString('utf8');
                    
                    let zedError;
                    try { zedError = JSON.parse(errorBody); } catch { zedError = { message: errorBody }; }
                    
                    // Map Zed error codes to Anthropic error types
                    const errorType = zedError.code === 'token_spend_limit_reached'
                        ? 'permission_error'
                        : zedError.code?.includes('rate') ? 'rate_limit_error'
                        : 'api_error';
                    
                    const anthropicError = {
                        type: 'error',
                        error: {
                            type: errorType,
                            message: zedError.message || `Zed API error: ${zedRes.statusCode}`,
                            code: zedError.code
                        }
                    };
                    
                    res.writeHead(zedRes.statusCode, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(anthropicError));
                    return;
                }

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                let buffer = "";
                zedRes.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        try {
                            const json = JSON.parse(trimmed);
                            if (json.event) {
                                res.write(`event: ${json.event.type}\n`);
                                res.write(`data: ${JSON.stringify(json.event)}\n\n`);
                            }
                        } catch (e) {}
                    }
                });

                zedRes.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            const json = JSON.parse(buffer.trim());
                            if (json.event) {
                                res.write(`event: ${json.event.type}\n`);
                                res.write(`data: ${JSON.stringify(json.event)}\n\n`);
                            }
                        } catch (e) {}
                    }
                    res.end();
                });

            } catch (err) {
                console.error("Error handling request:", err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Not Found" }));
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in proxy:', reason);
});

const PORT = 5005;
server.listen(PORT, '127.0.0.1', () => {
    console.log(`Zed Proxy listening on http://127.0.0.1:${PORT}`);
});
