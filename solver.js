// ==UserScript==
// @name         RNG Room Solver (Tabbed + Collect + AI)
// @namespace    rngroom.solver
// @version      11.0.0
// @description  被动监听房间 API，使用可配置的 RNGdle AI 网站 API 决策并填充答案
// @match        *://rngdle.jdscript.dev/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    if (window.top !== window.self) return;

    const API_ORIGIN     = 'https://rngdle.jdscript.dev';
    const MIN_REMAIN_MS  = 2500;
    const ROOM_RE        = /\/api\/rooms\/([A-Za-z0-9_-]+)(?:[/?#]|$)/;
    const API_RETRY_MS   = 8000;

    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ============================================================
    // 配置
    // ============================================================
    const DEFAULT_CONFIG = {
        submitMode: 'simulate',
        autoMode: false,
        settingsOpen: true,
        aiApiUrl: '',
        aiApiToken: '',
        autoJoin: false,
        autoAccept: false,
        joinMode: 'compose',
        heartbeatMs: 2000,
    };

    const storeGet = (k, d) => { try { return GM_getValue(k, d); } catch { return d; } };
    const storeSet = (k, v) => { try { GM_setValue(k, v); } catch {} };

    const storedConfig = storeGet('config', {}) || {};
    let config = Object.assign({}, DEFAULT_CONFIG);
    for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (Object.prototype.hasOwnProperty.call(storedConfig, key)) config[key] = storedConfig[key];
    }
    const legacyAuto = storeGet('autoMode', null);
    if (typeof legacyAuto === 'boolean' && config.autoMode === DEFAULT_CONFIG.autoMode) config.autoMode = legacyAuto;

    const saveConfig = () => storeSet('config', config);

    // ============================================================
    // 状态
    // ============================================================
    let uiReady = false;
    let host = null, shadow = null, panelBuilt = false;
    let collapsed = false, visible = false;
    let settingsOpen = config.settingsOpen !== false;

    let activeTab = 'solver';
    let hasNewResult = false;

    let currentCode = null, room = null;
    let serverFetchedAt = 0, localFetchedAt = 0;

    let candidates = [], candidatesKey = null;
    let targetDecisionBusy = false, targetDecisionError = false, targetDecisionToken = 0;

    let renderedCandidatesKey = null;
    let renderedMatchKey = null;

    let executing = false, autoFiredKey = null, autoTimer = null;
    let lastSubmittedKey = null, apiSubmitTimer = null;

    let statusText = '', statusKind = 'info';
    let pendingPayload = null, rafId = null;

    let latestResult = null, lastHistoryLen = 0, renderedResultRound = null;

    // collect 模式
    let collectCurrent = null;
    let collectSaved   = [];

    // 匹配
    let matchmaking        = null;
    let stateInfo         = { queueCounts: null, lastStateAt: 0 };
    let matchmakingTimer   = null;
    let matchmakingPending = false;
    let lastHeartbeatAt    = 0;
    let autoJoinCooldown   = 0;
    let autoAcceptCooldown = 0;
    let matchmakingMatchId = null;   // 已接受过的 matchId

    // compose 模式
    let composeState     = null;   // { rounds: [{key,open,best}], answers, answerRevision, submitted }
    let composeDrafting  = false;
    let composeDraftRev  = -1;     // 上一次成功 draft 的 revision
    let composeSolveKey  = null;
    let composeSolveToken = 0;
    let composeSolveBusy = false;
    let composeSolveFailed = false;
    let composeSolveRetryAt = 0;

    // collect 决策
    let collectDecision      = null;
    let collectDecisionKey   = null;
    let collectDecisionBusy  = false;
    let collectDecisionToken = 0;
    let collectDecisionRetryAt = 0;

    // 网站 AI 会话
    let solverGameId   = null;
    let solverGameRoom = null;
    let solverGameType = null;
    let solverGamePromise = null;
    let solverGeneration = 0;

    // ============================================================
    // 工具
    // ============================================================
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = (a, b) => a + Math.random() * (b - a);
    const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    function pickAutoTarget() { return candidates[0] || null; }
    function isStateUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(String(url), location.href);
            if (u.origin !== API_ORIGIN && u.origin !== location.origin) return false;
            return u.pathname === '/api/state';
        } catch { return false; }
    }
    function isHeartbeatUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(String(url), location.href);
            if (u.origin !== API_ORIGIN && u.origin !== location.origin) return false;
            return u.pathname === '/api/matchmaking/heartbeat';
        } catch { return false; }
    }

    // ============================================================
    // 拦截器
    // ============================================================
    function matchRoom(url) {
        if (!url) return null;
        try {
            const u = new URL(String(url), location.href);
            if (u.origin !== API_ORIGIN && u.origin !== location.origin) return null;
            const m = u.pathname.match(ROOM_RE);
            return m ? m[1] : null;
        } catch { return null; }
    }

    function installInterceptors() {
        if (typeof W.fetch === 'function') {
            const origFetch = W.fetch;
            W.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const promise = origFetch.apply(this, arguments);
                const code = matchRoom(url);
                if (code) {
                    promise.then(res => {
                        if (res.ok) {
                            res.clone().json()
                                .then(data => { if (data && typeof data === 'object') onRoomPayload(code, data); })
                                .catch(() => {});
                        }
                    }).catch(() => {});
                } else if (isHeartbeatUrl(url)) {
                    promise.then(res => {
                        if (res.ok) {
                            res.clone().json()
                                .then(data => { if (data && typeof data === 'object') onHeartbeatFromInterceptor(data); })
                                .catch(() => {});
                        }
                    }).catch(() => {});
                } else if (isStateUrl(url)) {
                    promise.then(res => {
                        if (res.ok) {
                            res.clone().json()
                                .then(data => { if (data && typeof data === 'object') onStateFromPage(data); })
                                .catch(() => {});
                        }
                    }).catch(() => {});
                }
                return promise;
            };
        }
        if (W.XMLHttpRequest) {
            const proto = W.XMLHttpRequest.prototype;
            const origOpen = proto.open, origSend = proto.send;
            proto.open = function (method, url, ...rest) {
                this.__rngs_url = url;
                return origOpen.call(this, method, url, ...rest);
            };
            proto.send = function (...args) {
                this.addEventListener('load', () => {
                    if (this.status >= 400) return;
                    const code = matchRoom(this.__rngs_url);
                    if (!code) return;
                    if (isStateUrl(this.__rngs_url)) {
                        try {
                            let d;
                            if (this.responseType === 'json') d = this.response;
                            else if (!this.responseType || this.responseType === 'text' || this.responseType === '') d = JSON.parse(this.responseText);
                            else return;
                            if (d && typeof d === 'object') onStateFromPage(d);
                        } catch {}
                        return;
                    }
                    if (isHeartbeatUrl(this.__rngs_url)) {
                        try {
                            let d;
                            if (this.responseType === 'json') d = this.response;
                            else if (!this.responseType || this.responseType === 'text' || this.responseType === '') d = JSON.parse(this.responseText);
                            else return;
                            if (d && typeof d === 'object') onHeartbeatFromInterceptor(d);
                        } catch {}
                        return;
                    }
                    try {
                        let data;
                        if (this.responseType === 'json') data = this.response;
                        else if (!this.responseType || this.responseType === 'text' || this.responseType === '') {
                            data = JSON.parse(this.responseText);
                        } else return;
                        if (data && typeof data === 'object') onRoomPayload(code, data);
                    } catch {}
                });
                return origSend.apply(this, args);
            };
        }
    }

    // ============================================================
    // RNGdle AI API
    // ============================================================
    function normalizedAiApiUrl(value = config.aiApiUrl) {
        const raw = String(value || '').trim();
        if (!raw) throw new Error('请先在设置中填写 AI 网站地址');
        let url;
        try { url = new URL(raw); }
        catch { throw new Error('AI 网站地址格式无效'); }
        if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
            throw new Error('AI 网站地址必须使用 HTTPS（本机调试可使用 HTTP）');
        }
        if (url.username || url.password || url.search || url.hash) {
            throw new Error('AI 网站地址不能包含账号、查询参数或片段');
        }
        return url.origin + url.pathname.replace(/\/+$/, '');
    }

    function aiApiRequest(method, path, body, timeout = 30000) {
        const baseUrl = normalizedAiApiUrl();
        const apiToken = String(config.aiApiToken || '').trim();
        if (!apiToken) return Promise.reject(new Error('请先在设置中填写网站 API Token'));
        return new Promise((resolve, reject) => {
            const opts = {
                method,
                url: baseUrl + path,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${apiToken}`,
                },
                timeout,
                onload: r => {
                    if (r.status < 200 || r.status >= 300) {
                        let msg = `HTTP ${r.status}`;
                        try {
                            const j = JSON.parse(r.responseText);
                            if (j && j.error) msg += ': ' + j.error;
                        } catch {}
                        return reject(new Error(msg));
                    }
                    try { resolve(r.responseText ? JSON.parse(r.responseText) : {}); }
                    catch { reject(new Error('网站 API 响应非 JSON')); }
                },
                onerror: () => reject(new Error('网站 API 网络错误')),
                ontimeout: () => reject(new Error('网站 API 请求超时')),
            };
            if (body !== undefined) opts.data = JSON.stringify(body);
            GM_xmlhttpRequest(opts);
        });
    }

    function ensureSolverGame(game) {
        if (!['composition', 'collection', 'target'].includes(game)) {
            return Promise.reject(new Error('不支持的 AI 游戏类型'));
        }
        if (!config.aiApiToken || !config.aiApiUrl) {
            return Promise.reject(new Error('请先配置网站地址和 API Token'));
        }
        if (!/^rng_[A-Za-z0-9_-]+$/.test(config.aiApiToken.trim())) {
            return Promise.reject(new Error('API Token 格式无效，应以 rng_ 开头'));
        }
        if (solverGameId && solverGameRoom === currentCode && solverGameType === game) {
            return Promise.resolve(solverGameId);
        }
        if (solverGamePromise?.room === currentCode && solverGamePromise?.game === game) {
            return solverGamePromise.promise;
        }
        if (solverGameId || solverGamePromise) teardownSolverGame();
        const generation = solverGeneration;
        const pending = { room: currentCode, game, promise: null };
        pending.promise = aiApiRequest('POST', '/api/games', { game }).then(res => {
            if (generation !== solverGeneration) throw new Error('AI 会话已切换');
            if (!res || !res.game_id) {
                throw new Error('创建 AI 会话失败：API 未返回 game_id');
            }
            solverGameId = res.game_id;
            solverGameRoom = currentCode;
            solverGameType = game;
            return solverGameId;
        }).finally(() => {
            if (solverGamePromise === pending) solverGamePromise = null;
        });
        solverGamePromise = pending;
        return pending.promise;
    }

    async function askAi(game, input) {
        const gameId = await ensureSolverGame(game);
        const result = await aiApiRequest(
            'POST',
            `/api/games/${encodeURIComponent(gameId)}/decide`,
            input,
            game === 'collection' ? 60000 : 30000,
        );
        if (!result || !result.decision) {
            throw new Error('网站 API 未返回决策结果');
        }
        return result.decision;
    }

    function invalidateAiDecisions() {
        teardownSolverGame();
        targetDecisionToken++;
        targetDecisionBusy = false;
        targetDecisionError = false;
        candidates = [];
        candidatesKey = null;
        collectDecisionToken++;
        collectDecisionKey = null;
        collectDecision = null;
        collectDecisionBusy = false;
        collectDecisionRetryAt = 0;
        composeSolveToken++;
        composeSolveKey = null;
        composeSolveBusy = false;
        composeSolveFailed = false;
        composeSolveRetryAt = 0;
        if (!room) {
            updatePanel();
            return;
        }
        if (room.mode === 'collect') onCollectPayload();
        else if (room.mode === 'compose') onComposePayload();
        else if (room.phase === 'playing' && room.number != null && room.target != null) {
            candidatesKey = `${room.number}|${room.target}`;
            requestTargetDecision(candidatesKey);
        }
        updatePanel();
    }

    function saveAiSettings() {
        const apiUrlInput = shadow?.querySelector('.api-url-input');
        const apiTokenInput = shadow?.querySelector('.api-token-input');
        const apiUrl = apiUrlInput ? apiUrlInput.value.trim().replace(/\/+$/, '') : '';
        const apiToken = apiTokenInput ? apiTokenInput.value.trim() : '';
        if (apiUrl) normalizedAiApiUrl(apiUrl);
        if (apiToken && !/^rng_[A-Za-z0-9_-]+$/.test(apiToken)) {
            throw new Error('API Token 格式无效，应以 rng_ 开头');
        }
        config.aiApiUrl = apiUrl;
        config.aiApiToken = apiToken;
        saveConfig();
        invalidateAiDecisions();
        setStatus(config.aiApiUrl && config.aiApiToken
            ? '网站 API 设置已保存'
            : '网站 API 设置已清除；填写地址和 Token 后才能请求 AI', config.aiApiUrl && config.aiApiToken ? 'ok' : 'info');
    }

    async function testAiConnection() {
        try {
            saveAiSettings();
            const profile = await aiApiRequest('GET', '/api/me');
            const games = Array.isArray(profile.apiTokens?.[0]?.allowedGames)
                ? profile.apiTokens[0].allowedGames.join(', ')
                : '';
            setStatus(`API 连接成功${games ? ` · 授权游戏：${games}` : ''}`, 'ok');
            updatePanel();
        } catch (error) {
            setStatus('API 连接失败: ' + error.message, 'error');
            updatePanel();
        }
    }

    function teardownSolverGame() {
        solverGeneration++;
        solverGameId = null;
        solverGameRoom = null;
        solverGameType = null;
        solverGamePromise = null;
    }

    // ============================================================
    // 数据接收
    // ============================================================
    function onRoomPayload(code, data) {
        if (!uiReady) { pendingPayload = [code, data]; return; }
        if (data.error) { if (code === currentCode) setStatus('API: ' + data.error, 'error'); return; }

        const isTargetMode = typeof data.phase === 'string';
        const isCollectMode = data.mode === 'collect';
        const isComposeMode = data.mode === 'compose';
        if (data.code !== code || (!isTargetMode && !isCollectMode && !isComposeMode)) return;

        const isNewRoom = code !== currentCode;
        if (isNewRoom) {
            currentCode = code;
            room = null;
            candidates = []; candidatesKey = null;
            renderedCandidatesKey = null;
            autoFiredKey = null; lastSubmittedKey = null;
            clearTimeout(autoTimer); autoTimer = null;
            clearTimeout(apiSubmitTimer); apiSubmitTimer = null;
            latestResult = null; lastHistoryLen = 0; hasNewResult = false; renderedResultRound = null;
            collectCurrent = null; collectSaved = [];
            collectDecision = null;
            collectDecisionKey = null;
            collectDecisionBusy = false;
            collectDecisionRetryAt = 0;
            collectDecisionToken++;
            targetDecisionToken++;
            targetDecisionBusy = false;
            targetDecisionError = false;
            teardownSolverGame();
            composeState = null;
            composeDrafting = false;
            composeDraftRev = -1;
            composeSolveToken++;
            composeSolveKey = null;
            composeSolveBusy = false;
            if (!visible) showHost();
        }

        const previousMode = room ? (room.mode || 'target') : null;
        const incomingMode = isCollectMode ? 'collect' : isComposeMode ? 'compose' : 'target';
        const prevRound = room?.round;
        if (previousMode && previousMode !== incomingMode) {
            teardownSolverGame();
            if (previousMode === 'target') {
                targetDecisionToken++;
                targetDecisionBusy = false;
                targetDecisionError = false;
                candidates = [];
                candidatesKey = null;
            } else if (previousMode === 'collect') {
                collectDecisionToken++;
                collectDecisionBusy = false;
                collectDecision = null;
                collectDecisionKey = null;
            } else if (previousMode === 'compose') {
                composeSolveToken++;
                composeSolveBusy = false;
                composeSolveFailed = false;
                composeSolveKey = null;
                composeState = null;
            }
        }
        room = data;
        serverFetchedAt = data.serverTime || Date.now();
        localFetchedAt = Date.now();

        // ---- collect 模式 ----
        if (isCollectMode) {
            onCollectPayload();
            updatePanel();
            return;
        }
        // ---- compose 模式 ----
        if (isComposeMode) {
            onComposePayload();
            updatePanel();
            maybeAutoSubmitCompose();
            return;
        }
        // ---- target 模式 ----
        if (previousMode === 'collect') {
            collectDecisionToken++;
        } else if (previousMode === 'compose') {
            composeSolveToken++;
        }
        collectDecision = null;
        collectDecisionKey = null;
        collectDecisionBusy = false;
        if (prevRound != null && room.round !== prevRound) {
            autoFiredKey = null;
            clearTimeout(autoTimer); autoTimer = null;
            clearTimeout(apiSubmitTimer); apiSubmitTimer = null;
            statusText = ''; statusKind = 'info';
        }

        if (room.number != null && room.target != null && room.phase === 'playing') {
            const key = `${room.number}|${room.target}`;
            if (key !== candidatesKey) {
                candidatesKey = key;
                candidates = [];
                targetDecisionBusy = false;
                requestTargetDecision(key);
                autoFiredKey = null;
            }
        } else {
            candidates = [];
            candidatesKey = null;
            targetDecisionBusy = false;
            targetDecisionToken++;
        }

        checkResultUpdate();
        updatePanel();
        maybeAutoExecute();
    }

    function maybeAutoExecute() {
        if (!config.autoMode || executing || !candidates.length) return;
        if (!room || room.mode === 'collect' || room.mode === 'compose') return;
        if (!canExecute()) return;
        if (autoFiredKey === candidatesKey) return;
        if (remainingMs() < MIN_REMAIN_MS + 1500) return;

        autoFiredKey = candidatesKey;
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            if (!config.autoMode || executing || !room) return;
            if (!canExecute()) return;
            const target = pickAutoTarget();
            if (target) executeRow(target);
        }, jitter(600, 1500));
    }

    function maybeAutoExecuteCollect() {
        if (!config.autoMode || executing) return;
        if (!room || room.mode !== 'collect') return;
        if (!collectCurrent) return;
        if (collectDecisionBusy) return;
        if (!collectDecision) return;

        const key = `c:${room.index}`;
        if (autoFiredKey === key) return;

        if (collectDecision.action === 'skip') {
            autoFiredKey = key;
            return;
        }

        if (room.nextAt && room.nextAt - serverNow() < 900) return;

        autoFiredKey = key;
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            if (!config.autoMode || executing || !room) return;
            if (room.mode !== 'collect') return;
            if (collectDecisionBusy) return;
            if (collectDecision && collectDecision.action !== 'skip') executeCollect(collectDecision);
        }, jitter(80, 220));
    }

    // ============================================================
    // collect 模式
    // ============================================================
    function onCollectPayload() {
        if (!room || room.mode !== 'collect') return;

        const savedRaw = room.saved || [];
        collectSaved = savedRaw.map(s => ({ index: s.index, number: s.number, ep: null }));

        if (room.number != null) {
            collectCurrent = {
                index: room.index,
                number: room.number,
                ep: collectCurrent?.number === room.number ? collectCurrent.ep : null,
            };
        } else {
            collectCurrent = null;
            collectDecisionToken++;
            collectDecisionKey = null;
            collectDecision = null;
            collectDecisionBusy = false;
        }

        computeCollectDecisionAsync();
    }

    async function computeCollectDecisionAsync() {
        if (!room || room.mode !== 'collect' || !collectCurrent) return;

        const totalTurns = room.config?.count ?? 30;
        const slots = room.config?.slots ?? 5;
        const remainingTurns = Math.max(1, totalTurns - (room.index ?? 0));
        const slotsRemaining = Math.min(
            Math.max(0, slots - collectSaved.length),
            remainingTurns,
        );
        const key = `c:${room.index}:${room.number}:${remainingTurns}:${slotsRemaining}`;
        if (collectDecisionKey === key && (collectDecisionBusy || collectDecision)) return;
        if (collectDecisionKey === key && Date.now() < collectDecisionRetryAt) return;

        const token = ++collectDecisionToken;
        collectDecisionKey = key;
        collectDecision = null;
        collectDecisionBusy = true;
        updatePanel();

        try {
            const snapNumber = room.number;
            const result = await askAi('collection', {
                current: snapNumber,
                remainingTurns,
                slotsRemaining,
            });
            if (token !== collectDecisionToken) return;
            if (room.number !== snapNumber) return;
            if (!result || !['take', 'skip'].includes(result.action) || !Number.isFinite(result.score)) {
                throw new Error('Time Collection 决策响应格式无效');
            }
            collectCurrent.ep = result.score;
            collectDecisionRetryAt = 0;
            collectDecision = result.action === 'take'
                ? { action: 'save', currentIndex: collectCurrent.index, currentEp: result.score, note: '网站 AI 建议收下', matched: result.matched }
                : { action: 'skip', reason: '网站 AI 建议跳过', currentEp: result.score, matched: result.matched };
            collectDecisionBusy = false;
            updatePanel();
            maybeAutoExecuteCollect();
        } catch (e) {
            if (token !== collectDecisionToken) return;
            setStatus('AI 调用失败: ' + e.message, 'error');
            collectDecision = null;
            collectDecisionBusy = false;
            collectDecisionRetryAt = Date.now() + 5000;
            updatePanel();
        }
    }

    function postSave(index) {
        const url = `${API_ORIGIN}/api/rooms/${encodeURIComponent(currentCode)}/save`;
        return postJson(url, { index });
    }

    async function executeCollect(decision) {
        if (executing || !decision) return;
        if (!room || room.mode !== 'collect') return;
        if (decision.action === 'skip') return;

        if (room.nextAt && room.nextAt - serverNow() < 800) {
            setStatus('时间不足，跳过');
            return;
        }

        const snapIndex = room.index;
        const snapNumber = room.number;
        executing = true;
        try {
            if (decision.action === 'save') {
                setStatus(`保存 ${snapNumber} (EP ${decision.currentEp})…`);
                await postSave(decision.currentIndex);
                setStatus(`已保存 ${snapNumber} · EP ${decision.currentEp}`, 'ok');
            }
            autoFiredKey = `c:${snapIndex}`;
        } catch (e) {
            setStatus('收集执行失败: ' + (e.message || e), 'error');
        } finally {
            executing = false;
            updatePanel();
        }
    }

    async function removeSaved(index) {
        if (executing) return;
        if (!room || room.mode !== 'collect') return;
        executing = true;
        try {
            setStatus(`移除 index=${index}…`);
            await postSave(index);
            setStatus(`已移除 index=${index}`, 'ok');
        } catch (e) {
            setStatus('移除失败: ' + (e.message || e), 'error');
        } finally {
            executing = false;
            updatePanel();
        }
    }

    // ============================================================
    // compose 模式
    // ============================================================
    function onComposePayload() {
        if (!room || room.mode !== 'compose') return;

        const roundsData = room.rounds || [];
        const prevRev = composeState?.answerRevision;
        const newRev = room.answerRevision ?? 0;
        const solveKey = JSON.stringify([newRev, roundsData.map(({ key, open }) => [key, open])]);
        if (composeSolveKey === solveKey && (
            composeSolveBusy
            || (composeState && !composeSolveFailed)
            || (composeSolveFailed && Date.now() < composeSolveRetryAt)
        )) {
            if (composeState) {
                composeState.answers = room.answers || [];
                composeState.submitted = !!room.submitted;
            }
            return;
        }

        // 服务器推送了新 revision（可能是我方 draft 被接受），刷新本地标记
        if (prevRev !== undefined && prevRev !== newRev) {
            composeDrafting = false;
            if (composeDraftRev === prevRev) composeDraftRev = newRev;
        }

        const token = ++composeSolveToken;
        composeSolveKey = solveKey;
        composeSolveBusy = true;
        composeSolveFailed = false;
        composeState = {
            rounds: roundsData.map(r => ({
                key: r.key,
                open: r.open,
                best: null,
            })),
            answers: room.answers || [],
            answerRevision: newRev,
            submitted: !!room.submitted,
        };
        updatePanel();

        (async () => {
            try {
                const decisions = await Promise.all(roundsData.map(round =>
                    askAi('composition', { key: round.key, open: round.open }),
                ));
                if (token !== composeSolveToken || !room || room.mode !== 'compose') return;
                for (let index = 0; index < decisions.length; index++) {
                    const decision = decisions[index];
                    const allowedTags = new Set([
                        ...roundsData[index].key.map((_, digitIndex) => `k${digitIndex}`),
                        ...roundsData[index].open.map((_, digitIndex) => `o${digitIndex}`),
                    ]);
                    if (!Number.isSafeInteger(decision.number)
                        || !Number.isFinite(decision.score)
                        || !Array.isArray(decision.arrangement)
                        || decision.arrangement.length !== 6
                        || new Set(decision.arrangement).size !== 6
                        || decision.arrangement.some(tag => !allowedTags.has(tag))
                        || decision.arrangement[1]?.[0] !== 'k'
                        || decision.arrangement[4]?.[0] !== 'k') {
                        throw new Error('Digit Composition 决策响应格式无效');
                    }
                }
                composeState.rounds = roundsData.map((round, index) => {
                    const decision = decisions[index];
                    return {
                        key: round.key,
                        open: round.open,
                        best: {
                            number: decision.number,
                            digits: decision.digits,
                            ep: decision.score,
                            arrangement: decision.arrangement,
                            matched: decision.matched,
                        },
                    };
                });
                composeState.answers = room.answers || [];
                composeState.submitted = !!room.submitted;
                composeSolveBusy = false;
                composeSolveFailed = false;
                composeSolveRetryAt = 0;
                setStatus('网站 AI 已完成全部题目决策', 'ok');
                updatePanel();
                maybeAutoSubmitCompose();
            } catch (error) {
                if (token !== composeSolveToken) return;
                composeSolveBusy = false;
                composeSolveFailed = true;
                composeSolveRetryAt = Date.now() + 5000;
                setStatus('组合 AI 调用失败: ' + error.message, 'error');
                updatePanel();
            }
        })();
    }

    function buildComposeAnswers() {
        if (!composeState) return null;
        return composeState.rounds.map(r =>
                                       r.best ? r.best.arrangement.slice() : [null, null, null, null, null, null]
                                      );
    }

    async function submitCompose(force = false) {
        if (!room || room.mode !== 'compose') return;
        if (composeDrafting) return;
        if (!composeState || !composeState.rounds.every(r => r.best)) {
            setStatus('尚未计算完所有题目', 'error');
            return;
        }
        if (room.submitted) {
            setStatus('已提交，无需重复');
            return;
        }
        if (remainingMs() <= 2000) {
            setStatus('时间不足，放弃提交');
            return;
        }
        if (!force && composeDraftRev === room.answerRevision) {
            setStatus('该版本已 draft 过');
            return;
        }

        const answers = buildComposeAnswers();
        const revision = room.answerRevision ?? 0;
        const url = `${API_ORIGIN}/api/rooms/${encodeURIComponent(currentCode)}/draft`;

        composeDrafting = true;
        updateControls();
        try {
            setStatus(`draft 提交中（revision ${revision}）…`);
            await postJson(url, { revision, answers });
            composeDraftRev = revision;
            setStatus(`已 draft（revision ${revision}）`, 'ok');
        } catch (e) {
            setStatus('draft 失败: ' + (e.message || e), 'error');
        } finally {
            composeDrafting = false;
            updatePanel();
        }
    }

    function maybeAutoSubmitCompose() {
        if (!config.autoMode || composeDrafting) return;
        if (!room || room.mode !== 'compose') return;
        if (room.submitted) return;
        if (!composeState || !composeState.rounds.every(r => r.best)) return;
        if (remainingMs() < 5000) return;
        if (composeDraftRev === room.answerRevision) return;

        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
            autoTimer = null;
            if (!config.autoMode || composeDrafting) return;
            if (!room || room.mode !== 'compose') return;
            if (room.submitted) return;
            if (composeDraftRev === room.answerRevision) return;
            if (remainingMs() < 3000) return;
            submitCompose(false);
        }, jitter(800, 1500));
    }
    // ============================================================
    // 匹配
    // ============================================================
    function inActiveMatch() {
        if (!room) return false;
        if (room.phase === 'playing') return true;
        if (room.status === 'active') return true;
        return false;
    }

    function shouldPollHeartbeat() {
        if (matchmaking && matchmaking.status === 'matched') return false;
        // 只要开了任意自动开关，就持续轮询，不再依赖当前 tab
        if (config.autoJoin || config.autoAccept) return true;
        if (activeTab === 'match') return true;
        return false;
    }

    function onHeartbeatFromPage(data) {
        if (!data || typeof data !== 'object') return;
        matchmaking = data;
        lastHeartbeatAt = Date.now();
    }
    function onHeartbeatFromInterceptor(data) {
        onHeartbeatFromPage(data);
        handleAutoMatchActions();
        updatePanel();
        if (matchmakingTimer !== null) scheduleNextHeartbeat();
    }
    function onStateFromPage(data) {
        if (!data || typeof data !== 'object') return;
        if (data.error) return;

        const inRoom = data.currentRoom != null;
        stateInfo.queueCounts = data.queueCounts || null;
        stateInfo.lastStateAt = Date.now();

        // 从 state 同步 matchmaking 状态。state 里的 matchmaking 只带 status，
        // 其它字段（matchId / deadline）由 heartbeat 补充。
        const mm = data.matchmaking;
        if (mm && typeof mm === 'object' && typeof mm.status === 'string') {
            if (!matchmaking) {
                matchmaking = { status: mm.status };
            } else if (matchmaking.status !== mm.status) {
                if (mm.status === 'idle') {
                    // state 说 idle，以 state 为准。如果我们在房间里，currentRoom 会非空，
                    // 所以到这里说明确实已经不在队列/确认/比赛中。
                    matchmaking = { status: 'idle' };
                } else if (matchmaking.status === 'matched') {
                    // matched 回退到其它状态（用户离开房间后）
                    matchmaking = { status: mm.status };
                } else {
                    matchmaking = { ...matchmaking, status: mm.status };
                }
            }
        }

        updatePanel();

        // 从 matched 回到 idle/queued，恢复轮询
        if (matchmaking?.status !== 'matched' && shouldPollHeartbeat() && matchmakingTimer === null) {
            scheduleNextHeartbeat(0);
        }

        // idle 且当前不在房间、不在比赛中 → 尝试 join
        if (config.autoJoin
            && !inRoom
            && !inActiveMatch()
            && !matchmakingPending
            && matchmaking?.status === 'idle'
            && Date.now() - autoJoinCooldown > 2500) {
            autoJoinCooldown = Date.now();
            joinQueue();
        }
    }
    function scheduleNextHeartbeat(delay) {
        clearTimeout(matchmakingTimer);
        matchmakingTimer = null;
        if (!shouldPollHeartbeat()) return;
        const ms = delay ?? config.heartbeatMs;
        matchmakingTimer = setTimeout(doHeartbeat, ms);
    }

    async function doHeartbeat() {
        matchmakingTimer = null;
        if (!shouldPollHeartbeat()) return;
        if (matchmakingPending) {
            scheduleNextHeartbeat(500);
            return;
        }
        matchmakingPending = true;
        let ok = false;
        try {
            const data = await matchmakingHttp('POST', '/api/matchmaking/heartbeat', {});
            onHeartbeatFromPage(data);
            ok = true;
        } catch (e) {
            // 静默，下次重试
        } finally {
            matchmakingPending = false;
            // pending 已经复位，此时才能安全触发 join / accept
            if (ok) handleAutoMatchActions();
            updatePanel();
            if (matchmakingTimer === null) scheduleNextHeartbeat();
        }
    }
    async function matchmakingHttp(method, path, body) {
        const url = `${API_ORIGIN}${path}`;
        const res = await W.fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-rng-room': '1',
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            credentials: 'include',
            cache: 'no-store',
        });
        if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try { const j = await res.json(); if (j && j.error) msg += ': ' + j.error; } catch {}
            throw new Error(msg);
        }
        try { return await res.json(); } catch { return {}; }
    }

    function handleAutoMatchActions() {
        if (!matchmaking) return;
        if (matchmaking.status === 'matched') return;
        if (inActiveMatch()) return;

        const now = Date.now();

        if (config.autoAccept
            && matchmaking.status === 'confirming'
            && matchmaking.matchId
            && !matchmaking.accepted
            && matchmaking.matchId !== matchmakingMatchId
            && now - autoAcceptCooldown > 1000) {
            autoAcceptCooldown = now;
            acceptMatch(matchmaking.matchId);
            return;
        }

        if (config.autoJoin
            && matchmaking.status === 'idle'
            && now - autoJoinCooldown > 2000) {
            autoJoinCooldown = now;
            joinQueue();
        }
    }
    async function cancelMatchmaking() {
        if (matchmakingPending) return;
        if (!matchmaking) return;
        if (matchmaking.status !== 'queued' && matchmaking.status !== 'confirming') {
            setStatus('当前状态无法取消');
            return;
        }
        matchmakingPending = true;
        try {
            await matchmakingHttp('POST', '/api/matchmaking/cancel', {});
            setStatus('已取消匹配', 'ok');
            // 立即刷新一次状态
            setTimeout(() => { doHeartbeat(); }, 300);
        } catch (e) {
            setStatus('取消失败: ' + (e.message || e), 'error');
        } finally {
            matchmakingPending = false;
            updatePanel();
        }
    }
    async function joinQueue() {
        if (matchmakingPending) return;
        if (matchmaking.status === 'queued' || matchmaking.status === 'confirming') return;
        if (inActiveMatch()) { setStatus('已在比赛中，跳过 join'); return; }
        matchmakingPending = true;
        try {
            await matchmakingHttp('POST', '/api/matchmaking/join', { mode: config.joinMode });
            setStatus(`已加入 ${config.joinMode} 队列`, 'ok');
        } catch (e) {
            setStatus('加入失败: ' + (e.message || e), 'error');
        } finally {
            matchmakingPending = false;
            doHeartbeat();
        }
    }

    async function acceptMatch(matchId) {
        if (!matchId) return;
        if (matchmakingPending) return;
        matchmakingPending = true;
        try {
            await matchmakingHttp('POST', '/api/matchmaking/accept', { matchId });
            matchmakingMatchId = matchId;
            setStatus(`已接受 ${matchId.slice(0, 8)}…`, 'ok');
        } catch (e) {
            setStatus('接受失败: ' + (e.message || e), 'error');
        } finally {
            matchmakingPending = false;
            doHeartbeat();
        }
    }
    // ============================================================
    // 结果更新（target 模式）
    // ============================================================
    function checkResultUpdate() {
        if (!room || room.mode === 'collect' || room.mode === 'compose') return;
        const len = room.history?.length || 0;
        if (len === lastHistoryLen) return;
        lastHistoryLen = len;
        if (len === 0) { latestResult = null; return; }
        const latest = room.history[len - 1];
        if (!latest || !latest.editRankings) return;
        latestResult = { data: latest, roundNo: len };
        if (activeTab !== 'result') hasNewResult = true;
        renderedResultRound = null;
        updateTabDot();
        if (activeTab === 'result') renderResultView();
    }

    // ============================================================
    // 时间
    // ============================================================
    function serverNow() { return room ? serverFetchedAt + (Date.now() - localFetchedAt) : Date.now(); }
    function remainingMs() {
        if (!room) return 0;
        const deadline = room.deadline ?? room.end;
        if (deadline == null) return 0;
        return Math.max(0, deadline - serverNow());
    }

    // ============================================================
    // 候选（target 模式）
    // ============================================================
    async function requestTargetDecision(key) {
        const token = ++targetDecisionToken;
        const number = room?.number;
        const target = Math.round(room?.target);
        targetDecisionBusy = true;
        targetDecisionError = false;
        updatePanel();
        try {
            const result = await askAi('target', { number, target });
            if (token !== targetDecisionToken || key !== candidatesKey || !room) return;
            if (!Number.isSafeInteger(result.result)
                || !Number.isFinite(result.score)
                || !Number.isFinite(result.distance)
                || !Number.isInteger(result.position)
                || result.position < 0
                || result.position >= String(number).length
                || !Number.isInteger(result.replacement)
                || result.replacement < 0
                || result.replacement > 9) {
                throw new Error('Target Chase 决策响应格式无效');
            }
            candidates = [{
                number: result.result,
                ep: result.score,
                delta: result.distance,
                pos: result.position,
                from: String(number)[result.position],
                to: result.replacement,
                matched: result.matched,
            }];
            targetDecisionBusy = false;
            targetDecisionError = false;
            setStatus('网站 AI 决策完成', 'ok');
            updatePanel();
            maybeAutoExecute();
        } catch (error) {
            if (token !== targetDecisionToken) return;
            targetDecisionBusy = false;
            candidates = [];
            targetDecisionError = true;
            setStatus('网站 AI 决策失败: ' + error.message, 'error');
            updatePanel();
        }
    }

    function getDisplayList() {
        return candidates;
    }

    // ============================================================
    // 可执行性
    // ============================================================
    function canExecute() {
        if (!room) return false;
        if (room.mode === 'collect') {
            if (!collectCurrent) return false;
            if (remainingMs() <= 1000) return false;
            return true;
        }
        if (room.mode === 'compose') {
            if (!composeState || !composeState.rounds.every(r => r.best)) return false;
            if (room.submitted) return false;
            if (remainingMs() <= 2000) return false;
            return true;
        }
        if (room.phase !== 'playing') return false;
        if (room.submitted) return false;
        if (lastSubmittedKey === `${room.round}|${room.number}`) return false;
        if (remainingMs() <= MIN_REMAIN_MS) return false;
        if (config.submitMode === 'simulate' && !document.querySelector('form.target-edit-form')) return false;
        return true;
    }

    // ============================================================
    // 提交：模拟（target 模式）
    // ============================================================
    const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    function simulateDigitInput(input, digit) {
        const ch = String(digit), keyCode = 48 + digit;
        const common = { key: ch, code: `Digit${digit}`, keyCode, which: keyCode, bubbles: true, cancelable: true };
        const kd = new KeyboardEvent('keydown', common);
        input.dispatchEvent(kd);
        if (!kd.defaultPrevented) {
            nativeValueSetter.call(input, ch);
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        input.dispatchEvent(new KeyboardEvent('keypress', common));
        input.dispatchEvent(new KeyboardEvent('keyup', common));
    }

    async function simulateSubmit(row, snapshotRound, snapshotNumber) {
        const form = document.querySelector('form.target-edit-form');
        if (!form || !form.isConnected) throw new Error('找不到表单');
        const input = form.querySelector(`input[data-digit-index="${row.pos}"]`);
        if (!input) throw new Error(`位置 ${row.pos + 1} 无输入框`);
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
        input.click(); input.focus();
        try { input.select(); } catch {}
        await sleep(jitter(100, 220));
        const live = document.querySelector(`form.target-edit-form input[data-digit-index="${row.pos}"]`);
        if (!live) throw new Error('输入框消失');
        simulateDigitInput(live, row.to);
        await sleep(jitter(140, 300));
        const t0 = performance.now();
        let submit = null;
        while (performance.now() - t0 < 800) {
            const f = document.querySelector('form.target-edit-form');
            const s = f?.querySelector('button[type="submit"]');
            if (f?.isConnected && s && !s.disabled) { submit = s; break; }
            await sleep(30);
        }
        if (!submit) throw new Error('提交按钮不可用');
        if (room.round !== snapshotRound || room.number !== snapshotNumber) throw new Error('round 已切换');
        if (room.submitted) throw new Error('已提交');
        await sleep(jitter(80, 180));
        submit.click();
        lastSubmittedKey = `${snapshotRound}|${snapshotNumber}`;
    }

    // ============================================================
    // 提交：API
    // ============================================================
    function postJson(url, payload) {
        return W.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-rng-room': '1' },
            body: JSON.stringify(payload),
            credentials: 'include',
        }).then(async res => {
            if (!res.ok) {
                let body = '';
                try { body = await res.text(); } catch {}
                let msg = `HTTP ${res.status}`;
                try { const j = JSON.parse(body); if (j && j.error) msg = j.error; else if (body) msg = body; }
                catch { if (body) msg = body; }
                throw new Error(msg);
            }
            return res;
        });
    }

    async function apiSubmit(round, position, digit) {
        const base = `${API_ORIGIN}/api/rooms/${encodeURIComponent(currentCode)}`;
        const payload = { round, position, digit };
        await postJson(`${base}/draft`, payload);
        await postJson(`${base}/submit`, payload);
        lastSubmittedKey = `${round}|${room?.number}`;
        clearTimeout(apiSubmitTimer);
        const expectedRound = round;
        apiSubmitTimer = setTimeout(() => {
            apiSubmitTimer = null;
            if (room && room.round === expectedRound && !room.submitted) {
                lastSubmittedKey = null;
                setStatus('API 提交后服务器未更新，可重试', 'error');
                updatePanel();
            }
        }, API_RETRY_MS);
    }

    // ============================================================
    // 执行（target 模式）
    // ============================================================
    async function executeRow(row) {
        if (executing || !row) return;
        if (!canExecute()) { setStatus('当前不可执行', 'error'); return; }
        const snapshotRound = room.round, snapshotNumber = room.number;
        executing = true;
        try {
            if (config.submitMode === 'api') {
                setStatus(`API 提交 ${row.number}（位置 ${row.pos}: ${row.from}→${row.to}）…`);
                await apiSubmit(snapshotRound, row.pos, row.to);
                setStatus(`已通过 API 提交 ${row.number}，等待服务器更新`, 'ok');
            } else {
                setStatus(`模拟提交 ${row.number}…`);
                await simulateSubmit(row, snapshotRound, snapshotNumber);
                setStatus(`已提交 ${row.number} · Δ ${row.delta.toFixed(2)}`, 'ok');
            }
        } catch (e) {
            setStatus('执行失败: ' + (e.message || e), 'error');
        } finally {
            executing = false;
            updatePanel();
        }
    }

    // ============================================================
    // CSS
    // ============================================================
    const CSS = `
    :host { all: initial; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 13px; line-height: 1.5; }
    * { box-sizing: border-box; }
    .panel { background: #17171b; color: #e4e4e7; border: 1px solid #2c2c33; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3);
      display: flex; flex-direction: column; max-height: 85vh; overflow: hidden; }
    .panel.collapsed .tabs, .panel.collapsed .body { display: none; }
    .panel.collapsed { max-height: none; }
    .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      background: #1f1f24; border-bottom: 1px solid #2c2c33; cursor: grab; user-select: none; }
    .head:active { cursor: grabbing; }
    .head .brand { font-weight: 600; color: #f4f4f5; flex: 1; }
    .btn-icon { all: unset; width: 22px; height: 22px; display: inline-flex; align-items: center;
      justify-content: center; border-radius: 4px; color: #a1a1aa; cursor: pointer;
      font-size: 14px; line-height: 1; }
    .btn-icon:hover { background: #2a2a30; color: #f4f4f5; }
    .btn-icon.active { background: #27272a; color: #4ade80; }

    .tabs { display: flex; background: #1a1a1f; border-bottom: 1px solid #2c2c33; }
    .tab { all: unset; padding: 6px 14px; cursor: pointer; color: #a1a1aa; font: inherit;
      font-size: 12px; position: relative; border-bottom: 2px solid transparent;
      display: inline-flex; align-items: center; gap: 4px; }
    .tab:hover { color: #f4f4f5; }
    .tab.active { color: #f4f4f5; border-bottom-color: #16a34a; }
    .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: #ef4444; }
    .tab .dot[hidden] { display: none; }

    .body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .view[hidden] { display: none; }

    .view-solver .status { padding: 6px 10px; border-bottom: 1px solid #2c2c33; font-size: 12px;
      color: #a1a1aa; display: flex; flex-wrap: wrap; gap: 4px 10px; flex-shrink: 0; }
    .view-solver .status b { color: #f4f4f5; font-weight: 600; }
    .view-solver .status .sep { color: #52525b; }
    .status .warning { color: #fbbf24; }
    .status .error { color: #f87171; }
    .status .ok { color: #4ade80; }
    .countdown { font-variant-numeric: tabular-nums; }
    .countdown.low { color: #f87171; }
    .countdown.med { color: #fbbf24; }

    .view-solver .controls { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
      border-bottom: 1px solid #2c2c33; font-size: 12px; flex-wrap: wrap; flex-shrink: 0; }
    .controls label { display: flex; align-items: center; gap: 4px; cursor: pointer; color: #a1a1aa; }
    .btn { all: unset; font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 4px;
      border: 1px solid #3f3f46; background: #27272a; color: #f4f4f5; cursor: pointer; white-space: nowrap; }
    .btn:hover { filter: brightness(1.2); }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .btn.primary { background: #16a34a; border-color: #16a34a; color: #fff; }
    .btn.tiny { padding: 2px 6px; font-size: 11px; }
    .spacer { margin-left: auto; }
    .dim { color: #71717a; font-size: 11px; }

    .settings { padding: 6px 10px 8px; border-bottom: 1px solid #2c2c33; font-size: 12px;
      flex-shrink: 0; max-height: 55vh; overflow-y: auto; }
    .settings::-webkit-scrollbar { width: 8px; }
    .settings::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 4px; }
    .settings[hidden] { display: none; }
    .setting-row { display: flex; align-items: center; gap: 10px; margin: 5px 0; flex-wrap: wrap; }
    .setting-label { width: 34px; color: #71717a; flex-shrink: 0; }
    .api-settings { padding: 4px 0 8px; border-bottom: 1px solid #26262b; }
    .api-label { width: 62px; color: #a1a1aa; flex-shrink: 0; }
    .api-url-input, .api-token-input { flex: 1; min-width: 180px; padding: 5px 7px; font: inherit;
      font-size: 11px; background: #0f0f12; border: 1px solid #3f3f46; border-radius: 3px; color: #f4f4f5; }
    .api-settings .hint { color: #71717a; font-size: 11px; margin-top: 4px; line-height: 1.5; }
    .seg { display: flex; border: 1px solid #3f3f46; border-radius: 4px; overflow: hidden; flex-wrap: wrap; }
    .seg button { all: unset; padding: 3px 10px; cursor: pointer; color: #a1a1aa;
      font: inherit; font-size: 11px; border-right: 1px solid #3f3f46; }
    .seg button:last-child { border-right: 0; }
    .seg button:hover { background: #27272a; color: #f4f4f5; }
    .seg button.active { background: #16a34a; color: #fff; }
    .settings .hint { color: #71717a; font-size: 11px; margin-top: 4px; }

    /* collect 模式：只保留自动决策 */
    .settings.collect-mode > .setting-row,
    .settings.collect-mode > .trait-group,
    .settings.collect-mode > .custom-group,
    .settings.collect-mode > .hint { display: none; }
    .settings.collect-mode > .collect-hint { display: block; }
    .collect-hint { color: #a1a1aa; font-size: 11px; line-height: 1.6; padding: 4px 0; }
    .collect-hint code { color: #f4f4f5; font-family: ui-monospace, monospace; background: #0f0f12;
      padding: 1px 4px; border-radius: 3px; }

    .view-solver .scroller { flex: 1; overflow-y: auto; min-height: 60px; }
    .scroller::-webkit-scrollbar, .view-result::-webkit-scrollbar { width: 8px; }
    .scroller::-webkit-scrollbar-thumb, .view-result::-webkit-scrollbar-thumb {
      background: #3f3f46; border-radius: 4px; }

    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead th { padding: 4px 8px; background: #1f1f24; color: #a1a1aa; font-weight: 500;
      text-align: right; position: sticky; top: 0; z-index: 1; }
    thead th.left { text-align: left; }
    tbody td { padding: 4px 8px; border-top: 1px solid #26262b; text-align: right;
      font-variant-numeric: tabular-nums; }
    tbody td.left { text-align: left; }
    tbody tr.best { background: rgba(34,197,94,.10); }
    tbody tr.exact { background: rgba(34,197,94,.20); }
    tbody tr.exact .delta { color: #4ade80; }
    tbody tr:hover { background: rgba(255,255,255,.03); }
    .num { color: #f4f4f5; font-weight: 600; }
    .chg { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; color: #a1a1aa; }
    .empty { padding: 16px 12px; text-align: center; color: #71717a; font-size: 12px; }

    .collect-current { padding: 10px; border-bottom: 1px solid #26262b; }
    .collect-current .label { color: #71717a; font-size: 11px; margin-bottom: 4px; }
    .collect-current .big { font-family: ui-monospace, monospace; font-size: 22px;
      font-weight: 600; color: #f4f4f5; }
    .collect-current .ep { color: #a1a1aa; font-size: 13px; }
    .collect-current .ep b { color: #f4f4f5; }
    .collect-current .badge { font-size: 11px; padding: 2px 8px; border-radius: 3px;
      margin-left: auto; align-self: center; }
    .collect-current .badge.save { background: #14532d; color: #86efac; }
    .collect-current .badge.skip { background: #27272a; color: #71717a; }
    .collect-current .badge.busy { background: #1e3a8a; color: #93c5fd; }
    .collect-note { padding: 4px 10px 0; color: #71717a; font-size: 11px; }
    .collect-note.error { color: #f87171; }

    .view-result { overflow-y: auto; min-height: 0; }
    .result-section { padding: 8px 10px; border-bottom: 1px solid #26262b; }
    .result-section:last-child { border-bottom: 0; }
    .section-title { font-size: 11px; color: #a1a1aa; font-weight: 500;
      text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }
    .summary-row { display: flex; gap: 14px; font-size: 12px; color: #a1a1aa; flex-wrap: wrap; }
    .summary-row b { color: #f4f4f5; }
    .rankings-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .rankings-table thead th { padding: 3px 6px; background: #1a1a1f; color: #a1a1aa;
      font-weight: 500; text-align: right; position: sticky; top: 0; z-index: 1; font-size: 11px; }
    .rankings-table thead th.left { text-align: left; }
    .rankings-table tbody td { padding: 3px 6px; border-top: 1px solid #26262b; text-align: right;
      font-variant-numeric: tabular-nums; }
    .rankings-table tbody td.left { text-align: left; }
    .rankings-table tbody tr.rank1 { background: rgba(34,197,94,.15); }
    .rankings-table tbody tr.mine { background: rgba(59,130,246,.18); }
    .rankings-table tbody tr.mine.rank1 { background: rgba(34,197,94,.28); }
    .rankings-table tbody tr.opp { background: rgba(239,68,68,.12); }
    .rank-num { color: #71717a; font-size: 11px; }
    .baseline-info { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: #a1a1aa; }
    .baseline-info b { color: #f4f4f5; }
    .badge-change-block { display: flex; flex-direction: column; gap: 10px; font-size: 12px; }
    .player-row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .player-row .tag { display: inline-block; padding: 1px 6px; border-radius: 3px;
      background: #27272a; color: #a1a1aa; font-size: 10px; }
    .player-row .tag.you { background: #1e40af; color: #dbeafe; }
    .player-row .tag.opp { background: #7f1d1d; color: #fecaca; }
    .player-row b { color: #f4f4f5; }
    .player-row .delta { margin-left: auto; font-size: 11px; }
    .player-row .delta .add { color: #4ade80; }
    .player-row .delta .rem { color: #f87171; margin-left: 6px; }
    .badge-detail { padding-left: 12px; font-size: 11px; color: #71717a; line-height: 1.5; }
    .badge-detail .row-added::before { content: '+ '; color: #4ade80; }
    .badge-detail .row-removed::before { content: '− '; color: #f87171; }
    .badge-detail .badge-name { color: #e4e4e7; }
    .badge-detail .badge-ep { color: #fbbf24; }
        .compose-round { padding: 8px 10px; border-bottom: 1px solid #26262b; }
    .compose-header { display: flex; gap: 10px; font-size: 11px; color: #a1a1aa;
      margin-bottom: 6px; flex-wrap: wrap; }
    .compose-idx { color: #f4f4f5; font-weight: 600; }
    .compose-key-list { color: #fbbf24; font-family: ui-monospace, monospace; }
    .compose-open-list { color: #a1a1aa; font-family: ui-monospace, monospace; }
    .compose-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; }
    .compose-cell { padding: 6px 2px; border: 1px solid #3f3f46; border-radius: 4px;
      text-align: center; display: flex; flex-direction: column; align-items: center;
      gap: 2px; background: #0f0f12; }
    .compose-cell.key-pos { border-color: #fbbf24; background: #1c1917; }
    .compose-digit { font-family: ui-monospace, monospace; font-size: 16px;
      font-weight: 600; color: #f4f4f5; line-height: 1; }
    .compose-digit.empty { color: #52525b; }
    .compose-tag { font-size: 10px; color: #71717a; font-family: ui-monospace, monospace; }
    .compose-cell.key-pos .compose-tag { color: #fbbf24; }
    .compose-info { display: flex; gap: 12px; margin-top: 6px; font-size: 11px; color: #a1a1aa; }
    .compose-info b { color: #f4f4f5; }
    .compose-footer { padding: 8px 10px; display: flex; gap: 12px;
      font-size: 12px; color: #a1a1aa; border-top: 1px solid #26262b; }
    .compose-footer b { color: #4ade80; }

        .view-match { display: flex; flex-direction: column; min-height: 0; }
    .match-status { padding: 8px 10px; border-bottom: 1px solid #2c2c33; font-size: 12px;
      color: #a1a1aa; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .match-status b { color: #f4f4f5; }
    .match-status .sep { color: #52525b; }
    .match-status .ok { color: #4ade80; }
    .match-status .warning { color: #fbbf24; }
    .match-status .error { color: #f87171; }
    .match-status .dim { color: #71717a; }
    .match-controls { padding: 6px 10px; border-bottom: 1px solid #2c2c33;
      display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .match-controls .match-label { color: #71717a; }
    .match-options { padding: 6px 10px; border-bottom: 1px solid #2c2c33; font-size: 12px; }
    .match-options .setting-row { margin: 4px 0; }
    .match-options label { display: flex; align-items: center; gap: 4px; cursor: pointer; color: #a1a1aa; }
    .match-detail { padding: 8px 10px; font-size: 11px; color: #a1a1aa; }
    .match-detail code { color: #f4f4f5; font-family: ui-monospace, monospace;
      background: #0f0f12; padding: 1px 4px; border-radius: 3px; }
          .match-detail .match-code { color: #4ade80; font-family: ui-monospace, monospace;
      background: #0f0f12; padding: 2px 6px; border-radius: 3px; font-weight: 600; }
    .match-detail .match-copy, .match-detail .match-open { margin-left: 6px; }
  `;

    // ============================================================
    // 悬浮球
    // ============================================================
    function ensureBall() {
        let ball = document.getElementById('__rngs_ball');
        if (ball && ball.isConnected) return ball;
        ball = document.createElement('div');
        ball.id = '__rngs_ball';
        Object.assign(ball.style, {
            position: 'fixed', bottom: '20px', right: '20px',
            zIndex: '2147483646', width: '46px', height: '46px',
            borderRadius: '50%', background: '#16a34a', color: '#fff',
            display: 'none', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.35)',
            fontSize: '20px', userSelect: 'none', border: '2px solid #14532d',
        });
        ball.textContent = '⚡';
        ball.title = '打开 RNG Room Solver（Alt+R）';
        const dot = document.createElement('span');
        dot.id = '__rngs_ball_dot';
        Object.assign(dot.style, {
            position: 'absolute', top: '0', right: '0', width: '12px', height: '12px',
            borderRadius: '50%', background: '#ef4444', border: '2px solid #16a34a', display: 'none',
        });
        ball.appendChild(dot);
        ball.addEventListener('click', showHost);
        document.body.appendChild(ball);
        return ball;
    }

    function showBall() { const b = ensureBall(); b.style.display = 'flex'; updateBallDot(); }
    function hideBall() { const b = document.getElementById('__rngs_ball'); if (b) b.style.display = 'none'; }
    function updateBallDot() {
        const dot = document.getElementById('__rngs_ball_dot');
        if (dot) dot.style.display = hasNewResult ? 'block' : 'none';
    }

    // ============================================================
    // 悬浮窗
    // ============================================================
    function ensureHost() {
        if (host && host.isConnected) return;
        host = document.createElement('div');
        host.id = '__rngs_host';
        Object.assign(host.style, {
            position: 'fixed', top: '20px', right: '20px',
            zIndex: '2147483647', width: '480px', maxWidth: 'calc(100vw - 40px)',
        });
        shadow = host.attachShadow({ mode: 'open' });
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(CSS);
            shadow.adoptedStyleSheets = [sheet];
        } catch {
            const style = document.createElement('style');
            style.textContent = CSS;
            shadow.appendChild(style);
        }
        document.body.appendChild(host);
        buildPanel();
    }

    function showHost() {
        ensureHost();
        if (host) host.style.display = '';
        hideBall();
        visible = true;
        updatePanel();
    }

    function hideHost() {
        if (host) host.style.display = 'none';
        showBall();
        visible = false;
    }

    function setStatus(text, kind = 'info') {
        statusText = text; statusKind = kind;
        if (uiReady && activeTab === 'solver') updateStatusBar();
    }

    function buildPanel() {
        if (!shadow || panelBuilt) return;
        panelBuilt = true;
        shadow.innerHTML = `
      <div class="panel">
        <div class="head">
          <span class="brand">⚡ RNG Room Solver</span>
          <button type="button" class="btn-icon${settingsOpen ? ' active' : ''}" data-act="settings" title="设置">⚙</button>
          <button type="button" class="btn-icon" data-act="collapse" title="折叠">—</button>
          <button type="button" class="btn-icon" data-act="close" title="隐藏到悬浮球">×</button>
        </div>
        <div class="tabs">
          <button type="button" class="tab active" data-tab="solver">求解器</button>
          <button type="button" class="tab" data-tab="result">结果<span class="dot" hidden></span></button>
          <button type="button" class="tab" data-tab="match">匹配<span class="dot" hidden></span></button>
        </div>
        <div class="body">
          <div class="view view-solver">
            <div class="status"></div>
            <div class="controls">
              <label><input type="checkbox" class="cb-auto">自动执行</label>
              <button type="button" class="btn primary" data-act="run-best">执行最优</button>
              <span class="spacer"></span>
              <span class="dim count-label"></span>
            </div>
            <div class="settings"${settingsOpen ? '' : ' hidden'}>
              <div class="collect-hint" style="display:none">
                由已配置的 RNGdle AI 网站 Token 进行决策。<br>
                勾选顶部「自动执行」或点击「执行最优」按钮。
              </div>
              <div class="api-settings">
                <div class="setting-row">
                  <label class="api-label" for="rngs-ai-url">AI 网站</label>
                  <input id="rngs-ai-url" class="api-url-input" type="url" placeholder="https://你的 AI 网站">
                </div>
                <div class="setting-row">
                  <label class="api-label" for="rngs-ai-token">API Token</label>
                  <input id="rngs-ai-token" class="api-token-input" type="password" autocomplete="off" placeholder="rng_...">
                </div>
                <div class="setting-row">
                  <button type="button" class="btn tiny" data-act="save-api-settings">保存 API 设置</button>
                  <button type="button" class="btn tiny" data-act="test-api-settings">测试连接</button>
                </div>
                <div class="hint">AI 已知徽章和策略在网站的 Token 配置页管理；Token 只会发送到此处设置的网站地址。</div>
              </div>
              <div class="setting-row">
                <span class="setting-label">提交</span>
                <div class="seg" data-key="submitMode">
                  <button type="button" data-val="simulate">模拟</button>
                  <button type="button" data-val="api">API</button>
                </div>
              </div>
              <div class="hint">三款游戏的 AI 决策均通过网站 API；房间监听及游戏提交 API 保持不变。</div>
            </div>
            <div class="scroller"></div>
          </div>
          <div class="view view-result" hidden></div>
          <div class="view view-match" hidden>
            <div class="match-status"></div>
            <div class="match-controls">
              <button type="button" class="btn primary match-join">加入队列</button>
              <button type="button" class="btn match-cancel" hidden>取消匹配</button>
              <span class="spacer"></span>
              <span class="dim match-label"></span>
            </div>
            <div class="match-options">
              <div class="setting-row">
                <span class="setting-label">模式</span>
                <div class="seg" data-key="joinMode">
                  <button type="button" data-val="compose">compose</button>
                  <button type="button" data-val="collect">collect</button>
                  <button type="button" data-val="target">target</button>
                </div>
              </div>
              <div class="setting-row">
                <label><input type="checkbox" class="cb-auto-join">自动加入队列</label>
                <label><input type="checkbox" class="cb-auto-accept">自动接受</label>
              </div>
            </div>
            <div class="match-detail"></div>
          </div>
        </div>
      </div>`;

        const panel = shadow.querySelector('.panel');
        const head = shadow.querySelector('.head');
        const cbAuto = shadow.querySelector('.cb-auto');
        const runBtn = shadow.querySelector('[data-act="run-best"]');
        const settingsEl = shadow.querySelector('.settings');
        const scroller = shadow.querySelector('.scroller');

        // 匹配 tab
        const matchJoinBtn = shadow.querySelector('.match-join');
        const cbAutoJoin = shadow.querySelector('.cb-auto-join');
        const cbAutoAccept = shadow.querySelector('.cb-auto-accept');
        const matchCancelBtn = shadow.querySelector('.match-cancel');

        matchJoinBtn.addEventListener('click', () => { joinQueue(); });
        matchCancelBtn.addEventListener('click', () => { cancelMatchmaking(); });

        cbAutoJoin.addEventListener('change', () => {
            config.autoJoin = cbAutoJoin.checked;
            saveConfig();
            if (config.autoJoin) scheduleNextHeartbeat(0);
            else if (!shouldPollHeartbeat()) { clearTimeout(matchmakingTimer); matchmakingTimer = null; }
            updatePanel();
        });

        cbAutoAccept.addEventListener('change', () => {
            config.autoAccept = cbAutoAccept.checked;
            saveConfig();
            if (config.autoAccept) {
                scheduleNextHeartbeat(0);
                handleAutoMatchActions();
            } else if (!shouldPollHeartbeat()) { clearTimeout(matchmakingTimer); matchmakingTimer = null; }
            updatePanel();
        });

        shadow.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });

        shadow.querySelector('[data-act="collapse"]').addEventListener('click', e => {
            collapsed = !collapsed;
            panel.classList.toggle('collapsed', collapsed);
            e.currentTarget.textContent = collapsed ? '□' : '—';
        });

        shadow.querySelector('[data-act="close"]').addEventListener('click', hideHost);

        shadow.querySelector('[data-act="settings"]').addEventListener('click', e => {
            if (activeTab !== 'solver') switchTab('solver');
            settingsOpen = !settingsOpen;
            settingsEl.hidden = !settingsOpen;
            config.settingsOpen = settingsOpen;
            saveConfig();
            e.currentTarget.classList.toggle('active', settingsOpen);
        });

        let drag = null;
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const rect = host.getBoundingClientRect();
            Object.assign(host.style, {
                right: 'auto', bottom: 'auto',
                left: rect.left + 'px', top: rect.top + 'px',
            });
            drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
            head.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        head.addEventListener('pointermove', e => {
            if (!drag || !head.hasPointerCapture(e.pointerId)) return;
            host.style.left = Math.max(0, drag.left + e.clientX - drag.x) + 'px';
            host.style.top = Math.max(0, drag.top + e.clientY - drag.y) + 'px';
        });
        head.addEventListener('pointerup', e => {
            drag = null;
            try { head.releasePointerCapture(e.pointerId); } catch {}
        });

        cbAuto.addEventListener('change', () => {
            config.autoMode = cbAuto.checked;
            saveConfig();
            if (config.autoMode) {
                if (room?.mode === 'collect') maybeAutoExecuteCollect();
                else if (room?.mode === 'compose') maybeAutoSubmitCompose();
                else maybeAutoExecute();
            } else { clearTimeout(autoTimer); autoTimer = null; }
            updateControls();
        });

        runBtn.addEventListener('click', () => {
            if (room?.mode === 'collect') {
                if (collectDecision && collectDecision.action !== 'skip' && !collectDecisionBusy) {
                    executeCollect(collectDecision);
                }
                return;
            }
            if (room?.mode === 'compose') {
                submitCompose(true);   // 手动点击允许重发
                return;
            }
            if (candidates.length) executeRow(candidates[0]);
        });

        shadow.querySelectorAll('.seg').forEach(seg => {
            seg.addEventListener('click', e => {
                const btn = e.target.closest('button[data-val]');
                if (!btn) return;
                const key = seg.dataset.key;
                const val = btn.dataset.val;
                config[key] = val;
                saveConfig();
                renderSettings();
                updateTable();
                updateControls();
                if (key === 'joinMode' && config.autoJoin && matchmaking?.status === 'idle') {
                    autoJoinCooldown = 0;
                    handleAutoMatchActions();
                }
            });
        });

        shadow.querySelector('[data-act="save-api-settings"]').addEventListener('click', () => {
            try { saveAiSettings(); }
            catch (error) { setStatus('API 设置无效: ' + error.message, 'error'); updatePanel(); }
        });
        shadow.querySelector('[data-act="test-api-settings"]').addEventListener('click', testAiConnection);
        // 匹配 tab 里的复制 / 打开按钮
        const matchDetailEl = shadow.querySelector('.match-detail');
        if (matchDetailEl) {
            matchDetailEl.addEventListener('click', async e => {
                const copyBtn = e.target.closest('.match-copy');
                if (copyBtn) {
                    const code = copyBtn.dataset.code;
                    if (!code) return;
                    try {
                        await navigator.clipboard.writeText(code);
                        copyBtn.textContent = '已复制';
                        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
                    } catch {
                        copyBtn.textContent = '复制失败';
                        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
                    }
                    return;
                }
                const openBtn = e.target.closest('.match-open');
                if (openBtn) {
                    const code = openBtn.dataset.code;
                    if (!code) return;
                    // 尝试几种 hash 路由；页面不接受时用户仍可用复制
                    const candidates = [`#room/${code}`, `#match/${code}`, `#arena/${code}`];
                    const before = location.hash;
                    for (const h of candidates) {
                        location.hash = h;
                        // 立即检查（有些路由会同步改 hash 再异步改），给一点时间
                        if (location.hash !== before) break;
                    }
                    if (location.hash === before) {
                        setStatus('页面未识别房间路由，请用复制', 'error');
                    }
                    return;
                }
            });
        }
        scroller.addEventListener('click', e => {
            const retryBtn = e.target.closest('[data-act="retry-target"]');
            if (retryBtn && candidatesKey) {
                requestTargetDecision(candidatesKey);
                return;
            }
            const removeBtn = e.target.closest('[data-remove-idx]');
            if (removeBtn && !removeBtn.disabled) {
                const idx = Number(removeBtn.dataset.removeIdx);
                if (!isNaN(idx)) removeSaved(idx);
                return;
            }
            const btn = e.target.closest('[data-candidate-num]');
            if (!btn || btn.disabled) return;
            const num = Number(btn.dataset.candidateNum);
            const row = candidates.find(c => c.number === num);
            if (row) executeRow(row);
        });

        applyConfigToUI();
    }

    function applyConfigToUI() {
        if (!shadow) return;
        const apiUrlInput = shadow.querySelector('.api-url-input');
        const apiTokenInput = shadow.querySelector('.api-token-input');
        if (apiUrlInput) apiUrlInput.value = config.aiApiUrl || '';
        if (apiTokenInput) apiTokenInput.value = config.aiApiToken || '';
        const settingsEl = shadow.querySelector('.settings');
        if (settingsEl) settingsEl.hidden = !settingsOpen;
        const settingsBtn = shadow.querySelector('[data-act="settings"]');
        if (settingsBtn) settingsBtn.classList.toggle('active', settingsOpen);
        renderSettings();
    }

    function switchTab(tab) {
        if (tab !== 'solver' && tab !== 'result' && tab !== 'match') return;
        activeTab = tab;
        if (tab === 'result') hasNewResult = false;
        if (shadow) {
            shadow.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
            shadow.querySelector('.view-solver').hidden = tab !== 'solver';
            shadow.querySelector('.view-result').hidden = tab !== 'result';
            const mv = shadow.querySelector('.view-match');
            if (mv) mv.hidden = tab !== 'match';
        }
        updateTabDot(); updateBallDot(); updatePanel();
        if (tab === 'match') scheduleNextHeartbeat(0);
    }

    function updateTabDot() {
        const dot = shadow?.querySelector('.tab[data-tab="result"] .dot');
        if (dot) dot.hidden = !hasNewResult;
    }

    function renderSettings() {
        if (!shadow) return;
        const settingsEl = shadow.querySelector('.settings');
        const isCollect = room?.mode === 'collect';
        const isCompose = room?.mode === 'compose';
        settingsEl.classList.toggle('collect-mode', isCollect || isCompose);
        const hint = shadow.querySelector('.collect-hint');
        if (hint) {
            if (isCompose) {
                hint.innerHTML = '组合模式：网站 AI 计算最优解并 draft 提交。勾选「自动执行」自动提交。';
            } else if (isCollect) {
                hint.innerHTML = '收集模式：由网站 AI 根据当前 Token 配置决定收下或跳过。';
            }
        }

        shadow.querySelectorAll('.seg').forEach(seg => {
            const key = seg.dataset.key;
            seg.querySelectorAll('button').forEach(btn => {
                const val = btn.dataset.val;
                btn.classList.toggle('active', val === config[key]);
            });
        });
    }

    function updatePanel() {
        if (!uiReady) return;
        if (!host) { if (room) showHost(); return; }
        updateTabDot(); updateBallDot();
        if (activeTab === 'solver') {
            updateStatusBar(); updateControls(); updateTable(); renderSettings();
        } else if (activeTab === 'match') {
            updateMatchView();
        } else {
            renderResultView();
        }
    }
    function matchViewKey() {
        return [
            matchmaking?.status ?? '',
            matchmaking?.mode ?? '',
            matchmaking?.matchId ?? '',
            matchmaking?.accepted ? '1' : '0',
            matchmaking?.code ?? '',
            matchmakingPending ? '1' : '0',
            inActiveMatch() ? '1' : '0',
            config.autoJoin ? '1' : '0',
            config.autoAccept ? '1' : '0',
            config.joinMode,
            matchmaking ? '1' : '0',
        ].join('|');
    }

    function updateMatchView() {
        if (!shadow) return;
        const statusEl = shadow.querySelector('.match-status');
        if (!statusEl) return;

        const cbAutoJoin = shadow.querySelector('.cb-auto-join');
        const cbAutoAccept = shadow.querySelector('.cb-auto-accept');
        if (cbAutoJoin) cbAutoJoin.checked = config.autoJoin;
        if (cbAutoAccept) cbAutoAccept.checked = config.autoAccept;
        shadow.querySelectorAll('.seg[data-key="joinMode"] button').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.val === config.joinMode);
        });

        const key = matchViewKey();
        if (key !== renderedMatchKey) {
            renderedMatchKey = key;
            renderMatchViewFull();
        }
        updateMatchCountdown();
    }

    function renderMatchViewFull() {
        const statusEl = shadow.querySelector('.match-status');
        const detailEl = shadow.querySelector('.match-detail');
        const labelEl = shadow.querySelector('.match-label');
        const joinBtn = shadow.querySelector('.match-join');
        const cancelBtn = shadow.querySelector('.match-cancel');
        if (!statusEl) return;

        if (cancelBtn) { cancelBtn.hidden = true; cancelBtn.disabled = matchmakingPending; }

        if (!matchmaking) {
            statusEl.innerHTML = '<span class="dim">等待 heartbeat…</span>';
            detailEl.innerHTML = '';
            labelEl.textContent = '';
            joinBtn.disabled = !!inActiveMatch();
            joinBtn.textContent = '加入队列';
            // 队列概况
            const qc = stateInfo.queueCounts;
            const myRating = stateInfo.ratings?.find(r => r.mode === config.joinMode)?.rating;
            if (qc || myRating != null) {
                const myQ = qc?.[config.joinMode];
                const parts = [];
                if (myQ) parts.push(`队列 ${myQ.queued ?? 0} 人 · 确认中 ${myQ.confirming ?? 0}`);
                if (myRating != null) parts.push(`rating ${myRating}`);
                if (parts.length) {
                    detailEl.innerHTML = `<span class="dim">${escapeHtml(parts.join(' · '))}</span>`;
                }
            }
            return;
        }

        const st = matchmaking.status;
        const active = inActiveMatch();

        if (st === 'matched') {
            const mode = matchmaking.mode || '?';
            const code = matchmaking.code || '';
            statusEl.innerHTML = `<span class="ok">✓ 已匹配</span><span class="sep">·</span>模式 <b>${escapeHtml(mode)}</b>`;
            labelEl.textContent = '已停止心跳';
            if (code) {
                detailEl.innerHTML = `<span>房间 <code class="match-code">${escapeHtml(code)}</code></span>
          <button type="button" class="btn tiny match-copy" data-code="${escapeHtml(code)}">复制</button>
          <button type="button" class="btn tiny match-open" data-code="${escapeHtml(code)}">打开</button>`;
            } else {
                detailEl.innerHTML = '<span class="dim">等待房间信息…</span>';
            }
            joinBtn.disabled = true;
            joinBtn.textContent = '已匹配';
            return;
        }

        if (active) {
            statusEl.innerHTML = '<span class="warning">已在比赛中</span>';
            detailEl.innerHTML = '';
            labelEl.textContent = '';
            joinBtn.disabled = true;
            joinBtn.textContent = '比赛中';
            return;
        }

        if (st === 'idle') {
            statusEl.innerHTML = '<span class="dim">空闲</span>';
            detailEl.innerHTML = '';
            labelEl.textContent = '';
            joinBtn.disabled = matchmakingPending;
            joinBtn.textContent = '加入队列';
        } else if (st === 'queued') {
            const mode = matchmaking.mode || '?';
            const rating = matchmaking.rating || '?';
            const range = matchmaking.ratingRange || '?';
            statusEl.innerHTML = `<span class="ok">排队中</span><span class="sep">·</span>模式 <b>${escapeHtml(mode)}</b>`;
            labelEl.textContent = `rating ${rating} · ±${range}`;
            detailEl.innerHTML = '<span class="dim match-countdown"></span>';
            joinBtn.disabled = true;
            joinBtn.textContent = '已在队列';
            if (cancelBtn) cancelBtn.hidden = false;
        } else if (st === 'confirming') {
            const mode = matchmaking.mode || '?';
            statusEl.innerHTML = `<span class="warning">待确认</span><span class="sep">·</span>模式 <b>${escapeHtml(mode)}</b>`;
            labelEl.textContent = '';
            detailEl.innerHTML = '<span class="dim match-countdown"></span>';
            joinBtn.disabled = true;
            joinBtn.textContent = '待确认';
            if (cancelBtn) cancelBtn.hidden = false;
        } else {
            statusEl.innerHTML = `<span class="dim">${escapeHtml(String(st))}</span>`;
            labelEl.textContent = '';
            detailEl.innerHTML = '';
            joinBtn.disabled = true;
            joinBtn.textContent = '无法操作';
        }
    }

    function updateMatchCountdown() {
        const el = shadow?.querySelector('.match-countdown');
        if (!el || !matchmaking) return;
        if (matchmaking.status === 'queued') {
            const sinceJoin = matchmaking.joinedAt
            ? Math.max(0, (serverNow() - matchmaking.joinedAt) / 1000)
            : Math.max(0, (matchmaking.waitMs || 0) / 1000);
            const expiresIn = Math.max(0, ((matchmaking.expiresAt || 0) - serverNow()) / 1000);
            el.textContent = `已等待 ${sinceJoin.toFixed(1)}s · 会话剩余 ${expiresIn.toFixed(0)}s`;
        } else if (matchmaking.status === 'confirming') {
            const remain = Math.max(0, ((matchmaking.deadline || 0) - serverNow()) / 1000);
            const shortId = (matchmaking.matchId || '').slice(0, 10);
            const accepted = !!matchmaking.accepted;
            el.innerHTML = `matchId <code>${escapeHtml(shortId)}</code> · 剩余 ${remain.toFixed(1)}s${accepted ? ' · 已接受' : ''}`;
        }
    }
    function updateStatusBar() {
        const el = shadow?.querySelector('.view-solver .status');
        if (!el) return;
        const parts = [];

        if (!room) {
            parts.push(currentCode ? `房间 <b>${escapeHtml(currentCode)}</b> · 等待数据…` : '等待页面请求房间 API…');
        } else if (room.mode === 'collect') {
            const cfg = room.config || {};
            const total = cfg.count ?? 30;
            const slots = cfg.slots ?? 5;
            const cur = (room.index ?? 0) + 1;
            parts.push(`Collect <b>${cur}</b>/${total}`);
            const rem = remainingMs();
            const cls = rem < 10000 ? 'low' : rem < 30000 ? 'med' : '';
            parts.push(`<span class="sep">·</span><span class="countdown ${cls}">剩余 ${(rem / 1000).toFixed(1)}s</span>`);
            parts.push(`<span class="sep">·</span>已保存 <b>${collectSaved.length}</b>/${slots}`);
            if (room.nextAt) {
                const toNext = Math.max(0, room.nextAt - serverNow());
                parts.push(`<span class="sep">·</span>下一个 ${(toNext / 1000).toFixed(1)}s`);
            }
        } else if (room.mode === 'compose') {
            const cfg = room.config || {};
            const rounds = cfg.rounds ?? (room.rounds?.length || 0);
            const solvedCount = composeState?.rounds.filter(r => r.best).length ?? 0;
            parts.push(`Compose <b>${solvedCount}</b>/${rounds}`);
            const rem = remainingMs();
            const cls = rem < 10000 ? 'low' : rem < 30000 ? 'med' : '';
            parts.push(`<span class="sep">·</span><span class="countdown ${cls}">剩余 ${(rem / 1000).toFixed(1)}s</span>`);
            const totalScore = composeState?.rounds.reduce((s, r) => s + (r.best?.ep ?? 0), 0) ?? 0;
            parts.push(`<span class="sep">·</span>总分 <b>${totalScore}</b>`);
            if (room.submitted) parts.push(`<span class="sep">·</span><span class="ok">已提交</span>`);
        } else {
            if (room.phase !== 'playing') parts.push(`<b>${escapeHtml(room.phase)}</b>`);
            else {
                parts.push(`Round <b>${(room.round | 0) + 1}</b>/${room.config?.rounds ?? '?'}`);
                const rem = remainingMs();
                const cls = rem < 3000 ? 'low' : rem < 7000 ? 'med' : '';
                parts.push(`<span class="sep">·</span><span class="countdown ${cls}">剩余 ${(rem / 1000).toFixed(1)}s</span>`);
            }
            if (room.number != null && room.target != null) {
                parts.push(`<span class="sep">·</span>起始 <b>${room.number}</b>`);
                parts.push(`<span class="sep">·</span>目标 <b>${fmt(room.target)}</b> EP`);
            }
            if (room.submitted) parts.push(`<span class="sep">·</span><span class="ok">已提交</span>`);
            if (!room.training) parts.push(`<span class="sep">·</span><span class="warning">非训练</span>`);
        }

        if (statusText) {
            const cls = statusKind === 'error' ? 'error' : statusKind === 'ok' ? 'ok' : '';
            parts.push(`<span class="${cls}">${escapeHtml(statusText)}</span>`);
        }
        el.innerHTML = parts.join('');
    }

    function updateControls() {
        const cbAuto = shadow?.querySelector('.cb-auto');
        const runBtn = shadow?.querySelector('[data-act="run-best"]');
        const countLabel = shadow?.querySelector('.count-label');
        if (!cbAuto) return;

        cbAuto.checked = config.autoMode;

        if (room?.mode === 'collect') {
            const busy = collectDecisionBusy;
            const d = collectDecision;
            const canAct = !busy && !!d && d.action !== 'skip' && canExecute() && !executing;
            runBtn.disabled = !canAct;
            runBtn.textContent = busy ? 'AI 思考中…'
            : d?.action === 'save' ? '保存当前'
            : d?.action === 'skip' ? 'AI 建议跳过'
            : '等待 AI 决策';
            countLabel.textContent = collectCurrent
                ? `当前 ${collectCurrent.number} · EP ${collectCurrent.ep}`
            : '';
            return;
        }
        if (room?.mode === 'compose') {
            const allSolved = composeState?.rounds.every(r => r.best) ?? false;
            const submitted = !!room.submitted;
            const canAct = allSolved && !submitted && !composeDrafting && canExecute();
            runBtn.disabled = !canAct;
            runBtn.textContent = composeDrafting ? 'draft 中…'
            : submitted ? '已提交'
            : '提交全部';
            const totalScore = composeState?.rounds.reduce((s, r) => s + (r.best?.ep ?? 0), 0) ?? 0;
            countLabel.textContent = allSolved ? `总分 ${totalScore}` : composeSolveBusy ? '网站 AI 计算中…' : '';
            return;
        }
        const canRun = canExecute() && !executing && candidates.length > 0;
        runBtn.disabled = !canRun;
        runBtn.textContent = config.submitMode === 'api' ? 'API 提交 AI 推荐' : '填入 AI 推荐';
        countLabel.textContent = targetDecisionBusy
            ? '网站 AI 决策中…'
            : candidates.length ? `AI 分数 ${candidates[0].ep} · 距目标 ${candidates[0].delta}` : '';
    }

    function updateTable() {
        const scroller = shadow?.querySelector('.scroller');
        if (!scroller) return;

        if (room?.mode === 'collect') {
            const key = `c:${room.index}:${collectSaved.length}:${room.number}:${collectDecisionKey}:${collectDecisionBusy ? 'b' : 'i'}`;
            if (renderedCandidatesKey === key) {
                scroller.querySelectorAll('[data-remove-idx]').forEach(btn => {
                    btn.disabled = executing;
                });
                return;
            }
            renderedCandidatesKey = key;
            const prevScroll = scroller.scrollTop;
            scroller.replaceChildren(buildCollectTable());
            scroller.scrollTop = prevScroll;
            return;
        }
        if (room?.mode === 'compose') {
            const bestKey = composeState?.rounds.map(r => r.best?.number ?? 0).join(',') ?? '';
            const key = `comp:${room.answerRevision}:${bestKey}:${room.submitted ? 's' : 'p'}`;
            if (renderedCandidatesKey === key) return;
            renderedCandidatesKey = key;
            const prevScroll = scroller.scrollTop;
            scroller.replaceChildren(buildComposeView());
            scroller.scrollTop = prevScroll;
            return;
        }
        const key = `${candidatesKey}:${targetDecisionBusy ? 'busy' : 'ready'}:${candidates.length}`;
        const needRebuild = renderedCandidatesKey !== key;
        if (!needRebuild) {
            scroller.querySelectorAll('[data-candidate-num]').forEach(btn => {
                btn.disabled = executing || !canExecute();
            });
            return;
        }
        renderedCandidatesKey = key;
        const prevScroll = scroller.scrollTop;
        scroller.replaceChildren(buildTable());
        scroller.scrollTop = prevScroll;
    }

    function buildTable() {
        if (!candidates.length) {
            const div = document.createElement('div');
            div.className = 'empty';
            if (!room) div.textContent = currentCode ? '等待房间数据…' : '等待页面请求房间 API…';
            else if (room.phase !== 'playing') div.textContent = `阶段 ${room.phase}`;
            else if (room.submitted) div.textContent = '已提交，等待下一轮';
            else if (targetDecisionBusy) div.textContent = '正在请求网站 AI 决策…';
            else if (targetDecisionError) {
                div.textContent = statusText || '网站 AI 决策失败';
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'btn tiny';
                retry.dataset.act = 'retry-target';
                retry.textContent = '重试';
                div.appendChild(document.createElement('br'));
                div.appendChild(retry);
            } else div.textContent = '暂无 AI 推荐';
            return div;
        }
        const wrap = document.createElement('div');
        const tbl = document.createElement('table');
        tbl.innerHTML = `
      <thead><tr>
        <th>#</th><th>数字</th><th>AI 分数</th><th>距离</th>
        <th class="left">改动</th><th></th>
      </tr></thead><tbody></tbody>`;
        const tbody = tbl.querySelector('tbody');
        const canRun = canExecute() && !executing;
        const list = getDisplayList();
        const top = list;
        const bestNum = candidates[0]?.number;
        top.forEach((r, i) => {
            const tr = document.createElement('tr');
            if (r.delta < 0.005) tr.className = 'exact';
            else if (r.number === bestNum) tr.className = 'best';
            tr.innerHTML = `
        <td class="dim">${i + 1}</td>
        <td class="num">${r.number}</td>
        <td>${r.ep}</td>
        <td class="delta">${r.delta.toFixed(2)}</td>
        <td class="left chg">位置 ${r.pos + 1}: ${r.from} → ${r.to}</td>
        <td><button type="button" class="btn tiny" data-candidate-num="${r.number}" ${canRun ? '' : 'disabled'}>执行</button></td>`;
            tbody.appendChild(tr);
        });
        wrap.appendChild(tbl);
        return wrap;
    }

    function buildCollectTable() {
        const wrap = document.createElement('div');
        if (!collectCurrent && collectSaved.length === 0) {
            const div = document.createElement('div');
            div.className = 'empty';
            div.textContent = '等待收集数字…';
            return div;
        }

        const slots = room.config?.slots ?? 5;
        const total = room.config?.count ?? 30;

        if (collectCurrent) {
            const busy = collectDecisionBusy;
            const d = collectDecision;
            const curDiv = document.createElement('div');
            curDiv.className = 'collect-current';

            const badgeCls = busy ? 'busy'
            : d?.action === 'save' ? 'save'
            : 'skip';
            const badgeText = busy ? '… AI 思考'
            : d?.action === 'save' ? '✓ 可保存'
            : '— 跳过';

            curDiv.innerHTML = `
        <div class="label">当前 #${collectCurrent.index + 1} / ${total}</div>
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
          <span class="big">${collectCurrent.number}</span>
          <span class="ep">分数 <b>${collectCurrent.ep ?? '—'}</b></span>
          <span class="badge ${badgeCls}">${badgeText}</span>
        </div>`;
            wrap.appendChild(curDiv);

            const note = d?.note || d?.reason || '';
            if (note) {
                const noteDiv = document.createElement('div');
                noteDiv.className = 'collect-note' + (d?.error ? ' error' : '');
                noteDiv.textContent = d?.error ? `${note} · ${d.error}` : note;
                wrap.appendChild(noteDiv);
            }
        }

        if (collectSaved.length === 0) {
            const div = document.createElement('div');
            div.className = 'empty';
            div.textContent = '尚未保存任何数字';
            wrap.appendChild(div);
        } else {
            const tbl = document.createElement('table');
            tbl.innerHTML = `<thead><tr><th>#</th><th>数字</th><th>AI 分数</th><th></th></tr></thead><tbody></tbody>`;
            const tbody = tbl.querySelector('tbody');
            const sorted = collectSaved.slice().sort((a, b) => a.index - b.index);
            sorted.forEach((s, i) => {
                const tr = document.createElement('tr');
                if (i === 0) tr.className = 'best';
                tr.innerHTML = `
          <td class="dim">${i + 1}</td>
          <td class="num">${s.number}</td>
          <td>${s.ep ?? '—'}</td>
          <td><button type="button" class="btn tiny" data-remove-idx="${s.index}" ${executing ? 'disabled' : ''}>移除</button></td>`;
                tbody.appendChild(tr);
            });
            wrap.appendChild(tbl);
            const hint = document.createElement('div');
            hint.className = 'empty';
            hint.style.padding = '4px 8px';
            hint.style.borderTop = '1px solid #26262b';
            hint.textContent = `已保存 ${collectSaved.length}/${slots}`;
            wrap.appendChild(hint);
        }
        return wrap;
    }
    function buildComposeView() {
        const wrap = document.createElement('div');
        if (!composeState) {
            const div = document.createElement('div');
            div.className = 'empty';
            div.textContent = composeSolveBusy ? '网站 AI 计算中…' : '等待 compose 数据…';
            return div;
        }

        const KEY_POS = new Set([1, 4]);

        composeState.rounds.forEach((r, ri) => {
            const section = document.createElement('div');
            section.className = 'compose-round';

            const header = document.createElement('div');
            header.className = 'compose-header';
            header.innerHTML = `<span class="compose-idx">#${ri + 1}</span>
        <span class="compose-key-list">key: ${r.key.join(' ')}</span>
        <span class="compose-open-list">open: ${r.open.join(' ')}</span>`;
            section.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'compose-grid';
            const arrangement = r.best?.arrangement || Array(6).fill(null);

            for (let i = 0; i < 6; i++) {
                const cell = document.createElement('div');
                cell.className = 'compose-cell' + (KEY_POS.has(i) ? ' key-pos' : '');
                const tag = arrangement[i];
                if (tag) {
                    const isKey = tag.startsWith('k');
                    const idx = parseInt(tag.slice(1), 10);
                    const digit = isKey ? r.key[idx] : r.open[idx];
                    cell.innerHTML = `<span class="compose-digit">${digit}</span><span class="compose-tag">${tag}</span>`;
                } else {
                    cell.innerHTML = `<span class="compose-digit empty">?</span>`;
                }
                grid.appendChild(cell);
            }
            section.appendChild(grid);

            const info = document.createElement('div');
            info.className = 'compose-info';
            if (r.best) {
                info.innerHTML = `<span>数字 <b>${r.best.digits || String(r.best.number).padStart(6, '0')}</b></span>
          <span>AI 分数 <b>${r.best.ep}</b></span>`;
            } else {
                info.textContent = composeSolveBusy ? '网站 AI 决策中…' : '等待 AI 决策';
            }
            section.appendChild(info);

            wrap.appendChild(section);
        });

        const total = composeState.rounds.reduce((s, r) => s + (r.best?.ep ?? 0), 0);
        const footer = document.createElement('div');
        footer.className = 'compose-footer';
        footer.innerHTML = `<span>总分 <b>${total}</b></span>
      ${room.submitted ? '<span class="ok">已提交</span>' : ''}`;
        wrap.appendChild(footer);

        return wrap;
    }
    // ============================================================
    // 结果视图
    // ============================================================
    function renderResultView() {
        const view = shadow?.querySelector('.view-result');
        if (!view) return;
        if (!latestResult || room?.mode === 'collect' || room?.mode === 'compose') {
            view.innerHTML = '<div class="empty">' +
                (room?.mode === 'collect' ? '收集模式无回合结果。'
                 : room?.mode === 'compose' ? '组合模式无回合结果。'
                 : '暂无结果。完成一次提交后，结果会显示在这里。') +
                '</div>';
            renderedResultRound = null;
            return;
        }
        if (renderedResultRound === latestResult.roundNo) return;
        renderedResultRound = latestResult.roundNo;
        const { data } = latestResult;
        view.innerHTML = `
      <div class="result-section">${buildResultSummary(data)}</div>
      <div class="result-section">${buildResultRankings(data)}</div>
      <div class="result-section">${buildResultBaseline(data)}</div>
      <div class="result-section">${buildResultBadges(data)}</div>`;
    }

    function buildResultSummary(result) {
        const dist = result.distances || [];
        const pct = (result.difference || 0) * 100;
        return `<div class="summary-row">
      <span>距离 <b>${dist.map(d => Number(d).toFixed(2)).join(' / ')}</b></span>
      <span>差异 <b>${pct.toFixed(1)}%</b></span>
    </div>`;
    }

    function buildResultRankings(result) {
        const edits = result.editRankings || [];
        if (!edits.length) return '<div class="empty">无编辑排名数据</div>';
        const baselineStr = String(result.baseline?.number ?? '');
        const myRank = result.scoring?.ranks?.[room.you];
        const oppRank = result.scoring?.ranks?.[1 - room.you];
        const rows = edits.map(e => {
            const fromChar = baselineStr[e.position] ?? '?';
            const cls = [
                e.rank === 1 ? 'rank1' : '',
                e.rank === myRank ? 'mine' : '',
                e.rank === oppRank ? 'opp' : '',
            ].filter(Boolean).join(' ');
            return `<tr class="${cls}">
        <td class="rank-num">${e.rank}</td>
        <td class="num">${e.number}</td>
        <td>${Number(e.ep).toFixed(2)}</td>
        <td>${Number(e.distance).toFixed(2)}</td>
        <td class="left chg">${e.position + 1}: ${fromChar}→${e.digit}</td>
      </tr>`;
        }).join('');
        return `<div class="section-title">编辑排名（${edits.length} 个候选）</div>
      <table class="rankings-table">
        <thead><tr>
          <th>#</th><th>数字</th><th>EP</th><th>距离</th><th class="left">改动</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    function buildResultBaseline(result) {
        const b = result.baseline;
        if (!b) return '';
        const r = b.ranking || {};
        return `<div class="section-title">基线</div>
      <div class="baseline-info">
        <span><b>${b.number}</b></span>
        <span>EP <b>${Number(b.ep).toFixed(2)}</b></span>
        <span>排名 <b>${r.rank ?? '?'}</b>/${r.total ?? '?'}</span>
        <span><b>${Number(r.percentile ?? 0).toFixed(1)}%</b></span>
        <span>${r.tier?.label || ''}</span>
      </div>`;
    }

    function buildResultBadges(result) {
        const changes = result.badgeChanges || [];
        if (!changes.length) return '';
        const players = room.players || [];
        const blocks = changes.map((c, i) => {
            const name = players[i]?.name || `玩家 ${i + 1}`;
            const isYou = i === room.you;
            const isOpp = i === 1 - room.you;
            const added = c.added || [];
            const removed = c.removed || [];
            const rowsHtml = [
                ...added.map(b => `<div class="row-added"><span class="badge-name">${b.icon || ''} ${b.name}</span> <span class="badge-ep">+${Number(b.ep).toFixed(2)}</span></div>`),
                ...removed.map(b => `<div class="row-removed"><span class="badge-name">${b.icon || ''} ${b.name}</span> <span class="badge-ep">−${Number(b.ep).toFixed(2)}</span></div>`),
            ].join('');
            return `<div>
        <div class="player-row">
          <span class="tag ${isYou ? 'you' : isOpp ? 'opp' : ''}">${isYou ? '你' : isOpp ? '对手' : ''}</span>
          <b>${escapeHtml(name)}</b>
          <span class="delta">
            <span class="add">+${added.length}</span>
            <span class="rem">−${removed.length}</span>
          </span>
        </div>
        ${rowsHtml ? `<div class="badge-detail">${rowsHtml}</div>` : ''}
      </div>`;
        }).join('');
        return `<div class="section-title">徽章变化</div>
      <div class="badge-change-block">${blocks}</div>`;
    }

    function tick() {
        if (activeTab === 'solver') {
            const cd = shadow?.querySelector('.countdown');
            if (cd && room) {

                if (room.mode === 'collect' || room.mode === 'compose') {
                    const rem = remainingMs();
                    cd.textContent = `剩余 ${(rem / 1000).toFixed(1)}s`;
                    cd.classList.remove('low', 'med');
                    if (rem < 10000) cd.classList.add('low');
                    else if (rem < 30000) cd.classList.add('med');
                }else if (room.phase === 'playing') {
                    const rem = remainingMs();
                    cd.textContent = `剩余 ${(rem / 1000).toFixed(1)}s`;
                    cd.classList.remove('low', 'med');
                    if (rem < 3000) cd.classList.add('low');
                    else if (rem < 7000) cd.classList.add('med');
                }
            }
        }
        if (activeTab === 'match') {
            updateMatchView();
        }
        rafId = requestAnimationFrame(tick);
    }

    // ============================================================
    // 初始化
    // ============================================================
    function init() {
        if (uiReady) return;
        uiReady = true;
        ensureHost();
        hideHost();
        document.addEventListener('keydown', e => {
            if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                if (visible) hideHost(); else showHost();
            }
        });
        if (pendingPayload) {
            const [code, data] = pendingPayload;
            pendingPayload = null;
            onRoomPayload(code, data);
        }
        if (shouldPollHeartbeat()) scheduleNextHeartbeat(500);
        rafId = requestAnimationFrame(tick);
    }

    installInterceptors();
    if (document.body) init();
    else {
        const mo = new MutationObserver(() => {
            if (document.body) { mo.disconnect(); init(); }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', () => {
            mo.disconnect();
            if (!uiReady) init();
        }, { once: true });
    }
})();