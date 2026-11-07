/* global Vue, ELEMENT */
(function () {
  "use strict";

  const tokenStorageKey = "rngdle-ai-session";
  const validTabs = ["play", "config", "tokens", "profile", "admin", "docs"];
  const validGames = ["composition", "collection", "target", "climb"];
  const matchTimers = new Map();
  const MATCH_TIMER_SECONDS = { collection: 5, target: 10, climb: 120 };
  const gameLabels = {
    composition: "Digit Composition",
    collection: "Time Collection",
    target: "Target Chase",
    climb: "Digit Climb",
  };
  const initialUrlState = readUrlState();

  Vue.component("composition-game-page", {
    props: {
      match: { type: Object, required: true },
      allowed: { type: Boolean, default: false },
      canStart: { type: Boolean, default: true },
      busy: { type: Boolean, default: false },
      timeLimit: { type: Number, required: true },
      formatScore: { type: Function, required: true },
    },
    template: "#composition-game-page",
  });
  Vue.component("collection-game-page", {
    props: {
      match: { type: Object, required: true },
      allowed: { type: Boolean, default: false },
      canStart: { type: Boolean, default: true },
      busy: { type: Boolean, default: false },
      formatScore: { type: Function, required: true },
      collectionTotal: { type: Function, required: true },
    },
    template: "#collection-game-page",
  });
  Vue.component("target-game-page", {
    props: {
      match: { type: Object, required: true },
      allowed: { type: Boolean, default: false },
      canStart: { type: Boolean, default: true },
      busy: { type: Boolean, default: false },
      formatScore: { type: Function, required: true },
    },
    template: "#target-game-page",
  });
  Vue.component("digit-climb-game-page", {
    props: {
      match: { type: Object, required: true },
      allowed: { type: Boolean, default: false },
      canStart: { type: Boolean, default: true },
      busy: { type: Boolean, default: false },
      formatScore: { type: Function, required: true },
    },
    template: "#digit-climb-game-page",
  });

  function readUrlState() {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const game = params.get("game");
    const playGame = params.get("playGame");
    return {
      activeTab: validTabs.includes(tab) ? tab : "play",
      configGame: validGames.includes(game) ? game : "composition",
      playGame: validGames.includes(playGame) ? playGame : "composition",
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
          <el-menu-item v-if="user.role === 'admin'" index="admin"><i class="el-icon-s-tools"></i>管理面板</el-menu-item>
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
      passwordForm: { currentPassword: "", newPassword: "", confirmPassword: "" },
      apiTokens: [],
      playAuthMode: "account",
      playApiToken: "",
      playCredentialVersion: 0,
      compositionMatch: {
        started: false, finished: false, playerPoints: 0, aiPoints: 0,
        rounds: [], history: [], winnerText: "", remainingSeconds: 120,
      },
      collectionMatch: {
        started: false, finished: false, turn: 0, current: 0, currentPercentile: 0,
        playerPicks: [], aiPicks: [], history: [], winnerText: "", remainingSeconds: 5,
      },
      targetMatch: {
        started: false, finished: false, round: 0, number: 0, target: 0,
        playerResult: "", playerPoints: 0, aiPoints: 0, history: [], winnerText: "", remainingSeconds: 10,
      },
      climbMatch: {
        started: false, finished: false, rounds: [], playerPoints: 0, aiPoints: 0,
        history: [], winnerText: "", remainingSeconds: 120, timedOut: false,
      },
      personalStats: {
        tokenCount: 0,
        total: { apiCalls: 0, decisions: 0, games: 0, frequency: { hour: 0, day: 0, month: 0, year: 0 } },
        games: {},
      },
      statsUpdatedAt: "",
      tokenLabelDrafts: {},
      tokenGameDrafts: {},
      configGroups: [],
      features: [],
      oauthProviders: [],
      siteInfo: { title: "RNGdle AI", description: "", announcement: "", supportUrl: "" },
      adminOverview: {},
      adminUsers: [],
      adminProviders: [],
      adminProviderForm: {
        id: "", name: "", enabled: true, clientId: "", clientSecret: "",
        authorizationUrl: "", tokenUrl: "", userInfoUrl: "", issuer: "",
        scopes: "openid profile email", subjectField: "sub", pkceEnabled: true,
      },
      editingProviderId: "",
      adminSiteInfo: { title: "", description: "", announcement: "", supportUrl: "" },
      config: { games: {} },
      authMode: "login",
      authForm: { username: "", password: "" },
      activeTab: initialUrlState.activeTab,
      configGame: initialUrlState.configGame,
      playGame: initialUrlState.playGame,
      compositionTimeLimit: 120,
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
      availableConfigGroups() {
        return this.configGroups;
      },
      selectedConfigGroup() {
        const groupId = this.selectedApiToken?.configGroupIds?.[this.configGame];
        return this.configGroups.find((group) => group.id === groupId) || null;
      },
      anyMatchActive() {
        return [this.compositionMatch, this.collectionMatch, this.targetMatch, this.climbMatch]
          .some((match) => match.started && !match.finished);
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
      adminOverviewCards() {
        return [
          { label: "用户", value: this.adminOverview.userCount },
          { label: "活跃用户", value: this.adminOverview.activeUserCount },
          { label: "API Token", value: this.adminOverview.apiTokenCount },
          { label: "启用的 OAuth", value: this.adminOverview.oauthProviderCount },
          { label: "OAuth 绑定", value: this.adminOverview.boundOAuthIdentityCount },
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
    },
    watch: {
      activeTab() {
        this.updatePageUrl();
        if (this.activeTab === "profile" && this.user) {
          this.refreshPersonalStats();
        }
        if (this.activeTab === "admin" && this.user?.role === "admin") {
          this.loadAdminPanel();
        }
      },
      configGame() {
        this.updatePageUrl();
      },
      playGame() {
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
        this.stopMatchTimer("composition");
        this.stopMatchTimer("collection");
        this.stopMatchTimer("target");
        this.stopMatchTimer("climb");
        this.compositionMatch.started = false;
        this.collectionMatch.started = false;
        this.targetMatch.started = false;
        this.climbMatch.started = false;
      },
      playAuthMode() {
        this.gameIds = {};
        this.playCredentialVersion += 1;
      },
      playApiToken() {
        this.gameIds = {};
        this.playCredentialVersion += 1;
      },
      featureSearch(value) {
        this.expandedCategories = value.trim()
          ? this.featureGroups.map((group) => group.id)
          : [];
      },
    },
    async created() {
      window.addEventListener("popstate", this.restoreUrlState);
      const oauthToken = this.readOAuthToken();
      if (oauthToken) this.setToken(oauthToken);
      try {
        const status = await this.request("/api/status", { auth: false });
        this.features = Array.isArray(status.features) ? status.features : [];
        this.config = status.defaultConfig || { games: {} };
        const [providerResponse, siteInfo] = await Promise.all([
          this.request("/api/auth/oauth/providers", { auth: false }),
          this.request("/api/site-info", { auth: false }),
        ]);
        this.oauthProviders = Array.isArray(providerResponse.providers) ? providerResponse.providers : [];
        this.siteInfo = siteInfo;
        document.title = `${siteInfo.title || "RNGdle AI"} · 游戏控制台`;
      } catch (error) {
        this.$message.error(`无法加载网站配置：${error.message}`);
      }
      if (this.token) {
        try {
          await this.loadProfile();
        } catch {
          this.clearLogin();
        }
      }
      const params = new URLSearchParams(window.location.search);
      const oauthError = params.get("oauth_error");
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const boundProvider = hash.get("oauth_bound");
      if (oauthError) this.$message.error(oauthError);
      if (boundProvider) {
        const provider = this.oauthProviders.find((item) => item.id === boundProvider);
        this.$message.success(`已绑定 ${provider?.name || boundProvider}`);
        this.activeTab = "profile";
      }
      if (oauthError || boundProvider || oauthToken) {
        window.history.replaceState(null, "", `${window.location.pathname}${this.activeTab === "play" ? "" : `?tab=${this.activeTab}`}`);
      }
    },
    beforeDestroy() {
      window.removeEventListener("popstate", this.restoreUrlState);
      this.stopMatchTimer("composition");
      this.stopMatchTimer("collection");
      this.stopMatchTimer("target");
      this.stopMatchTimer("climb");
    },
    methods: {
    readOAuthToken() {
      const params = new URLSearchParams(window.location.hash.slice(1));
      return params.get("oauth_token") || "";
    },
    oauthProviderName(providerId) {
      return this.oauthProviders.find((item) => item.id === providerId)?.name || providerId;
    },
    hasOAuthIdentity(providerId) {
      return this.user.oauthIdentities.some((identity) => identity.providerId === providerId);
    },
    async startOAuth(providerId, flow = "login") {
      if (flow === "bind" && !this.token) {
        this.$message.warning("请先登录后再绑定 OAuth");
        return;
      }
      const endpoint = `/api/auth/oauth/${encodeURIComponent(providerId)}/start?flow=${flow}`;
      try {
        const result = await this.request(endpoint);
        window.location.assign(result.authorizationUrl);
      } catch (error) {
        this.$message.error(error.message);
      }
    },
    async unlinkOAuth(providerId) {
      try {
        await this.$confirm("解除后将不能再通过此 OAuth 身份登录，确定继续吗？", "解除 OAuth 绑定", { type: "warning" });
        await this.request(`/api/me/oauth/${encodeURIComponent(providerId)}`, { method: "DELETE" });
        await this.loadProfile();
        this.$message.success("OAuth 绑定已解除");
      } catch (error) {
        if (error !== "cancel") this.$message.error(error.message);
      }
    },
    async changePassword() {
      if (this.passwordForm.newPassword !== this.passwordForm.confirmPassword) {
        this.$message.warning("两次输入的新密码不一致");
        return;
      }
      this.busy = true;
      try {
        await this.request("/api/me/password", {
          method: "PUT",
          body: {
            currentPassword: this.passwordForm.currentPassword,
            newPassword: this.passwordForm.newPassword,
          },
        });
        this.passwordForm = { currentPassword: "", newPassword: "", confirmPassword: "" };
        this.$message.success("密码已更新；其他已登录会话已退出");
      } catch (error) {
        this.$message.error(error.message);
      } finally {
        this.busy = false;
      }
    },
    async loadAdminPanel() {
      if (this.user?.role !== "admin") return;
      try {
        const [overview, users, providers, siteInfo] = await Promise.all([
          this.request("/api/admin/overview"),
          this.request("/api/admin/users"),
          this.request("/api/admin/oauth/providers"),
          this.request("/api/admin/site-info"),
        ]);
        this.adminOverview = overview;
        this.adminUsers = users.users || [];
        this.adminProviders = providers.providers || [];
        this.adminSiteInfo = { ...siteInfo };
      } catch (error) {
        this.$message.error(`无法加载管理面板：${error.message}`);
      }
    },
    resetProviderForm() {
      this.editingProviderId = "";
      this.adminProviderForm = {
        id: "", name: "", enabled: true, clientId: "", clientSecret: "",
        authorizationUrl: "", tokenUrl: "", userInfoUrl: "", issuer: "",
        scopes: "openid profile email", subjectField: "sub", pkceEnabled: true,
      };
    },
    editProvider(provider) {
      this.editingProviderId = provider.id;
      this.adminProviderForm = { ...provider, clientSecret: "" };
    },
    async saveProvider() {
      try {
        const editing = Boolean(this.editingProviderId);
        const endpoint = editing
          ? `/api/admin/oauth/providers/${encodeURIComponent(this.editingProviderId)}`
          : "/api/admin/oauth/providers";
        await this.request(endpoint, {
          method: editing ? "PUT" : "POST",
          body: this.adminProviderForm,
        });
        this.resetProviderForm();
        await this.loadAdminPanel();
        const result = await this.request("/api/auth/oauth/providers", { auth: false });
        this.oauthProviders = result.providers || [];
        this.$message.success("OAuth 提供商配置已保存");
      } catch (error) {
        this.$message.error(error.message);
      }
    },
    async deleteProvider(provider) {
      try {
        await this.$confirm(`删除 OAuth 提供商「${provider.name}」？删除会移除现有绑定；仅依赖此方式登录的账户需要先添加其他登录方式。`, "删除 OAuth 提供商", { type: "warning" });
        await this.request(`/api/admin/oauth/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
        await this.loadAdminPanel();
        this.oauthProviders = this.oauthProviders.filter((item) => item.id !== provider.id);
        this.$message.success("OAuth 提供商已删除");
      } catch (error) {
        if (error !== "cancel") this.$message.error(error.message);
      }
    },
    async updateAdminUser(item, updates) {
      try {
        await this.request(`/api/admin/users/${encodeURIComponent(item.username)}`, { method: "PATCH", body: updates });
        await this.loadAdminPanel();
        this.$message.success("用户信息已更新");
      } catch (error) {
        this.$message.error(error.message);
        await this.loadAdminPanel();
      }
    },
    async deleteAdminUser(item) {
      try {
        await this.$confirm(`永久删除用户「${item.username}」及其 API token 和绑定？`, "删除用户", { type: "warning" });
        await this.request(`/api/admin/users/${encodeURIComponent(item.username)}`, { method: "DELETE" });
        await this.loadAdminPanel();
      } catch (error) {
        if (error !== "cancel") this.$message.error(error.message);
      }
    },
    async saveSiteInfo() {
      try {
        this.siteInfo = await this.request("/api/admin/site-info", { method: "PUT", body: this.adminSiteInfo });
        document.title = `${this.siteInfo.title} · 游戏控制台`;
        await this.loadAdminPanel();
        this.$message.success("网站信息已保存");
      } catch (error) {
        this.$message.error(error.message);
      }
    },
      updatePageUrl() {
        const url = new URL(window.location.href);
        if (this.activeTab === "play") url.searchParams.delete("tab");
        else url.searchParams.set("tab", this.activeTab);
        if (this.configGame === "composition") url.searchParams.delete("game");
        else url.searchParams.set("game", this.configGame);
        if (this.playGame === "composition") url.searchParams.delete("playGame");
        else url.searchParams.set("playGame", this.playGame);
        const nextUrl = `${url.pathname}${url.search}${url.hash}`;
        if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextUrl) return;
        window.history.pushState(null, "", nextUrl);
      },
      restoreUrlState() {
        const state = readUrlState();
        this.activeTab = state.activeTab;
        this.configGame = state.configGame;
        this.playGame = state.playGame;
      },
      async request(path, options) {
        const settings = options || {};
        const headers = { "Content-Type": "application/json" };
        const authToken = settings.authToken || this.token;
        if (settings.auth !== false && authToken) headers.Authorization = `Bearer ${authToken}`;
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
        if (this.authMode !== "login") {
          this.$message.warning("注册仅支持 OAuth，请选择一个 OAuth 提供商");
          return;
        }
        if (!this.authForm.username || !this.authForm.password) {
          this.$message.warning("请输入用户名和密码");
          return;
        }
        this.busy = true;
        try {
          const result = await this.request("/api/auth/login", {
            method: "POST",
            auth: false,
            body: this.authForm,
          });
          this.setToken(result.token);
          await this.loadProfile();
          this.$message.success("登录成功");
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
      stopMatchTimer(game) {
        const timer = matchTimers.get(game);
        if (timer) window.clearInterval(timer.interval);
        matchTimers.delete(game);
      },
      startMatchTimer(game, seconds) {
        this.stopMatchTimer(game);
        const match = this[`${game}Match`];
        const duration = Math.max(0, Math.ceil(seconds));
        if (!match.started || match.finished || duration === 0) return;
        const deadline = Date.now() + duration * 1000;
        match.remainingSeconds = duration;
        const interval = window.setInterval(() => {
          if (this[`${game}Match`] !== match || !match.started || match.finished) {
            this.stopMatchTimer(game);
            return;
          }
          const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
          match.remainingSeconds = remaining;
          if (remaining === 0) this.expireMatch(game, match);
        }, 200);
        matchTimers.set(game, { interval, deadline });
      },
      pauseMatchTimer(game) {
        const timer = matchTimers.get(game);
        if (!timer) return true;
        const match = this[`${game}Match`];
        this.stopMatchTimer(game);
        match.remainingSeconds = Math.max(0, Math.ceil((timer.deadline - Date.now()) / 1000));
        if (match.remainingSeconds === 0) {
          this.expireMatch(game, match);
          return false;
        }
        return true;
      },
      expireMatch(game, match = this[`${game}Match`]) {
        this.stopMatchTimer(game);
        if (this[`${game}Match`] !== match || !match.started || match.finished) return;
        match.remainingSeconds = 0;
        match.finished = true;
        match.timedOut = true;
        match.winnerText = "时间到 · 本场练习赛因超时判负";
      },
      isGameAllowed(game) {
        return Boolean(this.selectedApiToken?.allowedGames.includes(game));
      },
      canPlay(game) {
        return this.playAuthMode === "token"
          ? Boolean(this.playApiToken)
          : this.isGameAllowed(game);
      },
      clearLogin() {
        this.token = "";
        this.user = null;
        this.playApiToken = "";
        this.playAuthMode = "account";
        this.apiTokens = [];
        this.personalStats = {
          tokenCount: 0,
          total: { apiCalls: 0, decisions: 0, games: 0, frequency: { hour: 0, day: 0, month: 0, year: 0 } },
          games: {},
        };
        this.statsUpdatedAt = "";
        this.tokenGameDrafts = {};
        this.configGroups = [];
        this.config = { games: {} };
        this.selectedTokenId = "";
        this.gameIds = {};
        this.stopMatchTimer("composition");
        this.stopMatchTimer("collection");
        this.stopMatchTimer("target");
        this.stopMatchTimer("climb");
        this.compositionMatch.started = false;
        this.collectionMatch.started = false;
        this.targetMatch.started = false;
        this.climbMatch.started = false;
        localStorage.removeItem(tokenStorageKey);
      },
      async loadProfile() {
        const profile = await this.request("/api/me");
        this.apiTokens = Array.isArray(profile.apiTokens) ? profile.apiTokens : [];
        this.configGroups = Array.isArray(profile.configGroups) ? profile.configGroups : [];
        this.tokenLabelDrafts = {};
        this.tokenGameDrafts = {};
        for (const item of this.apiTokens) {
          item.allowedGames = Array.isArray(item.allowedGames) ? item.allowedGames : [...validGames];
          item.configGroupIds = item.configGroupIds && typeof item.configGroupIds === "object"
            ? item.configGroupIds
            : {};
          item.config = item.config && typeof item.config === "object"
            ? item.config
            : JSON.parse(JSON.stringify(this.config));
          this.ensureConfigShape(item.config);
          this.$set(this.tokenLabelDrafts, item.id, item.label);
          this.$set(this.tokenGameDrafts, item.id, [...item.allowedGames]);
        }
        this.user = {
          username: profile.username,
          role: profile.role || "user",
          isRoot: profile.isRoot === true,
          hasPassword: profile.hasPassword === true,
          oauthIdentities: Array.isArray(profile.oauthIdentities) ? profile.oauthIdentities : [],
        };
        if (!this.apiTokens.some((item) => item.id === this.selectedTokenId)) {
          this.selectedTokenId = this.apiTokens[0]?.id || "";
        } else {
          this.config = this.selectedApiToken.config;
        }
        if (this.activeTab === "profile") await this.loadPersonalStats();
        if (this.activeTab === "admin" && this.user.role === "admin") await this.loadAdminPanel();
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
        for (const game of validGames) {
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
        const externalToken = this.playAuthMode === "token";
        const token = externalToken ? this.playApiToken : this.token;
        if (!token) throw new Error(externalToken ? "请输入 API Token" : "请先创建并选择 API Token");
        if (!externalToken && !this.isGameAllowed(game)) {
          throw new Error(`当前 Token 未授权访问 ${gameLabels[game]}`);
        }
        const key = `${externalToken ? `external:${this.playCredentialVersion}` : `account:${this.selectedTokenId}`}:${game}`;
        if (this.gameIds[key]) return this.gameIds[key];
        const created = await this.request("/api/games", {
          method: "POST",
          authToken: token,
          body: externalToken ? { game } : { game, tokenId: this.selectedTokenId },
        });
        this.$set(this.gameIds, key, created.game_id);
        return created.game_id;
      },
      async requestDecision(game, input) {
        const id = await this.ensureGame(game);
        const result = await this.request(`/api/games/${id}/decide`, {
          method: "POST",
          authToken: this.playAuthMode === "token" ? this.playApiToken : this.token,
          body: input,
        });
        const decision = result && result.decision;
        if (!decision || typeof decision !== "object") {
          throw new Error("AI API returned an invalid decision");
        }
        if (!Array.isArray(decision.matched)) decision.matched = [];
        if (!Array.isArray(decision.scoringBadges)) decision.scoringBadges = [];
        return decision;
      },
      async requestNumberScore(game, number) {
        const id = await this.ensureGame(game);
        const result = await this.request(`/api/games/${id}/score`, {
          method: "POST",
          authToken: this.playAuthMode === "token" ? this.playApiToken : this.token,
          body: { number },
        });
        if (!Number.isSafeInteger(result.score) || !Array.isArray(result.matched)) {
          throw new Error("评分 API 返回了无效结果");
        }
        return result;
      },
      async requestCollectionNumber() {
        const id = await this.ensureGame("collection");
        const result = await this.request(`/api/games/${id}/collection-number`, {
          method: "POST",
          authToken: this.playAuthMode === "token" ? this.playApiToken : this.token,
          body: {},
        });
        if (!Number.isInteger(result.number) || result.number < 0 || result.number > 1_000_000
            || !Number.isFinite(result.percentile) || result.percentile < 50
            || !Number.isSafeInteger(result.score)) {
          throw new Error("Time Collection 数字 API 返回了不符合 Uncommon 范围的结果");
        }
        return result;
      },
      shuffled(values) {
        const result = [...values];
        for (let index = result.length - 1; index > 0; index--) {
          const other = Math.floor(Math.random() * (index + 1));
          [result[index], result[other]] = [result[other], result[index]];
        }
        return result;
      },
      drawCompositionRound(match) {
        const bag = Array.from({ length: 80 }, (_, index) => Math.floor(index / 8));
        const digits = this.shuffled(bag).slice(0, 8);
        return {
          key: digits.slice(0, 3),
          open: digits.slice(3),
          playerNumber: "",
        };
      },
      async startCompositionMatch() {
        if (!this.canPlay("composition") || this.busy || this.anyMatchActive) return;
        this.stopMatchTimer("composition");
        this.compositionMatch = {
          started: true, finished: false, playerPoints: 0, aiPoints: 0,
          rounds: [], history: [], winnerText: "",
          remainingSeconds: this.compositionTimeLimit, timedOut: false,
        };
        for (let round = 0; round < 4; round++) {
          this.compositionMatch.rounds.push(this.drawCompositionRound(this.compositionMatch));
        }
        this.startMatchTimer("composition", this.compositionTimeLimit);
      },
      validCompositionNumber(input, match) {
        if (!/^\d{6}$/.test(input)) return false;
        const digits = [...input].map(Number);
        const keyCounts = Array(10).fill(0);
        const openCounts = Array(10).fill(0);
        const selectedCounts = Array(10).fill(0);
        for (const digit of match.key) keyCounts[digit] += 1;
        for (const digit of match.open) openCounts[digit] += 1;
        if (keyCounts[digits[1]] === 0 || keyCounts[digits[4]] === 0) return false;
        keyCounts[digits[1]] -= 1;
        keyCounts[digits[4]] -= 1;
        digits.forEach((digit, index) => {
          if (index !== 1 && index !== 4) selectedCounts[digit] += 1;
        });
        let additionalKeyDigits = 0;
        for (let digit = 0; digit <= 9; digit++) {
          if (selectedCounts[digit] > openCounts[digit]) {
            const needed = selectedCounts[digit] - openCounts[digit];
            if (needed > keyCounts[digit]) return false;
            additionalKeyDigits += needed;
          }
        }
        return additionalKeyDigits <= 1;
      },
      awardRound(match, playerMetric, aiMetric, higherWins) {
        if (playerMetric === aiMetric) {
          match.playerPoints += 0.5;
          match.aiPoints += 0.5;
          return "平";
        }
        const playerWins = higherWins ? playerMetric > aiMetric : playerMetric < aiMetric;
        if (playerWins) match.playerPoints += 1;
        else match.aiPoints += 1;
        return playerWins ? "胜" : "负";
      },
      async submitCompositionRound() {
        const match = this.compositionMatch;
        if (match.finished || this.busy || !this.canPlay("composition")) return;
        const invalidRound = match.rounds.findIndex((round) =>
          !this.validCompositionNumber(round.playerNumber, round));
        if (invalidRound !== -1) {
          this.$message.warning(`第 ${invalidRound + 1} 题的六位数不合法：第 2、5 位用 Key，其余数字须来自该题的 Key/Open 数字且不能重复使用。`);
          return;
        }
        if (!this.pauseMatchTimer("composition")) return;
        this.busy = true;
        try {
          await this.ensureGame("composition");
          const results = await Promise.all(match.rounds.map(async (round, index) => {
            const playerNumber = round.playerNumber;
            const [decision, playerScore] = await Promise.all([
              this.requestDecision("composition", { key: round.key, open: round.open }),
              this.requestNumberScore("composition", Number(playerNumber)),
            ]);
            return {
              round: index + 1,
              playerNumber,
              playerScore: playerScore.score,
              aiNumber: typeof decision.digits === "string"
                ? decision.digits
                : String(decision.number).padStart(6, "0"),
              aiScore: decision.score,
            };
          }));
          for (const result of results) {
            result.roundResult = this.awardRound(match, result.playerScore, result.aiScore, true);
          }
          match.history = results;
          match.finished = true;
          match.winnerText = this.matchWinnerText(match.playerPoints, match.aiPoints);
        } catch (error) {
          this.$message.error(error.message);
          this.startMatchTimer("composition", match.remainingSeconds);
        } finally {
          this.busy = false;
        }
      },
      async startCollectionMatch() {
        if (!this.canPlay("collection") || this.busy || this.anyMatchActive) return;
        this.stopMatchTimer("collection");
        this.collectionMatch = {
          started: true,
          finished: false,
          turn: 0,
          current: 0,
          playerPicks: [],
          aiPicks: [],
          history: [],
          winnerText: "",
          remainingSeconds: MATCH_TIMER_SECONDS.collection,
          timedOut: false,
        };
        const match = this.collectionMatch;
        this.busy = true;
        try {
          const current = await this.requestCollectionNumber();
          if (this.collectionMatch !== match || !match.started) return;
          match.current = current.number;
          match.currentPercentile = current.percentile;
          this.startMatchTimer("collection", MATCH_TIMER_SECONDS.collection);
        } catch (error) {
          match.started = false;
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      collectionTotal(picks) {
        return picks.reduce((total, pick) => total + pick.score, 0);
      },
      async advanceCollection(playerAction) {
        const match = this.collectionMatch;
        if (match.finished || this.busy || !this.canPlay("collection")
            || (playerAction === "take" && match.playerPicks.length >= 5)) return;
        if (playerAction === "skip" && 5 - match.playerPicks.length >= 30 - match.turn) {
          this.$message.warning("剩余回合已不足以留空槽位，本回合必须收下数字");
          return;
        }
        if (!this.pauseMatchTimer("collection")) return;
        this.busy = true;
        try {
          await this.ensureGame("collection");
          const remainingTurns = 30 - match.turn;
          const slotsRemaining = Math.max(0, 5 - match.aiPicks.length);
          const decision = await this.requestDecision("collection", {
            current: match.current,
            remainingTurns,
            slotsRemaining,
          });
          const playerScore = playerAction === "take"
            ? await this.requestNumberScore("collection", match.current)
            : null;
          const number = match.current;
          const nextNumber = match.turn + 1 < 30
            ? await this.requestCollectionNumber()
            : null;
          if (playerScore) match.playerPicks.push({ number, score: playerScore.score });
          if (decision.action === "take") match.aiPicks.push({ number, score: decision.score });
          match.history.push({
            turn: match.turn + 1,
            number,
            percentile: match.currentPercentile,
            playerAction: playerAction === "take" ? "收下" : "跳过",
            aiAction: decision.action === "take" ? "收下" : "跳过",
            aiScore: decision.score,
          });
          match.turn += 1;
          if (match.turn >= 30) {
            match.finished = true;
            const playerTotal = this.collectionTotal(match.playerPicks);
            const aiTotal = this.collectionTotal(match.aiPicks);
            match.winnerText = playerTotal === aiTotal
              ? `平局 · 双方总徽章分 ${this.formatScore(playerTotal)}`
              : playerTotal > aiTotal
                ? `练习赛胜利 · 你的总徽章分 ${this.formatScore(playerTotal)} 高于 AI 的 ${this.formatScore(aiTotal)}`
                : `练习赛失败 · AI 总徽章分 ${this.formatScore(aiTotal)} 高于你的 ${this.formatScore(playerTotal)}`;
          } else {
            match.current = nextNumber.number;
            match.currentPercentile = nextNumber.percentile;
            this.startMatchTimer("collection", MATCH_TIMER_SECONDS.collection);
          }
        } catch (error) {
          this.$message.error(error.message);
          this.startMatchTimer("collection", match.remainingSeconds);
        } finally {
          this.busy = false;
        }
      },
      async nextTargetRound() {
        const number = Math.floor(Math.random() * 1_000_001);
        const targetNumber = Math.floor(Math.random() * 1_000_001);
        const targetScore = await this.requestNumberScore("target", targetNumber);
        return {
          number,
          target: targetScore.score,
          playerResult: "",
        };
      },
      async startTargetMatch() {
        if (!this.canPlay("target") || this.busy || this.anyMatchActive) return;
        this.stopMatchTimer("target");
        this.targetMatch = {
          started: true, finished: false, round: 0, number: 0, target: 0,
          playerResult: "", playerPoints: 0, aiPoints: 0, history: [], winnerText: "",
          remainingSeconds: MATCH_TIMER_SECONDS.target, timedOut: false,
        };
        this.busy = true;
        try {
          Object.assign(this.targetMatch, await this.nextTargetRound());
          this.startMatchTimer("target", MATCH_TIMER_SECONDS.target);
        } catch (error) {
          this.targetMatch.started = false;
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      async submitTargetRound() {
        const match = this.targetMatch;
        if (match.finished || this.busy || !this.canPlay("target")) return;
        if (!/^(0|[1-9]\d{0,6})$/.test(match.playerResult)
            || Number(match.playerResult) > 1_000_000
            || match.playerResult.length !== String(match.number).length
            || [...match.playerResult].filter((digit, index) => digit !== String(match.number)[index]).length !== 1) {
          this.$message.warning("结果必须在 0–1,000,000 范围内，与当前数字位数相同，并且恰好修改一位。");
          return;
        }
        if (!this.pauseMatchTimer("target")) return;
        this.busy = true;
        try {
          const playerNumber = Number(match.playerResult);
          const currentNumber = match.number;
          const currentTarget = match.target;
          await this.ensureGame("target");
          const [decision, playerScore] = await Promise.all([
            this.requestDecision("target", { number: currentNumber, target: currentTarget }),
            this.requestNumberScore("target", playerNumber),
          ]);
          const playerDistance = Math.abs(playerScore.score - currentTarget);
          const aiDistance = decision.distance;
          const completedRound = match.round + 1;
          const nextRound = completedRound < 10
            ? await this.nextTargetRound()
            : null;
          const roundResult = this.awardRound(match, playerDistance, aiDistance, false);
          match.history.push({
            round: completedRound,
            number: currentNumber,
            target: currentTarget,
            playerResult: playerNumber,
            playerDistance,
            aiResult: decision.result,
            aiDistance,
            roundResult,
          });
          match.round = completedRound;
          if (match.round >= 10) {
            match.finished = true;
            match.winnerText = this.matchWinnerText(match.playerPoints, match.aiPoints);
          } else {
            Object.assign(match, nextRound);
            this.startMatchTimer("target", MATCH_TIMER_SECONDS.target);
          }
        } catch (error) {
          this.$message.error(error.message);
          this.startMatchTimer("target", match.remainingSeconds);
        } finally {
          this.busy = false;
        }
      },
      async startDigitClimbMatch() {
        if (!this.canPlay("climb") || this.busy || this.anyMatchActive) return;
        this.stopMatchTimer("climb");
        const number = 100_000 + Math.floor(Math.random() * 900_000);
        this.climbMatch = {
          started: true,
          finished: false,
          rounds: [3, 5, 7].map((budget) => ({
            budget,
            number,
            playerResult: "",
          })),
          playerPoints: 0,
          aiPoints: 0,
          history: [],
          winnerText: "",
          remainingSeconds: MATCH_TIMER_SECONDS.climb,
          timedOut: false,
        };
        this.busy = true;
        try {
          await this.ensureGame("climb");
          this.startMatchTimer("climb", MATCH_TIMER_SECONDS.climb);
        } catch (error) {
          this.climbMatch.started = false;
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      async submitDigitClimbMatch() {
        const match = this.climbMatch;
        if (match.finished || this.busy || !this.canPlay("climb")) return;
        const invalidRound = match.rounds.findIndex((round) =>
          !/^[1-9]\d{5}$/.test(round.playerResult));
        if (invalidRound !== -1) {
          this.$message.warning(`第 ${invalidRound + 1} 题请输入 100000–999999 的六位数。`);
          return;
        }
        if (!this.pauseMatchTimer("climb")) return;
        this.busy = true;
        try {
          const results = await Promise.all(match.rounds.map(async (round, index) => {
            const decision = await this.requestDecision("climb", {
              number: round.number,
              budget: round.budget,
              answer: Number(round.playerResult),
            });
            if (!Array.isArray(decision.solutions) || decision.solutions.length !== 5
                || !decision.answer || !Number.isFinite(decision.answer.score)) {
              throw new Error("Digit Climb API returned an invalid solution list");
            }
            return {
              round: index + 1,
              budget: round.budget,
              number: round.number,
              playerNumber: decision.answer.number,
              playerCost: decision.answer.cost,
              playerScore: decision.answer.score,
              aiSolutions: decision.solutions,
              aiNumber: decision.solutions[0].number,
              aiScore: decision.solutions[0].score,
            };
          }));
          for (const result of results) {
            result.roundResult = this.awardRound(match, result.playerScore, result.aiScore, true);
          }
          match.history = results;
          match.finished = true;
          match.winnerText = this.matchWinnerText(match.playerPoints, match.aiPoints);
        } catch (error) {
          this.$message.error(error.message);
          this.startMatchTimer("climb", match.remainingSeconds);
        } finally {
          this.busy = false;
        }
      },
      matchWinnerText(playerPoints, aiPoints) {
        if (playerPoints === aiPoints) return `练习赛平局 · 你 ${playerPoints} 分，AI ${aiPoints} 分`;
        return playerPoints > aiPoints
          ? `练习赛胜利 · 你 ${playerPoints} 分，AI ${aiPoints} 分`
          : `练习赛失败 · 你 ${playerPoints} 分，AI ${aiPoints} 分`;
      },
      async abandonMatch(game) {
        try {
          await this.$confirm("放弃后本场练习对局的回合记录将不再显示。确定继续吗？", "放弃对局", {
            type: "warning",
          });
          this.stopMatchTimer(game);
          this[`${game}Match`].started = false;
        } catch (error) {
          if (error !== "cancel") this.$message.error(error.message);
        }
      },
      async saveConfig() {
        if (this.anyMatchActive) {
          this.$message.warning("对局进行中，完成或结束对局后再修改 AI 配置");
          return;
        }
        if (!this.selectedApiToken) {
          this.$message.warning("请先创建并选择 API token");
          return;
        }
        if (!this.selectedConfigGroup) {
          this.$message.warning("当前模式尚未选择配置组");
          return;
        }
        this.busy = true;
        try {
          const result = await this.request(
            `/api/auth/config-groups/${encodeURIComponent(this.selectedConfigGroup.id)}`,
            { method: "PUT", body: { config: this.config.games[this.configGame] } },
          );
          const index = this.configGroups.findIndex(({ id }) => id === result.group.id);
          if (index >= 0) this.$set(this.configGroups, index, result.group);
          for (const item of this.apiTokens) {
            for (const game of validGames) {
              if (item.configGroupIds?.[game] !== result.group.id) continue;
              this.$set(item.config.games, game, result.group.config);
            }
          }
          this.$set(this.config.games, this.configGame, result.group.config);
          this.savedAt = `已于 ${new Date().toLocaleTimeString()} 保存`;
          this.$message.success("配置组已保存");
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      async selectConfigGroup(groupId) {
        if (!this.selectedApiToken || !groupId
            || groupId === this.selectedApiToken.configGroupIds?.[this.configGame]) return;
        if (this.anyMatchActive) {
          this.$message.warning("对局进行中，不能切换配置组");
          return;
        }
        this.busy = true;
        try {
          const result = await this.request(
            `/api/auth/tokens/${encodeURIComponent(this.selectedTokenId)}/config-groups/${this.configGame}`,
            { method: "PUT", body: { groupId } },
          );
          this.$set(this.selectedApiToken, "configGroupIds", result.configGroupIds);
          this.$set(this.selectedApiToken, "config", result.config);
          this.config = result.config;
          this.savedAt = "";
          this.$message.success("当前模式已切换到所选配置组");
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      async createConfigGroup() {
        if (!this.selectedApiToken || this.anyMatchActive) {
          this.$message.warning("请先选择 API Token，并在对局结束后创建配置组");
          return;
        }
        let name;
        try {
          const result = await this.$prompt("为新配置组命名（最多 40 个字符）", "新建配置组", {
            inputValue: `${this.selectedApiToken.label} · ${gameLabels[this.configGame]}`,
            inputValidator: (value) => Boolean(value?.trim()) && value.trim().length <= 40,
            inputErrorMessage: "配置组名称需为 1–40 个字符",
            confirmButtonText: "创建并切换",
            cancelButtonText: "取消",
          });
          name = result.value.trim();
        } catch (error) {
          if (error !== "cancel") this.$message.error(error.message);
          return;
        }
        this.busy = true;
        try {
          const result = await this.request(
            `/api/auth/tokens/${encodeURIComponent(this.selectedTokenId)}/config-groups/${this.configGame}`,
            {
              method: "POST",
              body: { name, config: this.config.games[this.configGame] },
            },
          );
          this.configGroups.push(result.group);
          this.$set(this.selectedApiToken, "configGroupIds", result.configGroupIds);
          this.$set(this.selectedApiToken, "config", result.config);
          this.config = result.config;
          this.savedAt = "";
          this.$message.success("配置组已创建并应用到当前 API 模式");
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      async renameConfigGroup() {
        if (!this.selectedConfigGroup) return;
        try {
          const result = await this.$prompt("输入新的配置组名称（最多 40 个字符）", "重命名配置组", {
            inputValue: this.selectedConfigGroup.name,
            inputValidator: (value) => Boolean(value?.trim()) && value.trim().length <= 40,
            inputErrorMessage: "配置组名称需为 1–40 个字符",
            confirmButtonText: "保存",
            cancelButtonText: "取消",
          });
          const updated = await this.request(
            `/api/auth/config-groups/${encodeURIComponent(this.selectedConfigGroup.id)}`,
            { method: "PUT", body: { name: result.value.trim() } },
          );
          const index = this.configGroups.findIndex(({ id }) => id === updated.group.id);
          if (index >= 0) this.$set(this.configGroups, index, updated.group);
          this.$message.success("配置组名称已更新");
        } catch (error) {
          if (error !== "cancel") this.$message.error(error.message);
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
        if (this.anyMatchActive) {
          this.$message.warning("对局进行中，暂不能撤销 Token");
          return;
        }
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
        if (this.anyMatchActive) {
          this.$message.warning("对局进行中，暂不能修改 Token 权限");
          return;
        }
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
        if (this.anyMatchActive) {
          this.$message.warning("对局进行中，暂不能轮换 Token");
          return;
        }
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
