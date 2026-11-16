/* global Vue, ELEMENT */
(function () {
  "use strict";

  const tokenStorageKey = "rngdle-ai-session";
  const validTabs = ["play", "config", "tokens", "profile", "admin", "docs"];
  const validGames = ["composition", "collection", "target", "climb", "poker", "claim"];
  const matchTimers = new Map();
  const MATCH_TIMER_SECONDS = { collection: 5, target: 10, climb: 120, claim: 60 };
  const gameLabels = {
    composition: "Digit Composition",
    collection: "Time Collection",
    target: "Target Chase",
    climb: "Digit Climb",
    poker: "Digit Poker",
    claim: "Digit Claim",
  };
  const POKER_DEFAULT_RULES = {
    playerCount: 4,
    rounds: 2,
    startingChips: 10000,
    smallBlind: 50,
    bigBlind: 100,
    fishFeeBb: 2.5,
    firstHandFish: 2,
    fishPerHand: 1,
    privateDigits: 3,
    sharedDigits: 5,
    slots: 6,
    privateSlots: [2, 5],
    digitCopies: 8,
    betTurnSeconds: 15,
    constructSeconds: 30,
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
      thresholds: { type: Array, default: () => [] },
      remainingSlots: { type: Number, required: true },
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
  Vue.component("digit-poker-game-page", {
    props: {
      match: { type: Object, required: true },
      allowed: { type: Boolean, default: false },
      canStart: { type: Boolean, default: true },
      busy: { type: Boolean, default: false },
      formatScore: { type: Function, required: true },
      setup: { type: Object, required: true },
      playAuthMode: { type: String, default: "account" },
    },
    computed: {
      stageLabel() {
        return ({ preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌", construct: "最终构造", lobby: "等待开局" })[this.match.stage] || "对局中";
      },
      humanSeat() {
        return this.match.seats.find((s) => s.isHuman) || null;
      },
      isHumanTurn() {
        if (!this.match.started || this.match.finished) return false;
        const actor = this.match.seats[this.match.actingSeat];
        return Boolean(actor && actor.isHuman && !actor.out && !actor.retired && !actor.folded && !actor.allIn);
      },
      isHumanContesting() {
        const human = this.humanSeat;
        return Boolean(human && !human.out && !human.retired && !human.folded);
      },
      botCount() {
        return Math.max(0, (this.setup && this.setup.playerCount ? this.setup.playerCount : 2) - 1);
      },
    },
    template: "#digit-poker-game-page",
  });
  Vue.component("digit-claim-game-page", {
    props: {
      match: { type: Object, required: true },
      allowed: { type: Boolean, default: false },
      canStart: { type: Boolean, default: true },
      busy: { type: Boolean, default: false },
      formatScore: { type: Function, required: true },
    },
    computed: {
      isHumanTurn() {
        return Boolean(this.match.started && !this.match.finished && this.match.turn === "player");
      },
      canInteract() {
        return this.isHumanTurn && !this.busy && this.allowed;
      },
      currentTime() {
        return this.match.turn === "ai" ? this.match.aiTime : this.match.playerTime;
      },
      currentTimeLabel() {
        return this.match.turn === "ai" ? "AI 剩余时间" : "你的剩余时间";
      },
      orderLabels() {
        return this.match.order.split("").map((side, index) => ({
          index,
          side,
          human: side === this.match.humanSide,
          active: this.match.started && !this.match.finished && index === this.match.index,
          done: this.match.index > index,
        }));
      },
      humanBoardLabel() {
        return `你（${this.match.humanSide}）`;
      },
      aiBoardLabel() {
        return `AI（${this.match.humanSide === "A" ? "B" : "A"}）`;
      },
      humanFirstText() {
        return this.match.humanSide === "A" ? "你先领取" : "AI 先领取";
      },
    },
    methods: {
      placementText(placement) {
        if (!placement) return "—";
        if (placement.moveFreeTo !== null && placement.moveFreeTo !== undefined) {
          return `自由→第 ${placement.moveFreeTo + 1} 格`;
        }
        if (placement.placeFree) return "放入自由格";
        if (placement.placeSlot !== null && placement.placeSlot !== undefined) {
          return `放入第 ${placement.placeSlot + 1} 格`;
        }
        return "—";
      },
    },
    template: "#digit-claim-game-page",
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
        playerPicks: [], aiPicks: [], history: [], thresholds: [], winnerText: "", remainingSeconds: 5,
      },
      targetMatch: {
        started: false, finished: false, round: 0, number: 0, target: 0,
        playerResult: "", playerPoints: 0, aiPoints: 0, history: [], winnerText: "", remainingSeconds: 10,
      },
      climbMatch: {
        started: false, finished: false, rounds: [], playerPoints: 0, aiPoints: 0,
        history: [], winnerText: "", remainingSeconds: 120, timedOut: false,
      },
      pokerMatch: {
        started: false, finished: false, host: false, rules: null, players: [],
        seats: [], dealer: 0, round: 0, hand: 0, stage: "lobby", actingSeat: -1,
        board: [], sharedDigits: [], boardRevealed: 0, pot: 0, toCall: 0, minRaiseTo: 0,
        currentBet: 0, carryFish: 0, handsInRound: 0, history: [], winnerText: "", remainingSeconds: 0,
        constructPhase: false, preselect: "", preselectDone: false, locked: false, humanDraft: "",
        showdownResult: null, finalRanking: [], log: [],
      },
      pokerSetup: { playerCount: 4, rounds: 2, botTokens: { 1: "", 2: "", 3: "", 4: "", 5: "" } },
      claimMatch: {
        started: false, finished: false, pool: [], order: "ABBAABBAABBAAB", index: 0,
        humanSide: "A", turn: "player", player: { fixed: new Array(6).fill(null), free: null },
        ai: { fixed: new Array(6).fill(null), free: null },
        playerTime: 60, aiTime: 60, timedOut: false, winnerText: "",
        selection: null, moveFreeMode: false, message: "", history: [],
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
        return [this.compositionMatch, this.collectionMatch, this.targetMatch, this.climbMatch, this.pokerMatch, this.claimMatch]
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
        this.stopMatchTimer("poker");
        this.stopMatchTimer("claim");
        this.compositionMatch.started = false;
        this.collectionMatch.started = false;
        this.targetMatch.started = false;
        this.climbMatch.started = false;
        this.pokerMatch.started = false;
        this.claimMatch.started = false;
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
      this.stopMatchTimer("poker");
      this.stopMatchTimer("claim");
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
        this.stopMatchTimer("poker");
        this.stopMatchTimer("claim");
        this.compositionMatch.started = false;
        this.collectionMatch.started = false;
        this.targetMatch.started = false;
        this.climbMatch.started = false;
        this.pokerMatch.started = false;
        this.claimMatch.started = false;
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
      // --- Per-seat Digit Poker requests ------------------------------------
      // A bot may be assigned its own API token on the setup screen; otherwise
      // it falls back to the human's current auth (selected account token or
      // the pasted play token). The backend key is namespaced per seat so each
      // bot gets its own game session (and therefore its own config).
      pokerSeatAuth(seat) {
        const token = seat && !seat.isHuman ? seat.apiToken : "";
        if (token) return { kind: "token", token };
        return { kind: this.playAuthMode, token: this.playAuthMode === "token" ? this.playApiToken : this.token };
      },
      async pokerEnsureGameForSeat(seat) {
        const auth = this.pokerSeatAuth(seat);
        if (!auth.token) throw new Error("请先登录或输入 API Token");
        const key = `poker-seat:${seat.index}:${auth.kind}:${auth.token}${auth.kind === "account" ? `:${this.selectedTokenId}` : ""}`;
        if (this.gameIds[key]) return this.gameIds[key];
        // A bot with its own raw token uses the API-token flow; otherwise it
        // inherits the human's auth (account token id or pasted token).
        const body = auth.kind === "account" && auth.token === this.token
          ? { game: "poker", tokenId: this.selectedTokenId }
          : { game: "poker" };
        const created = await this.request("/api/games", {
          method: "POST",
          authToken: auth.token,
          body,
        });
        this.$set(this.gameIds, key, created.game_id);
        return created.game_id;
      },
      async pokerRequestDecisionForSeat(seat, input) {
        const auth = this.pokerSeatAuth(seat);
        const id = await this.pokerEnsureGameForSeat(seat);
        const result = await this.request(`/api/games/${id}/decide`, {
          method: "POST",
          authToken: auth.token,
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
      async pokerRequestScoreForSeat(seat, number) {
        const auth = this.pokerSeatAuth(seat);
        const id = await this.pokerEnsureGameForSeat(seat);
        const result = await this.request(`/api/games/${id}/score`, {
          method: "POST",
          authToken: auth.token,
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
      async requestCollectionThresholds() {
        const id = await this.ensureGame("collection");
        const result = await this.request(`/api/games/${id}/collection-thresholds`, {
          method: "POST",
          authToken: this.playAuthMode === "token" ? this.playApiToken : this.token,
        });
        if (!Array.isArray(result.thresholds) || result.thresholds.length < 1
            || result.thresholds.some((row, index) => (
              row.position !== index + 1
              || !Number.isInteger(row.remainingTurns)
              || !Array.isArray(row.bySlotsRemaining)
              || row.bySlotsRemaining.length < 1
              || row.bySlotsRemaining.some((state) => (
                !["skip", "take", "threshold"].includes(state.action)
                || typeof state.forced !== "boolean"
                || (state.requiredEp !== null && !Number.isSafeInteger(state.requiredEp))
              ))
            ))) {
          throw new Error("Time Collection 门槛 API 返回了无效结果");
        }
        return result.thresholds;
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
          thresholds: [],
          winnerText: "",
          remainingSeconds: MATCH_TIMER_SECONDS.collection,
          timedOut: false,
        };
        const match = this.collectionMatch;
        this.busy = true;
        try {
          await this.ensureGame("collection");
          const [current, thresholds] = await Promise.all([
            this.requestCollectionNumber(),
            this.requestCollectionThresholds(),
          ]);
          if (this.collectionMatch !== match || !match.started) return;
          match.current = current.number;
          match.currentPercentile = current.percentile;
          match.thresholds = thresholds;
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
        const startingNumbers = new Set();
        while (startingNumbers.size < 4) {
          startingNumbers.add(100_000 + Math.floor(Math.random() * 900_000));
        }
        this.climbMatch = {
          started: true,
          finished: false,
          rounds: [3.5, 5.5, 5.5, 7.5].map((budget, index) => ({
            budget,
            number: [...startingNumbers][index],
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
          !/^\d{1,6}$/.test(round.playerResult));
        if (invalidRound !== -1) {
          this.$message.warning(`第 ${invalidRound + 1} 题请输入 0–999999 的六位数。`);
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

      // ---------------------------------------------------------------------
      // Digit Claim engine. A shared pool of 14 digits is drafted in the fixed
      // order A B B A A B B A A B B A A B. The human is A; the AI is B. Each
      // side has six fixed slots plus one free buffer cell, and the free-cell
      // digit can be moved into an empty fixed slot on a later turn. Each
      // side's 60-second clock runs only on its own turns; when it runs out the
      // remaining claims are completed randomly. The higher badge EP wins.
      // ---------------------------------------------------------------------
      claimRandomPool() {
        return Array.from({ length: 14 }, () => Math.floor(Math.random() * 10));
      },
      claimEmptySlots(side) {
        return side.fixed.map((value, index) => (value === null ? index : -1)).filter((index) => index >= 0);
      },
      claimRandomPlacement(side) {
        const empty = this.claimEmptySlots(side);
        if (empty.length > 0) {
          return { moveFreeTo: null, placeSlot: empty[Math.floor(Math.random() * empty.length)], placeFree: false };
        }
        return { moveFreeTo: null, placeSlot: null, placeFree: true };
      },
      claimApplyPlacement(side, placement, digit) {
        const fixed = side.fixed.slice();
        let free = side.free;
        if (placement.moveFreeTo !== null && placement.moveFreeTo !== undefined) {
          fixed[placement.moveFreeTo] = free;
          free = null;
        }
        if (placement.placeFree) {
          free = digit;
        } else if (placement.placeSlot !== null && placement.placeSlot !== undefined) {
          fixed[placement.placeSlot] = digit;
        }
        return { fixed, free };
      },
      claimApplyMove(sideName, placement, digit, extra) {
        const match = this.claimMatch;
        if (!match.pool.includes(digit)) {
          throw new Error("该数字已不在数字池中");
        }
        const target = sideName === "player" ? match.player : match.ai;
        const next = this.claimApplyPlacement(target, placement, digit);
        target.fixed = next.fixed;
        target.free = next.free;
        const poolIndex = match.pool.indexOf(digit);
        match.pool.splice(poolIndex, 1);
        match.history.push({
          index: match.index,
          side: sideName,
          digit,
          placement: { ...placement },
          ...(extra || {}),
        });
        match.selection = null;
        match.moveFreeMode = false;
        match.index += 1;
        this.claimAdvance();
      },
      claimAdvance() {
        const match = this.claimMatch;
        if (match.index >= match.order.length) {
          this.claimFinish();
          return;
        }
        match.turn = match.order[match.index] === match.humanSide ? "player" : "ai";
      },
      async claimRunAiIfNeeded() {
        const match = this.claimMatch;
        if (match.turn === "ai" && !match.finished) {
          await this.claimAiTurn();
        }
      },
      async claimAiTurn() {
        const match = this.claimMatch;
        if (match.turn !== "ai" || match.finished) return;
        this.busy = true;
        try {
          await this.ensureGame("claim");
          const decision = await this.requestDecision("claim", {
            pool: match.pool,
            fixed: match.ai.fixed,
            free: match.ai.free,
            opponent: { fixed: match.player.fixed, free: match.player.free },
            order: match.order,
            index: match.index,
          });
          this.claimApplyMove("ai", decision.placement, decision.claim, { score: decision.score });
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
        await this.claimRunAiIfNeeded();
      },
      claimSelectDigit(digit) {
        const match = this.claimMatch;
        if (!match.started || match.finished || match.turn !== "player" || this.busy) return;
        if (!match.pool.includes(digit)) return;
        match.selection = match.selection === digit ? null : digit;
        // Last-claim control: when the free cell is the only empty cell the
        // placement is forced, so the system places the chosen digit there.
        if (match.selection !== null && match.selection !== undefined
            && match.player.free === null && this.claimEmptySlots(match.player).length === 0) {
          this.claimApplyMove("player", { moveFreeTo: null, placeSlot: null, placeFree: true }, match.selection);
          this.claimRunAiIfNeeded();
        }
      },
      claimToggleMoveFree() {
        const match = this.claimMatch;
        if (!match.started || match.finished || match.turn !== "player" || this.busy) return;
        if (match.player.free === null) {
          this.$message.warning("自由格为空，无法移动");
          return;
        }
        match.moveFreeMode = !match.moveFreeMode;
        if (match.moveFreeMode) match.selection = null;
      },
      claimPlace(slot) {
        const match = this.claimMatch;
        if (!match.started || match.finished || match.turn !== "player" || this.busy) return;
        if (slot >= 0 && match.player.fixed[slot] !== null) {
          this.$message.warning("该固定格已有数字");
          return;
        }
        if (match.moveFreeMode) {
          if (match.player.free === null) {
            this.$message.warning("自由格为空");
            return;
          }
          match.player.fixed[slot] = match.player.free;
          match.player.free = null;
          match.moveFreeMode = false;
          match.selection = null;
          this.$message.success("已将自由格数字移入固定格");
          return;
        }
        if (match.selection !== null && match.selection !== undefined) {
          this.claimApplyMove("player", { moveFreeTo: null, placeSlot: slot, placeFree: false }, match.selection);
          this.claimRunAiIfNeeded();
          return;
        }
        if (match.player.free !== null) {
          match.player.fixed[slot] = match.player.free;
          match.player.free = null;
          this.$message.success("已将自由格数字移入固定格");
          return;
        }
        this.$message.warning("请先在数字池中选择一个数字");
      },
      claimPlaceFree() {
        const match = this.claimMatch;
        if (!match.started || match.finished || match.turn !== "player" || this.busy) return;
        if (match.moveFreeMode) {
          this.$message.warning("请先选择空的固定格来移动自由格");
          return;
        }
        if (match.selection === null || match.selection === undefined) {
          this.$message.warning("请先在数字池中选择一个数字");
          return;
        }
        if (match.player.free !== null) {
          this.$message.warning("自由格已有数字，可先将其移入固定格");
          return;
        }
        this.claimApplyMove("player", { moveFreeTo: null, placeSlot: null, placeFree: true }, match.selection);
        this.claimRunAiIfNeeded();
      },
      async claimUseSuggestion() {
        const match = this.claimMatch;
        if (!match.started || match.finished || match.turn !== "player" || this.busy) return;
        this.busy = true;
        try {
          await this.ensureGame("claim");
          const decision = await this.requestDecision("claim", {
            pool: match.pool,
            fixed: match.player.fixed,
            free: match.player.free,
            opponent: { fixed: match.ai.fixed, free: match.ai.free },
            order: match.order,
            index: match.index,
          });
          this.claimApplyMove("player", decision.placement, decision.claim, { score: decision.score });
        } catch (error) {
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
        await this.claimRunAiIfNeeded();
      },
      async claimForceRandom(side) {
        const match = this.claimMatch;
        match.timedOut = true;
        while (match.index < match.order.length) {
          const current = match.order[match.index] === match.humanSide ? "player" : "ai";
          if (current !== side) break;
          if (match.pool.length === 0) break;
          const target = side === "player" ? match.player : match.ai;
          let digit;
          let placement;
          // Preserve a selection the player already made, and an already
          // arranged free-cell move, before randomising the rest.
          if (side === "player" && match.selection !== null && match.selection !== undefined
              && match.pool.includes(match.selection)) {
            digit = match.selection;
            if (match.moveFreeMode) {
              const empty = this.claimEmptySlots(target);
              placement = empty.length > 0
                ? { moveFreeTo: empty[0], placeSlot: null, placeFree: true }
                : this.claimRandomPlacement(target);
            } else {
              placement = this.claimRandomPlacement(target);
            }
          } else {
            const poolIndex = Math.floor(Math.random() * match.pool.length);
            digit = match.pool[poolIndex];
            placement = this.claimRandomPlacement(target);
          }
          this.claimApplyMove(side, placement, digit, { random: true });
        }
        await this.claimRunAiIfNeeded();
      },
      async claimFinish() {
        const match = this.claimMatch;
        this.stopMatchTimer("claim");
        if (match.finished) return;
        match.finished = true;
        const playerNumber = Number(match.player.fixed.join(""));
        const aiNumber = Number(match.ai.fixed.join(""));
        try {
          const [playerScore, aiScore] = await Promise.all([
            this.requestNumberScore("claim", playerNumber),
            this.requestNumberScore("claim", aiNumber),
          ]);
          match.history.push({
            final: true,
            playerNumber,
            playerScore: playerScore.score,
            aiNumber,
            aiScore: aiScore.score,
          });
          if (playerScore.score === aiScore.score) {
            match.winnerText = `练习赛平局 · 你 ${playerScore.score} EP，AI ${aiScore.score} EP`;
          } else if (playerScore.score > aiScore.score) {
            match.winnerText = `练习赛胜利 · 你 ${playerScore.score} EP，AI ${aiScore.score} EP`;
          } else {
            match.winnerText = `练习赛失败 · 你 ${playerScore.score} EP，AI ${aiScore.score} EP`;
          }
        } catch (error) {
          this.$message.error(error.message);
          match.winnerText = "结算失败，请检查网络后重试";
        }
      },
      async startClaimMatch() {
        if (!this.canPlay("claim") || this.busy || this.anyMatchActive) return;
        this.stopMatchTimer("claim");
        this.claimMatch = {
          started: true,
          finished: false,
          pool: this.claimRandomPool(),
          order: "ABBAABBAABBAAB",
          index: 0,
          humanSide: Math.random() < 0.5 ? "A" : "B",
          turn: "player",
          player: { fixed: new Array(6).fill(null), free: null },
          ai: { fixed: new Array(6).fill(null), free: null },
          playerTime: 60,
          aiTime: 60,
          timedOut: false,
          winnerText: "",
          selection: null,
          moveFreeMode: false,
          message: "",
          history: [],
        };
        this.busy = true;
        try {
          await this.ensureGame("claim");
          this.startClaimTimer();
        } catch (error) {
          this.claimMatch.started = false;
          this.$message.error(error.message);
        } finally {
          this.busy = false;
        }
      },
      startClaimTimer() {
        this.stopMatchTimer("claim");
        const match = this.claimMatch;
        if (!match.started || match.finished) return;
        const interval = window.setInterval(() => {
          if (this.claimMatch !== match || !match.started || match.finished) {
            this.stopMatchTimer("claim");
            return;
          }
          if (match.turn === "player" && match.playerTime > 0) {
            match.playerTime -= 1;
            if (match.playerTime === 0) this.claimForceRandom("player");
          } else if (match.turn === "ai" && match.aiTime > 0) {
            match.aiTime -= 1;
            if (match.aiTime === 0) this.claimForceRandom("ai");
          }
        }, 1000);
        matchTimers.set("claim", { interval });
      },

      // ---------------------------------------------------------------------
      // Digit Poker engine (friendly, unrated). Simulates a full 2–6 player
      // table of Digit Poker hands. The human occupies seat 0; the rest are AI
      // bots that ask the backend for optimal betting and construction.
      // ---------------------------------------------------------------------
      pokerRules() {
        const rules = { ...POKER_DEFAULT_RULES };
        const setup = this.pokerSetup || {};
        if (Number.isInteger(setup.playerCount)) {
          rules.playerCount = Math.min(6, Math.max(2, setup.playerCount));
        }
        if (Number.isInteger(setup.rounds)) {
          rules.rounds = Math.min(10, Math.max(1, setup.rounds));
        }
        return rules;
      },
      pokerActiveSeats() {
        // Seated players (still at the table this round): everyone not "out".
        // Retired players stay seated until the round ends so they still owe
        // blinds and fish fees.
        return this.pokerMatch.seats.filter((seat) => !seat.out);
      },
      pokerContestingSeats() {
        // Players still contesting the current hand: seated, not retired, not folded.
        return this.pokerMatch.seats.filter((seat) => !seat.out && !seat.retired && !seat.folded);
      },
      pokerNextSeat(fromIndex, includeFolded) {
        const seats = includeFolded ? this.pokerActiveSeats() : this.pokerContestingSeats();
        if (!seats.length) return null;
        const ordered = [...seats].sort((a, b) => a.index - b.index);
        const next = ordered.find((seat) => seat.index > fromIndex);
        return next || ordered[0];
      },
      pokerLog(message) {
        this.pokerMatch.log.unshift({ at: new Date().toLocaleTimeString(), text: message });
        if (this.pokerMatch.log.length > 200) this.pokerMatch.log.pop();
      },
      pokerClearTimer() {
        const timer = this.pokerTimer;
        if (timer) window.clearInterval(timer.interval);
        this.pokerTimer = null;
        this.pokerMatch.remainingSeconds = 0;
      },
      pokerSetTimer(seconds, onTimeout) {
        this.pokerClearTimer();
        const duration = Math.max(0, Math.ceil(seconds));
        if (duration === 0) { onTimeout(); return; }
        const deadline = Date.now() + duration * 1000;
        this.pokerMatch.remainingSeconds = duration;
        const timer = { interval: null, deadline };
        const interval = window.setInterval(() => {
          if (this.pokerTimer !== timer || !this.pokerMatch.started || this.pokerMatch.finished) {
            window.clearInterval(interval);
            return;
          }
          const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
          this.pokerMatch.remainingSeconds = remaining;
          if (remaining === 0) {
            window.clearInterval(interval);
            this.pokerTimer = null;
            onTimeout();
          }
        }, 200);
        timer.interval = interval;
        this.pokerTimer = timer;
      },
      async startPokerMatch() {
        if (!this.canPlay("poker") || this.busy || this.anyMatchActive) return;
        const rules = this.pokerRules();
        const botTokens = this.pokerSetup?.botTokens || {};
        const names = ["你", ...Array.from({ length: rules.playerCount - 1 }, (_, i) => `Bot ${i + 1}`)];
        const seats = names.map((name, index) => ({
          index,
          name,
          isHuman: index === 0,
          // Each bot keeps its own API token (raw rng_... token), empty means
          // "use the human's current auth (account token or pasted token)".
          apiToken: index === 0 ? "" : (botTokens[index] || "").trim(),
          chips: rules.startingChips,
          private: [],
          draft: "",
          locked: false,
          folded: false,
          allIn: false,
          retired: false,
          out: false,
          fish: 0,
          streetBet: 0,
          totalBet: 0,
          lastAction: "",
          ep: null,
          collected: 0,
        }));
        this.pokerMatch = {
          started: true, finished: false, host: true, rules, players: seats.map((s) => ({ ...s })),
          seats, dealer: 0, round: 0, hand: 0, stage: "lobby", actingSeat: -1,
          board: [], sharedDigits: [], boardRevealed: 0, pot: 0, toCall: 0, minRaiseTo: 0,
          currentBet: 0, carryFish: 0, handsInRound: 0, history: [], winnerText: "", remainingSeconds: 0,
          constructPhase: false, preselect: "", preselectDone: false, locked: false, humanDraft: "",
          showdownResult: null, finalRanking: [], log: [],
        };
        this.pokerLog(`开始新牌桌：${rules.playerCount} 人，每人 ${rules.startingChips} 筹码，${rules.rounds} 轮。`);
        await this.ensureGame("poker");
        this.pokerBeginRound();
      },
      pokerBeginRound() {
        const match = this.pokerMatch;
        match.round += 1;
        if (match.round > match.rules.rounds) {
          this.pokerEndTable();
          return;
        }
        match.hand = 0;
        // N seated players play exactly N hands this round (fixed dealer rotation).
        match.handsInRound = this.pokerActiveSeats().length;
        this.pokerLog(`—— 第 ${match.round} 轮开始（共 ${match.handsInRound} 手），庄家从座位 ${match.dealer + 1} 起。 ——`);
        this.pokerBeginHand();
      },
      pokerBeginHand() {
        const match = this.pokerMatch;
        const active = this.pokerActiveSeats();
        if (active.length <= 1) { this.pokerEndTable(); return; }
        match.hand += 1;
        match.stage = "preflop";
        match.boardRevealed = 0;
        match.sharedDigits = [];
        match.board = [];
        match.pot = 0;
        match.toCall = 0;
        match.minRaiseTo = 0;
        match.currentBet = 0;
        match.constructPhase = false;
        match.preselect = "";
        match.showdownResult = null;

        // Deal from eight copies of each digit.
        const bag = [];
        for (let digit = 0; digit <= 9; digit++) {
          for (let copy = 0; copy < match.rules.digitCopies; copy++) bag.push(digit);
        }
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        let cursor = 0;
        for (const seat of active) {
          seat.folded = false;
          seat.allIn = false;
          seat.streetBet = 0;
          seat.totalBet = 0;
          seat.lastAction = "";
          seat.acted = false;
          seat.ep = null;
          seat.collected = 0;
          seat.draft = "";
          seat.locked = false;
          seat.private = bag.slice(cursor, cursor + match.rules.privateDigits);
          cursor += match.rules.privateDigits;
        }
        match.sharedDigits = bag.slice(cursor, cursor + match.rules.sharedDigits);
        cursor += match.rules.sharedDigits;
        match.board = match.sharedDigits.slice(0, match.boardRevealed);

        // Blocked players (no playable chips) auto-fold the hand but still owe
        // blinds and fish fees.
        for (const seat of this.pokerActiveSeats()) {
          if (seat.chips <= 0) {
            seat.folded = true;
            seat.lastAction = "无筹码自动弃牌";
          }
        }

        this.pokerLog(`第 ${match.round} 轮 · 第 ${match.hand} 手：庄家 ${active[0].name !== undefined ? this.pokerSeatName(match.dealer) : ""}，每人发 ${match.rules.privateDigits} 张私有数字。`);
        this.pokerPostBlinds();
      },
      pokerSeatName(index) {
        const seat = this.pokerMatch.seats[index];
        return seat ? `${seat.name}（座位 ${index + 1}）` : `座位 ${index + 1}`;
      },
      pokerPostBlinds() {
        const match = this.pokerMatch;
        const sbSeat = this.pokerNextSeat(match.dealer, true);
        const bbSeat = sbSeat ? this.pokerNextSeat(sbSeat.index, true) : null;
        // Forced blinds are posted in full and may make a balance negative.
        const sb = match.rules.smallBlind;
        const bb = match.rules.bigBlind;
        match.currentBet = bb;
        match.toCall = bb;
        match.minRaiseTo = bb * 2;
        if (sbSeat) {
          sbSeat.chips -= sb;
          sbSeat.streetBet = sb;
          sbSeat.totalBet = sb;
          match.pot += sb;
          sbSeat.lastAction = "小盲";
          sbSeat.acted = true;
          if (sbSeat.chips <= 0) sbSeat.allIn = true;
        }
        if (bbSeat) {
          bbSeat.chips -= bb;
          bbSeat.streetBet = bb;
          bbSeat.totalBet = bb;
          match.pot += bb;
          bbSeat.lastAction = "大盲";
          bbSeat.acted = true;
          if (bbSeat.chips <= 0) bbSeat.allIn = true;
        }
        this.pokerLog(`盲注 ${sb}/${bb}：${sbSeat ? this.pokerSeatName(sbSeat.index) : "—"} 小盲，${bbSeat ? this.pokerSeatName(bbSeat.index) : "—"} 大盲。`);
        // First to act preflop: seat after big blind.
        match.actingSeat = bbSeat ? bbSeat.index : (sbSeat ? sbSeat.index : match.dealer);
        this.pokerDriveBetting();
      },
      pokerBettingState() {
        const match = this.pokerMatch;
        const active = this.pokerContestingSeats();
        if (active.length <= 1) return "uncontested";
        const canAct = active.filter((seat) => !seat.allIn);
        if (canAct.length === 0) return "complete";
        if (canAct.every((seat) => seat.acted && seat.streetBet === match.currentBet)) return "complete";
        return "active";
      },
      pokerNextActor() {
        const match = this.pokerMatch;
        const ordered = [...this.pokerContestingSeats()].sort((a, b) => a.index - b.index);
        if (!ordered.length) return null;
        const from = match.actingSeat;
        const eligible = ordered.filter((seat) => !seat.allIn
          && !(seat.acted && seat.streetBet === match.currentBet));
        const after = eligible.find((seat) => seat.index > from);
        return after || eligible[0] || null;
      },
      async pokerDriveBetting() {
        const match = this.pokerMatch;
        while (match.started && !match.finished && match.stage !== "construct") {
          const state = this.pokerBettingState();
          if (state === "uncontested") { this.pokerAwardUncontested(); return; }
          if (state === "complete") { this.pokerFinishBetting(); return; }
          const actor = this.pokerNextActor();
          if (!actor) { this.pokerFinishBetting(); return; }
          match.actingSeat = actor.index;
          if (actor.isHuman) {
            this.pokerStartHumanTurn(actor);
            return;
          }
          await this.pokerBotAct(actor);
        }
      },
      pokerStartHumanTurn(seat) {
        const match = this.pokerMatch;
        const toCall = Math.max(0, match.currentBet - seat.streetBet);
        match.toCall = toCall;
        this.pokerLog(`轮到你了：跟注 ${toCall} 或行动（筹码 ${seat.chips}）。`);
        this.pokerSetTimer(match.rules.betTurnSeconds, () => {
          // Timeout: preselect applies; otherwise check/fold.
          if (match.preselect === "check_fold" || match.preselect === "check") {
            this.pokerApplyHumanAction("check");
          } else if (match.preselect === "fold") {
            this.pokerApplyHumanAction("fold");
          } else if (toCall === 0) {
            this.pokerApplyHumanAction("check");
          } else {
            this.pokerApplyHumanAction("fold");
          }
        });
      },
      async pokerBotAct(seat) {
        const match = this.pokerMatch;
        const toCall = Math.max(0, match.currentBet - seat.streetBet);
        let action = "check";
        let raiseTo = null;
        try {
          const decision = await this.pokerRequestDecisionForSeat(seat, {
            mode: "bet",
            private: seat.private,
            shared: match.sharedDigits.slice(0, match.boardRevealed),
            toCall,
            pot: match.pot,
            stack: seat.chips,
            bigBlind: match.rules.bigBlind,
            minRaiseTo: match.minRaiseTo,
            currentBet: match.currentBet,
            opponentsActive: this.pokerContestingSeats().length - 1,
            rules: match.rules,
          });
          action = decision.action;
          raiseTo = decision.raiseTo;
        } catch (error) {
          action = toCall === 0 ? "check" : (Math.random() < 0.5 ? "fold" : "call");
        }
        this.pokerApplyAction(seat, action, raiseTo);
      },
      pokerApplyHumanAction(action) {
        const match = this.pokerMatch;
        const seat = this.pokerMatch.seats[match.actingSeat];
        if (!seat || !seat.isHuman) return;
        this.pokerClearTimer();
        match.preselect = "";
        this.pokerApplyAction(seat, action, null);
        this.pokerDriveBetting();
      },
      pokerApplyAction(seat, action, raiseTo) {
        const match = this.pokerMatch;
        const toCall = Math.max(0, match.currentBet - seat.streetBet);
        if (action === "fold") {
          seat.folded = true;
          seat.acted = true;
          seat.lastAction = "弃牌";
          this.pokerLog(`${this.pokerSeatName(seat.index)} 弃牌。`);
        } else if (action === "check") {
          if (toCall > 0) {
            // Check/fold semantics: cannot check into a bet, so fold instead.
            seat.folded = true;
            seat.acted = true;
            seat.lastAction = "弃牌";
            this.pokerLog(`${this.pokerSeatName(seat.index)} 让牌失败（须跟注），改为弃牌。`);
          } else {
            seat.acted = true;
            seat.lastAction = "让牌";
            this.pokerLog(`${this.pokerSeatName(seat.index)} 让牌。`);
          }
        } else if (action === "call") {
          const amount = Math.min(toCall, seat.chips);
          seat.chips -= amount;
          seat.streetBet += amount;
          seat.totalBet += amount;
          match.pot += amount;
          seat.acted = true;
          seat.lastAction = "跟注";
          if (seat.chips === 0) seat.allIn = true;
          this.pokerLog(`${this.pokerSeatName(seat.index)} 跟注 ${amount}${seat.allIn ? "（全下）" : ""}。`);
        } else if (action === "raise" || action === "allin") {
          const maxTotal = seat.streetBet + seat.chips;
          let total = action === "allin"
            ? maxTotal
            : Math.min(maxTotal, Math.max(match.minRaiseTo, Number(raiseTo) || (match.currentBet + match.rules.bigBlind)));
          if (total <= match.currentBet) {
            // Under-raise: treat as call.
            const amount = Math.min(toCall, seat.chips);
            seat.chips -= amount;
            seat.streetBet += amount;
            seat.totalBet += amount;
            match.pot += amount;
            seat.acted = true;
            seat.lastAction = "跟注";
            if (seat.chips === 0) seat.allIn = true;
            this.pokerLog(`${this.pokerSeatName(seat.index)} 跟注 ${amount}。`);
            return;
          }
          const amount = total - seat.streetBet;
          seat.chips -= amount;
          seat.streetBet = total;
          seat.totalBet += amount;
          match.pot += amount;
          const raiseBy = total - match.currentBet;
          match.minRaiseTo = total + Math.max(raiseBy, match.rules.bigBlind);
          match.currentBet = total;
          match.toCall = total;
          if (seat.chips === 0) seat.allIn = true;
          seat.acted = true;
          seat.lastAction = seat.allIn ? "全下" : "加注";
          this.pokerLog(`${this.pokerSeatName(seat.index)} ${seat.allIn ? "全下" : `加注到 ${total}`}。`);
        }
      },
      pokerFinishBetting() {
        const match = this.pokerMatch;
        match.actingSeat = -1;
        this.pokerClearTimer();
        // Reset street bets and advance to the next street.
        for (const seat of this.pokerActiveSeats()) {
          seat.streetBet = 0;
          seat.acted = false;
        }
        match.currentBet = 0;
        match.toCall = 0;
        match.minRaiseTo = match.rules.bigBlind * 2;
        if (match.boardRevealed === 0) {
          match.boardRevealed = 3; // flop
          match.board = match.sharedDigits.slice(0, 3);
          this.pokerLog(`翻牌：${match.board.join(" · ")}。`);
          this.pokerStartBettingStreet();
        } else if (match.boardRevealed === 3) {
          match.boardRevealed = 4; // turn
          match.board = match.sharedDigits.slice(0, 4);
          this.pokerLog(`转牌：${match.board.join(" · ")}。`);
          this.pokerStartBettingStreet();
        } else if (match.boardRevealed === 4) {
          match.boardRevealed = 5; // river
          match.board = match.sharedDigits.slice(0, 5);
          this.pokerLog(`河牌：${match.board.join(" · ")}。`);
          this.pokerStartBettingStreet();
        } else {
          this.pokerStartConstruct();
        }
      },
      pokerStartBettingStreet() {
        const match = this.pokerMatch;
        match.stage = match.boardRevealed === 3 ? "flop" : match.boardRevealed === 4 ? "turn" : "river";
        const active = this.pokerContestingSeats();
        if (active.length <= 1) {
          this.pokerAwardUncontested();
          return;
        }
        for (const seat of active) seat.acted = false;
        // First to act postflop: seat after the dealer.
        const first = this.pokerNextSeat(match.dealer, false);
        match.actingSeat = first ? first.index : active[0].index;
        this.pokerDriveBetting();
      },
      pokerAwardUncontested() {
        const match = this.pokerMatch;
        const winners = this.pokerContestingSeats();
        if (winners.length !== 1) {
          // No one can contest the pot: return it to its contributors.
          const contributors = this.pokerMatch.seats.filter((s) => !s.out && s.totalBet > 0);
          const total = contributors.reduce((sum, s) => sum + s.totalBet, 0);
          if (total > 0) {
            for (const seat of contributors) {
              const share = Math.floor(match.pot * (seat.totalBet / total));
              seat.chips += share;
              seat.collected += share;
            }
            this.pokerLog(`无人可争底池，按贡献退回 ${match.pot} 筹码。`);
          }
          match.pot = 0;
          this.pokerEndHand();
          return;
        }
        const winner = winners[0];
        winner.chips += match.pot;
        winner.collected += match.pot;
        match.pot = 0;
        this.pokerLog(`${this.pokerSeatName(winner.index)} 无人跟注，赢得底池 ${winner.collected} 筹码。`);
        this.pokerAwardFish(winner, false);
        this.pokerEndHand();
      },
      pokerStartConstruct() {
        const match = this.pokerMatch;
        match.stage = "construct";
        match.constructPhase = true;
        const contestants = this.pokerContestingSeats();
        if (contestants.length <= 1) {
          this.pokerAwardUncontested();
          return;
        }
        this.pokerLog(`进入最终构造（${match.rules.constructSeconds} 秒）：每位玩家用 ${match.rules.privateDigits} 张私有 + ${match.rules.sharedDigits} 张公共数字填满 ${match.rules.slots} 个槽位。`);
        for (const seat of contestants) {
          if (!seat.isHuman) {
            this.pokerBotConstruct(seat);
          }
        }
        const human = contestants.find((s) => s.isHuman);
        if (human) {
          match.humanDraft = "";
          this.pokerSetTimer(match.rules.constructSeconds, () => {
            this.pokerLockHumanDraft(true);
          });
        } else {
          // No human contesting; just resolve once bots lock.
          this.pokerCheckAllLocked();
        }
      },
      async pokerBotConstruct(seat) {
        const match = this.pokerMatch;
        try {
          const decision = await this.pokerRequestDecisionForSeat(seat, {
            mode: "construct",
            private: seat.private,
            shared: match.sharedDigits,
            rules: match.rules,
          });
          seat.draft = decision.best.digits;
          seat.ep = decision.best.score;
          seat.locked = true;
        } catch (error) {
          seat.draft = String(seat.private[0] !== undefined ? seat.private[0] : 0);
          seat.ep = 0;
          seat.locked = true;
        }
        this.pokerCheckAllLocked();
      },
      pokerValidDraft(seat, input) {
        const match = this.pokerMatch;
        if (!/^\d{6}$/.test(input)) return false;
        const digits = [...input].map(Number);
        const slots = match.rules.privateSlots.map((s) => s - 1);
        const counts = Array(10).fill(0);
        const available = Array(10).fill(0);
        for (const d of seat.private) available[d] += 1;
        for (const d of match.sharedDigits) available[d] += 1;
        for (const s of slots) {
          if (available[digits[s]] === 0) return false;
          available[digits[s]] -= 1;
        }
        for (let i = 0; i < 6; i++) {
          if (slots.includes(i)) continue;
          counts[digits[i]] += 1;
        }
        for (let d = 0; d <= 9; d++) {
          if (counts[d] > available[d]) return false;
        }
        return true;
      },
      async pokerLockHumanDraft(timedOut) {
        const match = this.pokerMatch;
        const human = this.pokerMatch.seats.find((s) => s.isHuman);
        if (!human || human.locked) return;
        this.pokerClearTimer();
        const input = (match.humanDraft || "").trim();
        if (this.pokerValidDraft(human, input)) {
          human.draft = input;
          human.locked = true;
          const playerScore = await this.requestNumberScore("poker", Number(input));
          human.ep = playerScore.score;
        } else if (timedOut) {
          // Timeout: fill blanks (or fix invalid) with lowest-EP legal completion.
          const fixed = [...input].map((ch) => (/^\d$/.test(ch) ? Number(ch) : null));
          while (fixed.length < 6) fixed.push(null);
          try {
            const decision = await this.requestDecision("poker", {
              mode: "construct",
              private: human.private,
              shared: match.sharedDigits,
              fixed: fixed.slice(0, 6),
              rules: match.rules,
            });
            human.draft = decision.completion ? decision.completion.digits : decision.best.digits;
            human.ep = decision.completion ? decision.completion.score : decision.best.score;
          } catch (error) {
            human.draft = String(human.private[0] !== undefined ? human.private[0] : 0);
            human.ep = 0;
          }
          human.locked = true;
        } else {
          this.$message.warning("草稿不合法：第 2、5 位须用私有数字，且每个数字最多使用一次。");
          return;
        }
        this.pokerCheckAllLocked();
      },
      pokerCheckAllLocked() {
        const match = this.pokerMatch;
        const contestants = this.pokerContestingSeats();
        if (contestants.every((s) => s.locked)) {
          this.pokerResolveShowdown();
        }
      },
      pokerResolveShowdown() {
        const match = this.pokerMatch;
        this.pokerClearTimer();
        match.constructPhase = false;
        const contestants = this.pokerContestingSeats();
        // Reveal all EPs.
        const revealed = contestants.map((s) => ({
          name: s.name,
          index: s.index,
          draft: s.draft,
          ep: s.ep,
        }));
        this.pokerLog(`亮牌：${revealed.map((r) => `${r.name} ${r.draft}（EP ${this.formatScore(r.ep)}）`).join("；")}。`);
        // Award pots (main + side pots for unequal all-ins), with unmatched refunds.
        this.pokerSettlePots(contestants);
        this.pokerEndHand();
      },
      pokerSettlePots(contestants) {
        const match = this.pokerMatch;
        // Every player who put chips in contributes (including folded players).
        const contributors = this.pokerMatch.seats.filter((s) => !s.out && s.totalBet > 0);
        const levels = [...new Set(contributors.map((s) => s.totalBet))].sort((a, b) => a - b);
        let prev = 0;
        const layers = [];
        for (const level of levels) {
          const inLayer = contributors.filter((s) => s.totalBet >= level);
          const amount = (level - prev) * inLayer.length;
          layers.push({ level, amount, contributors: inLayer });
          prev = level;
        }

        let refunded = 0;
        let mainPotWinner = null;
        let mainPotSplit = false;
        let mainPotSeen = false;

        for (const layer of layers) {
          if (layer.amount <= 0) continue;
          if (layer.contributors.length === 1) {
            // Unmatched excess: returned to its sole contributor, even if folded.
            const only = layer.contributors[0];
            only.chips += layer.amount;
            only.collected += layer.amount;
            refunded += layer.amount;
            continue;
          }
          const eligible = layer.contributors.filter((s) => !s.folded);
          if (eligible.length === 0) continue;
          const bestEp = Math.max(...eligible.map((s) => s.ep));
          const winners = eligible.filter((s) => s.ep === bestEp);
          const share = Math.floor(layer.amount / winners.length);
          for (const winner of winners) {
            winner.chips += share;
            winner.collected += share;
          }
          const remainder = layer.amount - share * winners.length;
          if (remainder > 0) {
            const ordered = [...winners].sort((a, b) => {
              const da = (a.index - match.dealer + match.seats.length) % match.seats.length;
              const db = (b.index - match.dealer + match.seats.length) % match.seats.length;
              return da - db;
            });
            ordered[0].chips += remainder;
            ordered[0].collected += remainder;
          }
          if (!mainPotSeen) {
            mainPotSeen = true;
            if (winners.length === 1) mainPotWinner = winners[0];
            else mainPotSplit = true;
          }
        }
        if (refunded > 0) this.pokerLog(`退回无人可争的富余筹码 ${refunded}。`);
        match.pot = 0;
        this.pokerAwardFish(mainPotWinner, mainPotSplit);
      },
      pokerAwardFish(winner, split) {
        const match = this.pokerMatch;
        const offered = match.rules.firstHandFish + (match.hand - 1) * match.rules.fishPerHand;
        if (offered <= 0) return;
        if (split) {
          // Split main pot carries the fish forward.
          match.carryFish += offered;
          this.pokerLog(`主池平分，${offered} 条鱼顺延到下一手（当前累计 ${match.carryFish} 条）。`);
          return;
        }
        const total = offered + match.carryFish;
        match.carryFish = 0;
        if (winner) {
          winner.fish += total;
          this.pokerLog(`${this.pokerSeatName(winner.index)} 独得主池，获得 ${total} 条鱼。`);
        }
      },
      pokerEndHand() {
        const match = this.pokerMatch;
        // Any carry fish after the round's final hand is discarded.
        if (match.hand >= match.handsInRound) {
          if (match.carryFish > 0) {
            this.pokerLog(`本轮最后一手结束，顺延的 ${match.carryFish} 条鱼作废。`);
            match.carryFish = 0;
          }
        }
        // Record hand summary.
        match.history.push({
          round: match.round,
          hand: match.hand,
          board: match.sharedDigits.join(""),
          pot: match.seats.reduce((s, x) => s + x.collected, 0),
          summary: [...match.seats].filter((s) => !s.out).map((s) => `${s.name}:${s.chips}`).join(" "),
        });
        // Rotate dealer.
        const active = this.pokerActiveSeats();
        if (active.length > 1) {
          const next = this.pokerNextSeat(match.dealer, true);
          match.dealer = next ? next.index : active[0].index;
        }
        // Advance hand or end round.
        if (match.hand >= match.handsInRound) {
          this.pokerEndRound();
        } else {
          this.pokerBeginHand();
        }
      },
      pokerEndRound() {
        const match = this.pokerMatch;
        const active = this.pokerActiveSeats();
        // Settle fish fees.
        const fishHolders = active.filter((s) => s.fish > 0);
        const zeroFish = active.filter((s) => s.fish === 0);
        if (fishHolders.length && zeroFish.length) {
          const fee = match.rules.fishFeeBb * match.rules.bigBlind;
          this.pokerLog(`结算鱼费（每条鱼价 ${fee}）：`);
          for (const payer of zeroFish) {
            for (const holder of fishHolders) {
              const cost = holder.fish * Math.floor((holder.fish + 1) / 2) * fee;
              const paid = Math.min(cost, payer.chips); // can go negative
              payer.chips -= cost;
              holder.chips += cost;
              this.pokerLog(`${payer.name} 向 ${holder.name} 支付 ${cost} 筹码（${holder.fish} 条鱼）。`);
            }
          }
        }
        // Clear fish.
        for (const seat of active) seat.fish = 0;
        // Players at 0 chips or below leave; retired players leave now too.
        for (const seat of [...this.pokerActiveSeats()]) {
          if (seat.chips <= 0) {
            seat.out = true;
            this.pokerLog(`${seat.name} 筹码归零或为负，离桌。`);
          } else if (seat.retired) {
            seat.out = true;
            this.pokerLog(`${seat.name} 已退役，本轮结束离桌。`);
          }
        }
        const remaining = this.pokerActiveSeats();
        if (remaining.length <= 1) {
          this.pokerEndTable();
          return;
        }
        if (match.round >= match.rules.rounds) {
          this.pokerEndTable();
          return;
        }
        this.pokerLog(`—— 第 ${match.round} 轮结束，剩余 ${remaining.length} 人继续。 ——`);
        this.pokerBeginRound();
      },
      pokerEndTable() {
        const match = this.pokerMatch;
        // Keep `started` true so the finished view (winner, ranking, history,
        // log) stays on screen; `finished` alone is what other pages key off
        // for "show start button again".
        match.finished = true;
        match.started = true;
        this.pokerClearTimer();

        // Build a final ranking for the result panel.
        const startChips = match.rules.startingChips;
        const ranked = [...match.seats]
          .sort((a, b) => b.chips - a.chips)
          .map((seat, index) => ({
            ...seat,
            rank: index + 1,
            profit: seat.chips - startChips,
          }));
        match.finalRanking = ranked;

        const human = match.seats.find((s) => s.isHuman);
        const leaders = ranked.filter((s) => s.chips === ranked[0]?.chips);
        const humanWon = leaders.some((s) => s.isHuman);
        if (ranked.length === 1 && human && ranked[0].isHuman) {
          match.winnerText = `牌桌结束 · 你成为唯一剩余玩家，赢得整场牌桌！`;
        } else if (humanWon) {
          match.winnerText = `牌桌结束 · 你以 ${human.chips} 筹码${leaders.length > 1 ? "并列" : ""}领先，赢得牌桌！`;
        } else if (human && !human.out) {
          const leader = ranked[0];
          match.winnerText = `牌桌结束 · 冠军 ${leader.name}（${leader.chips} 筹码）。你的最终筹码：${human.chips}（${human.chips >= startChips ? "+" : ""}${human.chips - startChips}）。`;
        } else {
          match.winnerText = `牌桌结束 · 冠军 ${ranked[0]?.name || "—"}（${ranked[0]?.chips ?? 0} 筹码）。你已离桌。`;
        }
        this.pokerLog(match.winnerText);
        this.pokerLog(`最终名次：${ranked.map((s) => `${s.rank}.${s.name} ${s.chips}`).join(" · ")}`);
      },
      async pokerHumanAction(action) {
        const match = this.pokerMatch;
        if (!match.started || match.finished) return;
        const seat = this.pokerMatch.seats[match.actingSeat];
        if (!seat || !seat.isHuman) return;
        await this.pokerApplyHumanAction(action);
      },
      async pokerHumanPreselect(action) {
        this.pokerMatch.preselect = action;
        this.$message.success("已预选下一轮动作");
      },
      async pokerHumanLock() {
        await this.pokerLockHumanDraft(false);
      },
      async pokerHumanRetire() {
        const human = this.pokerMatch.seats.find((s) => s.isHuman);
        if (!human || human.retired) return;
        try {
          await this.$confirm("退役后本轮结束即离开（仍须承担盲注和鱼费义务）。确定继续吗？", "退役", { type: "warning" });
          human.retired = true;
          human.folded = true;
          this.pokerLog("你选择退役，本轮结束后离开牌桌。");
          // If we were waiting for the human, hand over to the next actor.
          if (this.pokerMatch.actingSeat === human.index) {
            this.pokerClearTimer();
            this.pokerDriveBetting();
          }
        } catch (error) {
          if (error !== "cancel") this.$message.error(error.message);
        }
      },
      async pokerAbandon() {
        try {
          await this.$confirm("放弃后本场练习对局的牌桌记录将不再显示。确定继续吗？", "放弃牌桌", { type: "warning" });
          this.pokerClearTimer();
          this.pokerMatch.started = false;
          this.pokerMatch.finished = true;
        } catch (error) {
          if (error !== "cancel") this.$message.error(error.message);
        }
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
