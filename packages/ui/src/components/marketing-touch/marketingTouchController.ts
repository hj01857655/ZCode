import { createStore } from "zustand/vanilla";
import type { IMarketingTouchService } from "@zcode/services";
import type { Locale, MarketingAction, MarketingDelivery } from "@zcode/shared";
import type { CloudDialogHero } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import type { PreparedMarketingHero } from "@/components/marketing-touch/marketingResources.js";
import { logger } from "@/logger.js";

export interface PreparedMarketingDelivery {
  delivery: MarketingDelivery;
  image?: string;
  darkImage?: string;
  bannerHero?: Extract<CloudDialogHero, { type: "interactive_bundle" | "video" }>;
  hero: CloudDialogHero | null;
  success?: Promise<PreparedMarketingHero>;
  release: () => Promise<void>;
}
type Candidate = PreparedMarketingDelivery & { scope: string };
// 导出以便 controller 类型（经 MarketingTouchContext）可被 .d.ts 命名引用。
export interface MarketingTouchState {
  banner: Candidate | null;
  dialog: (Candidate & { result: boolean }) | null;
  pending: boolean;
  phase: "idle" | "verifying" | "submitting" | "preparing";
  error: string | null;
  errorAction: MarketingAction["type"] | null;
}
export type MarketingActionResult = {
  status: "success" | "cancelled" | "failure" | "uncertain";
  message?: string;
  // 领取业务码，用于区分"已领取(1003)"这类本质成功的确定性结果。
  code?: number;
  // 1003 已领取：投放视为已完成，撤下但不当作可重试失败。
  alreadyClaimed?: boolean;
};

// 左下角活动槽位的唯一可见性判断：Banner 与 ConnectedBanner 的渲染守卫共用此谓词，
// 避免仲裁层（SidebarBottomActivity）与展示层对「Banner 是否可见」出现两套判断而漂移。
// 领取 pending 期间 banner 仍非空 → 判定可见，Highspeed 分享卡继续让位。
// 用类型谓词收窄 delivery 到 banner 变体，保留调用点原有的 narrowing。
type RenderableBannerCandidate = Candidate & {
  delivery: Extract<MarketingDelivery, { resource_position: "banner" }>;
};
export function isMarketingBannerRenderable(
  banner: Candidate | null,
): banner is RenderableBannerCandidate {
  return Boolean(
    banner && banner.delivery.resource_position === "banner" && (banner.image || banner.bannerHero),
  );
}

