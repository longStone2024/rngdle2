/* global Vue, ELEMENT */
(function () {
  "use strict";

  const tokenStorageKey = "rngdle-ai-session";
  const validTabs = ["play", "config", "tokens", "profile", "docs"];
  const validGames = ["composition", "collection", "target"];
  const gameLabels = {
    composition: "Digit Composition",
    collection: "Time Collection",
    target: "Target Chase",
  };
  const initialUrlState = readUrlState();

  function readUrlState() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const game = params.get("game");
    return {
      activeTab: validTabs.includes(tab) ? tab : "play",
      configGame: validGames.includes(game) ? game : "composition",
    };
  }

  Vue.component("el-navbar", {
    props: {
      value: { type: String, required: true },
      user: { type: Object, required: true },
    },
    template: `
      <div class="navbar-content">
        <el-menu :default-active="value" mode="horizontal" @select="$emit('input', $event)">
          <el-menu-item index="play"><i class="el-icon-video-play"></i>在线体验</el-menu-item>
          <el-menu-item index="config"><i class="el-icon-setting"></i>AI 配置</el-menu-item>
          <el-menu-item index="tokens"><i class="el-icon-key"></i>API Token</el-menu-item>
          <el-menu-item index="profile"><i class="el-icon-s-data"></i>个人主页</el-menu-item>
          <el-menu-item index="docs"><i class="el-icon-document"></i>API 文档</el-menu-item>
        </el-menu>
        <div class="navbar-user">
          <span><i class="el-icon-user"></i> {{ user.username }}</span>
          <el-button type="text" @click="$emit('logout')">退出</el-button>
        </div>
      </div>
    `,
  });

  Vue.component("api-documentation", {
    props: {
      authenticated: { type: Boolean, default: false },
    },
    template: "#api-documentation-template",
  });

  new Vue({
    el: "#app",
    data: {
      token: localStorage.getItem(tokenStorageKey) || "",
      user: null,
      apiTokens: [],
      personalStats: {
        tokenCount: 0,
        total: { apiCalls: 0, decisions: 0, games: 0, frequency: { hour: 0, day: 0, month: 0, year: 0 } },
        games: {},
      },
      statsUpdatedAt: "",
      tokenLabelDrafts: {},
      tokenGameDrafts: {},
      features: [],
      config: { games: {} },
      authMode: "login",
      authForm: { username: "", password: "" },
      activeTab: initialUrlState.activeTab,
      configGame: initialUrlState.configGame,
      selectedTokenId: "",
      tokenAllowedGames: [...validGames],
      busy: false,
      savedAt: "",
      tokenLabel: "",
      newToken: "",
      newTokenMessage: "",
      featureSearch: "",
      expandedCategories: [],
      selectedFeature: null,
      featureDialogVisible: false,
      compositionKey: "1, 4, 8",
      compositionOpen: "0, 2, 3, 5, 9",
      collection: { current: 746281, remainingTurns: 30, slotsRemaining: 5, selected: [] },
      target: { number: 314159, target: 25007367 },
      results: { composition: null, collection: null, target: null },
      gameIds: {},
    },
    computed: {
      selectedApiToken() {
        return this.apiTokens.find((item) => item.id === this.selectedTokenId) || null;
      },
      allowedGameOptions() {
        return validGames.map((value) => ({ value, label: gameLabels[value] }));
      },
      selectedTokenGameLabels() {
        return this.selectedApiToken
          ? this.selectedApiToken.allowedGames.map((game) => gameLabels[game]).join("、")
          : "";
      },
      personalStatCards() {
        const emptyStats = {
          apiCalls: 0,
          decisions: 0,
          games: 0,
          frequency: { hour: 0, day: 0, month: 0, year: 0 },
        };
        const cards = validGames.map((game) => ({
          id: game,
          title: gameLabels[game],
          ...emptyStats,
          ...(this.personalStats.games[game] || {}),
          frequency: {
            ...emptyStats.frequency,
            ...(this.personalStats.games[game]?.frequency || {}),
          },
        }));
        return [
          ...cards,
          {
            id: "total",
            title: "总计",
            ...emptyStats,
            ...this.personalStats.total,
            frequency: {
              ...emptyStats.frequency,
              ...(this.personalStats.total?.frequency || {}),
            },
          },
        ];
      },
      featureGroups() {
        const query = this.featureSearch.trim().toLowerCase();
        const categories = [
          { id: "Math", label: "数学特征" },
          { id: "Digits", label: "数字特征" },
          { id: "Easter eggs", label: "彩蛋" },
        ];
        return categories.map((category) => {
          const allFeatures = this.features.filter((feature) => feature.category === category.id);
          const features = query
            ? allFeatures.filter((feature) =>
              [
                feature.id,
                feature.name,
                feature.description,
                feature.descriptionZh,
                feature.family,
                category.id,
                this.categoryLabel(category.id),
                String(feature.score),
                String(feature.probability),
              ]
                .filter(Boolean)
                .some((value) => value.toLowerCase().includes(query)))
            : allFeatures;
          const knowledge = this.config.games?.[this.configGame]?.knowledge || {};
          return {
            ...category,
            features,
            totalCount: allFeatures.length,
            knownCount: allFeatures.filter((feature) => knowledge[feature.id]?.known !== false).length,
          };
        }).filter((group) => group.features.length > 0);
      },
      knownFeatureCount() {
        const knowledge = this.config.games?.[this.configGame]?.knowledge || {};
        return this.features.filter((feature) => knowledge[feature.id]?.known !== false).length;
      },
      compositionMatched() {
        const matched = this.results.composition?.matched;
        return Array.isArray(matched) ? matched : [];
      },
      collectionMatched() {
        const matched = this.results.collection && this.results.collection.matched;
        return Array.isArray(matched) ? matched : [];
      },
      targetMatched() {
        const matched = this.results.target && this.results.target.matched;
        return Array.isArray(matched) ? matched : [];
      },
    },
    watch: {
      activeTab() {
        this.updatePageUrl();
        if (this.activeTab === "profile" && this.user) {
          this.refreshPersonalStats();
        }
      },
      configGame() {
        this.updatePageUrl();
      },
      selectedTokenId(tokenId) {
        const selected = this.apiTokens.find((item) => item.id === tokenId);
        if (!selected) return;
        this.config = selected.config;
        this.ensureConfigShape();
        if (!selected.allowedGames.includes(this.configGame)) {
          this.configGame = selected.allowedGames[0];
        }
        this.gameIds = {};
        this.results = { composition: null, collection: null, target: null };
      },
      featureSearch(value) {
        this.expandedCategories = value.trim()
          ? this.featureGroups.map((group) => group.id)
          : [];
      },
    },
    async created() {
      window.addEventListener("popstate", this.restoreUrlState);
      try {
        const status = await this.request("/api/status", { auth: false });
        this.features = Array.isArray(status.features) ? status.features : [];
        this.config = status.defaultConfig || { games: {} };
      } catch (error) {
        this.$message.error(`无法加载 AI 配置定义：${error.message}`);
      }
      if (this.token) {
        try {
          await this.loadProfile();
        } catch {
          this.clearLogin();
        }
      }
    },
    beforeDestroy() {
      window.removeEventListener("popstate", this.restoreUrlState);
    },
    methods: {
      updatePageUrl() {
        const url = new URL(window.location.href);
        if (this.activeTab === "play") url.searchParams.delete("tab");
        else url.searchParams.set("tab", this.activeTab);
        if (this.configGame === "composition") url.searchParams.delete("game");
        else url.searchParams.set("game", this.configGame);
        const nextUrl = `${url.pathname}${url.search}${url.hash}`;
        if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextUrl) return;
        window.history.pushState(null, "", nextUrl);
      },
      restoreUrlState() {
        const state = readUrlState();
        this.activeTab = state.activeTab;
        this.configGame = state.configGame;
      },
      async request(path, options) {
        const settings = options || {};
        const headers = { "Content-Type": "application/json" };
        if (settings.auth !== false && this.token) headers.Authorization = `Bearer ${this.token}`;
        const response = await fetch(path, {
          method: settings.method || "GET",
          headers,
          body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
      },
      async authenticate() {
        if (!this.authForm.username || !this.authForm.password) {
          this.$message.warning("请输入用户名和密码");
          return;
        }
        this.busy = true;
        try {
          const endpoint = this.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
          const result = await this.request(endpoint, { method: "POST", auth: false, body: this.authForm });
          this.setToken(result.token);
          await this.loadProfile();
          this.$message.success(this.authMode === "login" ? "登录成功" : "账户创建成功");
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      setToken(token) {
        this.token = token;
        localStorage.setItem(tokenStorageKey, token);
      },
      isGameAllowed(game) {
        return Boolean(this.selectedApiToken?.allowedGames.includes(game));
      },
      clearLogin() {
        this.token = "";
        this.user = null;
        this.apiTokens = [];
        this.personalStats = {
          tokenCount: 0,
          total: { apiCalls: 0, decisions: 0, games: 0, frequency: { hour: 0, day: 0, month: 0, year: 0 } },
          games: {},
        };
        this.statsUpdatedAt = "";
        this.tokenGameDrafts = {};
        this.config = { games: {} };
        this.selectedTokenId = "";
        this.gameIds = {};
        this.results = { composition: null, collection: null, target: null };
        localStorage.removeItem(tokenStorageKey);
      },
      async loadProfile() {
        const profile = await this.request("/api/me");
        this.apiTokens = Array.isArray(profile.apiTokens) ? profile.apiTokens : [];
        this.tokenLabelDrafts = {};
        this.tokenGameDrafts = {};
        for (const item of this.apiTokens) {
          item.allowedGames = Array.isArray(item.allowedGames) ? item.allowedGames : [...validGames];
          item.config = item.config && typeof item.config === "object"
            ? item.config
            : JSON.parse(JSON.stringify(this.config));
          this.ensureConfigShape(item.config);
          this.$set(this.tokenLabelDrafts, item.id, item.label);
          this.$set(this.tokenGameDrafts, item.id, [...item.allowedGames]);
        }
        this.user = { username: profile.username };
        if (!this.apiTokens.some((item) => item.id === this.selectedTokenId)) {
          this.selectedTokenId = this.apiTokens[0]?.id || "";
        } else {
          this.config = this.selectedApiToken.config;
        }
        if (this.activeTab === "profile") await this.loadPersonalStats();
      },
      async loadPersonalStats() {
        const stats = await this.request("/api/me/stats");
        const normalizeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
        const normalizeCounts = (value) => ({
          apiCalls: normalizeCount(value?.apiCalls),
          decisions: normalizeCount(value?.decisions),
          games: normalizeCount(value?.games),
          frequency: Object.fromEntries(
            ["hour", "day", "month", "year"].map((period) => [
              period,
              normalizeCount(value?.frequency?.[period]),
            ]),
          ),
        });
        this.personalStats = {
          tokenCount: normalizeCount(stats.tokenCount),
          total: normalizeCounts(stats.total),
          games: Object.fromEntries(
            validGames.map((game) => [game, normalizeCounts(stats.games?.[game])]),
          ),
        };
        this.statsUpdatedAt = new Date().toLocaleTimeString();
      },
      async refreshPersonalStats() {
        try {
          await this.loadPersonalStats();
        } catch (error) {
          this.$message.error(`无法加载个人统计：${error.message}`);
        }
      },
      ensureConfigShape(config = this.config) {
        if (!config || typeof config !== "object") config = { games: {} };
        if (!config.games || typeof config.games !== "object") {
          this.$set(config, "games", {});
        }
        for (const game of ["composition", "collection", "target"]) {
          if (!config.games[game] || typeof config.games[game] !== "object") {
            this.$set(config.games, game, { knowledge: {} });
          }
          const settings = config.games[game];
          if (!settings.knowledge || typeof settings.knowledge !== "object") {
            this.$set(settings, "knowledge", {});
          }
          for (const feature of this.features) {
            if (!settings.knowledge[feature.id]
                || typeof settings.knowledge[feature.id] !== "object") {
              this.$set(settings.knowledge, feature.id, { known: true });
            } else if (typeof settings.knowledge[feature.id].known !== "boolean") {
              this.$set(settings.knowledge, feature.id, { known: true });
            }
          }
        }
      },
      async logout() {
        try {
          await this.request("/api/auth/logout", { method: "POST", body: {} });
        } catch {
          // A locally cached session may already have expired.
        }
        this.clearLogin();
        this.$message.success("已退出登录");
      },
      async ensureGame(game) {
        if (!this.selectedApiToken) throw new Error("请先创建并选择 API token");
        if (!this.selectedApiToken.allowedGames.includes(game)) {
          throw new Error(`当前 token 未授权访问 ${gameLabels[game]}`);
        }
        const key = `${this.selectedTokenId}:${game}`;
        if (this.gameIds[key]) return this.gameIds[key];
        const created = await this.request("/api/games", {
          method: "POST",
          body: { game, tokenId: this.selectedTokenId },
        });
        this.$set(this.gameIds, key, created.game_id);
        return created.game_id;
      },
      async requestDecision(game, input) {
        const id = await this.ensureGame(game);
        const result = await this.request(`/api/games/${id}/decide`, { method: "POST", body: input });
        const decision = result && result.decision;
        if (!decision || typeof decision !== "object") {
          throw new Error("AI API returned an invalid decision");
        }
        if (!Array.isArray(decision.matched)) decision.matched = [];
        if (!Array.isArray(decision.scoringBadges)) decision.scoringBadges = [];
        return decision;
      },
      parseDigits(text, expected, label) {
        const digits = text.split(/[\s,，]+/).filter(Boolean).map(Number);
        if (digits.length !== expected || digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
          throw new Error(`${label}必须输入 ${expected} 个 0–9 的数字`);
        }
        return digits;
      },
      async runComposition() {
        this.busy = true;
        try {
          const key = this.parseDigits(this.compositionKey, 3, "Key 数字");
          const open = this.parseDigits(this.compositionOpen, 5, "Open 数字");
          this.results.composition = await this.requestDecision("composition", { key, open });
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      randomComposition() {
        const digits = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10));
        this.compositionKey = digits.slice(0, 3).join(", ");
        this.compositionOpen = digits.slice(3).join(", ");
      },
      async runCollection() {
        this.busy = true;
        try {
          const decision = await this.requestDecision("collection", {
            current: this.collection.current,
            remainingTurns: this.collection.remainingTurns,
            slotsRemaining: this.collection.slotsRemaining,
          });
          this.results.collection = decision;
          if (decision.action === "take") {
            this.collection.selected.push({
              number: this.collection.current,
              score: decision.score,
            });
            this.collection.slotsRemaining -= 1;
          }
          this.collection.remainingTurns -= 1;
          if (this.collection.remainingTurns > 0) {
            this.collection.current = Math.floor(Math.random() * 1_000_001);
          }
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      nextCollectionNumber() {
        this.collection.current = Math.floor(Math.random() * 1_000_001);
      },
      resetCollection() {
        this.collection = {
          current: Math.floor(Math.random() * 1_000_001),
          remainingTurns: 30,
          slotsRemaining: 5,
          selected: [],
        };
        this.results.collection = null;
      },
      async runTarget() {
        this.busy = true;
        try {
          this.results.target = await this.requestDecision("target", this.target);
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      randomTarget() {
        this.target.number = Math.floor(Math.random() * 1_000_000);
        this.target.target = Math.floor(Math.random() * 200_000_001);
      },
      async saveConfig() {
        if (!this.selectedApiToken) {
          this.$message.warning("请先创建并选择 API token");
          return;
        }
        this.busy = true;
        try {
          const result = await this.request(
            `/api/auth/tokens/${encodeURIComponent(this.selectedTokenId)}/config`,
            { method: "PUT", body: { config: this.config } },
          );
          this.config = result.config;
          this.$set(this.selectedApiToken, "config", result.config);
          this.savedAt = `已于 ${new Date().toLocaleTimeString()} 保存`;
          this.$message.success("AI 配置已保存");
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      async createToken() {
        if (this.tokenAllowedGames.length === 0) {
          this.$message.warning("请至少选择一款允许访问的游戏");
          return;
        }
        this.busy = true;
        try {
          const result = await this.request("/api/auth/tokens", {
            method: "POST",
            body: {
              label: this.tokenLabel || "API token",
              allowedGames: this.tokenAllowedGames,
            },
          });
          this.newToken = result.token;
          this.newTokenMessage = `「${result.label}」Token 已创建；明文仅本次显示，请立即复制。`;
          this.tokenLabel = "";
          this.tokenAllowedGames = [...validGames];
          await this.loadProfile();
          this.selectedTokenId = result.id;
          this.config = this.selectedApiToken.config;
          this.$message.success("Token 已创建，请立即复制保存");
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      async deleteToken(item) {
        try {
          await this.$confirm(`确定撤销「${item.label}」吗？已使用此令牌的 API 请求将立即失效。`, "撤销 API Token", {
            type: "warning",
          });
          await this.request(`/api/auth/tokens/${encodeURIComponent(item.id)}`, { method: "DELETE" });
          await this.loadProfile();
          this.$message.success("Token 已撤销");
        } catch (error) {
          if (error !== "cancel") this.$message.error(error.message);
        }
      },
      async saveTokenDetails(item) {
        const label = (this.tokenLabelDrafts[item.id] || "").trim();
        const allowedGames = this.tokenGameDrafts[item.id] || [];
        if (!label || label.length > 40) {
          this.$message.warning("Token 用途需为 1–40 个字符");
          return;
        }
        if (allowedGames.length === 0) {
          this.$message.warning("请至少为 token 保留一款允许访问的游戏");
          return;
        }
        try {
          const result = await this.request(
            `/api/auth/tokens/${encodeURIComponent(item.id)}`,
            { method: "PUT", body: { label, allowedGames } },
          );
          this.$set(item, "label", result.label);
          this.$set(item, "allowedGames", result.allowedGames);
          this.$set(this.tokenLabelDrafts, item.id, result.label);
          this.$set(this.tokenGameDrafts, item.id, [...result.allowedGames]);
          if (item.id === this.selectedTokenId && !result.allowedGames.includes(this.configGame)) {
            this.configGame = result.allowedGames[0];
          }
          this.$message.success("Token 用途和游戏权限已更新");
        } catch (error) {
          this.$message.error(error.message);
        }
      },
      async rotateToken(item) {
        try {
          await this.$confirm(
            `重新生成「${item.label}」的 Token？旧 Token 会立即失效，原配置和游戏权限会保留。`,
            "重新生成 API Token",
            { type: "warning", confirmButtonText: "重新生成", cancelButtonText: "取消" },
          );
          const result = await this.request(
            `/api/auth/tokens/${encodeURIComponent(item.id)}/rotate`,
            { method: "POST", body: {} },
          );
          this.newToken = result.token;
          this.newTokenMessage = `「${result.label}」的新 Token 已生成；旧 Token 已失效，请更新使用方。`;
          await this.loadProfile();
          this.selectedTokenId = result.id;
          this.config = this.selectedApiToken.config;
          this.$message.success("新 Token 已生成；旧 Token 已失效，请更新使用方");
        } catch (error) {
          if (error !== "cancel") this.$message.error(error.message);
        }
      },
      editTokenConfig(item) {
        this.selectedTokenId = item.id;
        this.activeTab = "config";
      },
      async copyToken() {
        try {
          await navigator.clipboard.writeText(this.newToken);
          this.$message.success("已复制");
        } catch {
          this.$message.error("复制失败，请手动选择并复制令牌");
        }
      },
      featureName(id) {
        return this.features.find((feature) => feature.id === id)?.name || id;
      },
      collectionAction(action) {
        return ({ take: "收下这个数字", skip: "跳过" })[action] || action;
      },
      targetChange(result) {
        return `将第 ${result.position + 1} 位改为 ${result.replacement}`;
      },
      formatScore(score) {
        return score === null || score === undefined ? "—" : Math.round(score).toLocaleString("en-US");
      },
      setAllKnown(known) {
        if (!this.selectedApiToken) return;
        const settings = this.config.games[this.configGame].knowledge;
        for (const feature of this.features) {
          this.$set(settings, feature.id, { known });
        }
      },
      setCategoryKnown(category, known) {
        if (!this.selectedApiToken) return;
        const settings = this.config.games[this.configGame].knowledge;
        for (const feature of this.features) {
          if (feature.category === category) this.$set(settings, feature.id, { known });
        }
      },
      categoryLabel(category) {
        return ({ Math: "数学特征", Digits: "数字特征", "Easter eggs": "彩蛋" })[category]
          || category;
      },
      showFeatureDetails(feature) {
        this.selectedFeature = feature;
        this.featureDialogVisible = true;
      },
      formatDate(date) {
        return new Date(date).toLocaleString();
      },
    },
  });
}());