export function createMarketingTouchController(options: {
  query: () => ReturnType<IMarketingTouchService["query"]>;
  report: IMarketingTouchService["report"];
  prepare: (delivery: MarketingDelivery) => Promise<PreparedMarketingDelivery>;
  execute: (
    action: MarketingAction,
    signal: AbortSignal,
    phase: (phase: MarketingTouchState["phase"]) => void,
  ) => Promise<MarketingActionResult>;
  locale: Locale;
  canOpen: () => boolean;
  // 自动领取只在已登录时进行：未登录时领取动作的语义是引导登录。
  canAutoClaim: () => boolean;
  refresh: () => void;
}) {
  const store = createStore<MarketingTouchState>(() => ({
    banner: null,
    dialog: null,
    pending: false,
    phase: "idle",
    error: null,
    errorAction: null,
  }));
  let disposed = false;
  let generation = 0;
  let snapshotScope = "";
  let failureLogged = false;
  let deferredBanner: Candidate | null | undefined;
  let waitingPopup: Candidate | null = null;
  let waitingResult: Candidate | null = null;
  // 每个投放只自动领取一次：失败后交给用户手动重试，避免轮询反复触发验证码。
  const autoClaimAttempts = new Set<string>();
  // 领取成功/1003 的投放视为已完成：confirm 上报与查询存在时序竞态，
  // 服务端下一轮仍可能回包同一 campaign，不能因此重新准备并展示。
  const completedClaims = new Set<string>();
  const lifetime = new AbortController();
  const key = (delivery: MarketingDelivery) =>
    `${delivery.resource_position}:${delivery.campaign_id}`;
  function claimAction(delivery: MarketingDelivery): MarketingAction | undefined {
    const buttons =
      delivery.resource_position === "banner" ? delivery.banner.buttons : delivery.popup.buttons;
    return buttons.find((button) => button.action.type === "claim_zcode_plan")?.action;
  }
  /**
   * 收到含领取按钮的投放后自动发起领取，无需用户点击。
   * 验证码由 SDK 自行决定形态：无痕模式直接回调通过；滑块模式由 SDK 弹窗，用户手动完成。
   * 客户端只负责触发，绝不伪造验证结果；失败/中止后不再自动重试，等用户手动点。
   */
  function autoClaim(candidate: Candidate, allowOpen: boolean) {
    if (
      disposed ||
      store.getState().pending ||
      !options.canAutoClaim() ||
      // banner 自动领取不能和已打开的弹窗抢焦点；popup 自动领取不要求可见。
      (allowOpen && (store.getState().dialog || !options.canOpen()))
    )
      return;
    const action = claimAction(candidate.delivery);
    if (!action) return;
    const id = `${candidate.scope}:${key(candidate.delivery)}`;
    if (autoClaimAttempts.has(id)) return;
    autoClaimAttempts.add(id);
    void run(candidate, action).catch(() =>
      logger.warn("[marketing-touch] auto claim failed", {
        campaignId: candidate.delivery.campaign_id,
      }),
    );
  }
  const release = (value: PreparedMarketingDelivery | null | undefined) => {
    if (value)
      void value.release().catch(() => logger.warn("[marketing-touch] resource release failed"));
  };
  // 只清掉与本次动作同一份资源引用的待展示 popup；banner 动作不会命中。
  function forgetWaitingPopup(value: Candidate) {
    if (waitingPopup?.release === value.release) {
      release(waitingPopup);
      waitingPopup = null;
    }
  }
  // 只在动作真正成功时上报 confirm；关闭只做本地隐藏，cancel 已从客户端移除。
  function reportConfirmed(value: Candidate) {
    if (disposed) return;
    void options
      .report({
        scope: value.scope,
        campaignId: value.delivery.campaign_id,
        actionType: "confirm",
        locale: options.locale,
      })
      .catch(() =>
        logger.warn("[marketing-touch] action report failed", {
          campaignId: value.delivery.campaign_id,
          actionType: "confirm",
        }),
      );
  }
  function invalidatePendingSnapshot() {
    // 原先按 Campaign 记录历史会拦住服务端重新投放；这里只丢弃操作前的迟到快照。
    generation++;
    release(deferredBanner);
    deferredBanner = undefined;
  }
  async function refresh() {
    const current = ++generation;
    try {
      const snapshot = await options.query();
      if (disposed || current !== generation) return;
      if (snapshotScope && snapshotScope !== snapshot.scope) {
        // 同账号凭据更新也失效旧事件上下文，已打开业务操作不移交给新凭据。
        release(waitingPopup);
        waitingPopup = null;
      }
      snapshotScope = snapshot.scope;
      failureLogged = false;
      const state = store.getState();
      const completed = (d: MarketingDelivery) =>
        completedClaims.has(`${snapshot.scope}:${key(d)}`);
      const bannerWire = snapshot.deliveries.find(
        (d) => d.resource_position === "banner" && !completed(d),
      );
      const popupWire = snapshot.deliveries.find(
        (d) =>
          d.resource_position === "popup" &&
          !completed(d) &&
          // 只避免当前已打开弹窗重复排队，不记录历史展示状态。
          (!state.dialog || state.dialog.result || key(state.dialog.delivery) !== key(d)),
      );
      if (!popupWire || JSON.stringify(waitingPopup?.delivery) !== JSON.stringify(popupWire)) {
        release(waitingPopup);
        waitingPopup = null;
      }
      if (!bannerWire) {
        if (state.pending) {
          release(deferredBanner);
          deferredBanner = null;
        } else {
          release(state.banner);
          store.setState({ banner: null });
        }
      }
      if (
        bannerWire &&
        state.banner &&
        !state.pending &&
        JSON.stringify(state.banner.delivery) !== JSON.stringify(bannerWire)
      ) {
        release(state.banner);
        store.setState({ banner: null });
      }
      await Promise.all(
        snapshot.deliveries.map(async (delivery) => {
          if (delivery !== bannerWire && delivery !== popupWire) return;
          if (
            delivery === bannerWire &&
            JSON.stringify(state.banner?.delivery) === JSON.stringify(delivery)
          ) {
            if (!state.pending && state.banner)
              store.setState({ banner: { ...state.banner, scope: snapshot.scope } });
            return;
          }
          if (delivery === popupWire && waitingPopup) return;
          if (disposed || current !== generation) return;
          let prepared: PreparedMarketingDelivery;
          try {
            prepared = await options.prepare(delivery);
          } catch {
            logger.warn("[marketing-touch] banner resource rejected", {
              campaignId: delivery.campaign_id,
            });
            return;
          }
          if (disposed || current !== generation) {
            release(prepared);
            return;
          }
          const candidate = { ...prepared, scope: snapshot.scope };
          if (delivery.resource_position === "banner") {
            if (store.getState().pending) {
              release(deferredBanner);
              deferredBanner = candidate;
            } else {
              release(store.getState().banner);
              store.setState({ banner: candidate });
            }
          } else {
            release(waitingPopup);
            waitingPopup = candidate;
          }
        }),
      );
      if (disposed || current !== generation) return;
      // 投放物料与新状态都已就绪后再触发，避免用旧快照的 candidate 发起领取。
      const latest = store.getState();
      if (latest.banner && !latest.pending) autoClaim(latest.banner, true);
      if (waitingPopup) autoClaim(waitingPopup, false);
    } catch (error) {
      if (!disposed && current === generation) {
        if (!failureLogged) logger.warn("[marketing-touch] query failed; keeping recent content");
        failureLogged = true;
        // 查询失败不是"领取成功/1003"，绝不能因此撤下福利营销 banner；
        // 网络抖动/接口错误时保留最近一次内容，等下一轮再查。
      }
      throw error;
    }
  }
  async function showPending() {
    const state = store.getState();
    // 错误状态先于 React 弹窗挂载；仅检查 DOM 会让等待中的投放抢先出队并叠加。
    if (
      disposed ||
      state.pending ||
      state.dialog ||
      (state.errorAction === "claim_zcode_plan" && state.error) ||
      !options.canOpen()
    )
      return;
    if (waitingResult) {
      const result = waitingResult;
      waitingResult = null;
      store.setState({ dialog: { ...result, result: true } });
      return;
    }
    if (!waitingPopup) return;
    const candidate = waitingPopup;
    waitingPopup = null;
    store.setState({ dialog: { ...candidate, result: false } });
  }
  async function run(candidate: Candidate, action: MarketingAction) {
    if (disposed || store.getState().pending) return;
    store.setState({ pending: true, phase: "verifying", error: null, errorAction: null });
    let completed = false;
    let succeeded = false;
    try {
      const result = await options.execute(action, lifetime.signal, (phase) => {
        if (!disposed) store.setState({ phase });
      });
      if (disposed) return;
      if (result.status !== "success") {
        // 1003 已领取等价"已拥有"：撤下投放并（execute 内已 best-effort 对账），
        // 不弹失败弹窗、不挂错误，避免出现用户永远点不动的投放。
        if (action.type === "claim_zcode_plan" && result.alreadyClaimed) {
          completed = true;
          completedClaims.add(`${candidate.scope}:${key(candidate.delivery)}`);
          forgetWaitingPopup(candidate);
          invalidatePendingSnapshot();
          const current = store.getState();
          if (current.dialog && current.dialog.release === candidate.release) {
            store.setState({ dialog: null });
            release(current.dialog);
          }
          return result;
        }
        // 其它失败/不确定：保留 banner/popup 供重试，不撤下投放（completed 保持 false）。
        store.setState({ error: result.message ?? null, errorAction: action.type });
        return result;
      }
      completed = action.type !== "copy_text";
      succeeded = true;
      if (action.type === "claim_zcode_plan")
        completedClaims.add(`${candidate.scope}:${key(candidate.delivery)}`);
      invalidatePendingSnapshot();
      reportConfirmed(candidate);
      // 复制是可重复操作；不能沿用领取的完成清理，否则首次复制就会移除内容。
      if (action.type === "copy_text") return result;
      if (
        action.type !== "navigate" &&
        candidate.delivery.resource_position === "banner" &&
        candidate.delivery.banner.success_popup
      ) {
        store.setState({ phase: "preparing" });
        const prepared = await candidate.success;
        if (disposed) return;
        // 业务等待期间也可能打开别的 modal；结果排队到安全展示点，不能直接叠加。
        waitingResult = { ...candidate, hero: prepared?.hero ?? candidate.hero };
      } else {
        // popup 自动领取成功时它还没进入 dialog；先退出待展示队列，
        // 否则 finally 的 showPending 会把刚领取掉的投放又弹出来。
        forgetWaitingPopup(candidate);
        if (store.getState().dialog === candidate) {
          store.setState({ dialog: null });
          release(candidate);
        }
      }
      return result;
    } finally {
      if (!disposed) {
        const state = store.getState();
        const next =
          deferredBanner === undefined
            ? completed && state.banner?.release === candidate.release
              ? null
              : state.banner
            : deferredBanner;
        deferredBanner = undefined;
        if (
          state.banner &&
          state.banner.release !== next?.release &&
          state.banner.release !== state.dialog?.release &&
          state.banner.release !== waitingResult?.release
        )
          release(state.banner);
        store.setState({ pending: false, phase: "idle", banner: next });
        await showPending();
        // 只有领取会改变资格；外链等动作立即查询会与异步 confirm 竞争，使已关闭的旧弹窗重开。
        if (succeeded && action.type === "claim_zcode_plan" && !disposed) options.refresh();
      }
    }
  }
  return {
    store,
    refresh,
    showPending,
    async clickBanner() {
      const candidate = store.getState().banner;
      if (
        !candidate ||
        candidate.delivery.resource_position !== "banner" ||
        store.getState().dialog
      )
        return;
      const action = candidate.delivery.banner.buttons.find(
        (b) => b.action.type !== "close",
      )?.action;
      if (action) await run(candidate, action);
    },
    // banner 的关闭按钮不再移除投放：未领取成功的 banner 必须常驻。
    // 弹窗仍可关闭（本地隐藏、不上报 cancel）。
    async closeDialog() {
      const dialog = store.getState().dialog;
      if (!dialog || store.getState().pending) return;
      invalidatePendingSnapshot();
      store.setState({ dialog: null });
      release(dialog);
    },
    async dialogAction(action: MarketingAction) {
      const dialog = store.getState().dialog;
      if (dialog) return run(dialog, action);
    },
    clearError() {
      store.setState({ error: null, errorAction: null });
    },
    dispose() {
      disposed = true;
      generation++;
      lifetime.abort();
      release(store.getState().banner);
      release(store.getState().dialog);
      release(waitingPopup);
      release(waitingResult);
      release(deferredBanner);
      store.setState({ banner: null, dialog: null, pending: false });
    },
  };
}
export type MarketingTouchController = ReturnType<typeof createMarketingTouchController>;
