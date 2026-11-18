/**
 * dsh-balance-tide — browser half (lazy-CJS 客户端 bundle)。
 *
 * 在 `conversation.composer.dock` 注册一枚读数:
 *   [峰价/谷价/现行价 徽章] [距切换倒计时] | 余额 ¥xx.xx | 本会话约 ¥x.xx | ?
 *
 * - 余额与潮汐: 单例轮询器按服务器下发的 `clientPollIntervalMs` 读取 `/query-tide`
 *   (只读缓存, 不直接访问 DeepSeek); 页面隐藏时暂停轮询。
 * - 倒计时: 组件内每秒本地计时, 基于服务端下发的下一切换时刻。
 * - 本会话消耗: 读取宿主推送的 `queryTideCost` 投影(按当前时段计价)。
 * - 悬停: 当前/切换后各档单价、余额构成、会话消耗、高峰窗口与使用建议;
 *   "?" 图标点击打开官方定价页。
 *
 * (曾有一枚纯客户端估算的"今日约"读数, 按北京日在 localStorage 累计会话花费增量;
 * 多标签页同时打开时对同一 localStorage key 读改写会互相踩踏导致重复计数, 且无法
 * 回溯纠正已经写脏的历史累计值, 已移除。今日花费请以官方账单/CSV 为准。)
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-tide",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = {};
		try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch { /* 宿主无 primitives 时退化 */ }

		//#region styles
		const CSS_ID = "dsh-balance-tide/styles.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-tide";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dshbt_root{text-align:center;box-sizing:border-box;width:100%;max-width:100%;padding:0 8px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;margin:0 auto;font-size:12px;line-height:20px;display:block;overflow:hidden;order:99;flex:1 0 100%}",
				// DSH 0.2.x 的 dock 是单行 flex: 让包含本读数的那一层换行, 读数独占一行排在状态行下方。
				".dshbt_wrap{display:block;width:100%;min-width:0;flex:1 0 100%;order:99}",
				".dshbt_q{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:999px;border:1px solid currentColor;font-size:10px;line-height:1;font-weight:600}",
				".dshbt_sep{color:var(--dsw-alias-separator-primary);margin:0 10px}",
				".dshbt_amount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
				".dshbt_error{color:var(--dsw-alias-state-error-primary)}",
				".dshbt_badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-weight:600;font-size:11px;line-height:1;border:1px solid currentColor;vertical-align:1px}",
				".dshbt_off{color:var(--dsw-alias-state-success-primary,#2e9e5b);background:color-mix(in srgb, currentColor 12%, transparent)}",
				".dshbt_peak{color:var(--dsw-alias-state-warning-primary,#d97706);background:color-mix(in srgb, currentColor 14%, transparent)}",
				".dshbt_flat{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-separator-primary);background:var(--dsw-alias-interactive-bg-hover)}",
				".dshbt_countdown{font-variant-numeric:tabular-nums;margin-left:8px}",
				".dshbt_next{font-variant-numeric:tabular-nums;margin-left:8px;color:var(--dsw-alias-label-tertiary)}",
				".dshbt_pricing{color:var(--dsw-alias-label-tertiary);vertical-align:-2px;display:inline-flex;align-items:center;margin-left:2px;padding:0 2px;border-radius:999px;text-decoration:none}",
				".dshbt_pricing:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}"
			].join("\n");
			document.head.appendChild(tag);
		}
		//#endregion

		//#region formatting
		const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$", EUR: "€" };
		const currencySymbol = (currency) => CURRENCY_SYMBOLS[currency] ?? currency + " ";
		/** 余额/花费显示: 大额 2 位小数, 小额 3~4 位。 */
		function formatMoney(amount, currency) {
			const fixed = amount >= 1 ? 2 : amount >= 0.01 ? 3 : 4;
			return currencySymbol(currency) + amount.toFixed(fixed);
		}
		/** 紧凑 token 数: 517 / 12.2K / 517K / 1.2M。 */
		function formatTokens(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			if (n < 1e3) return String(n);
			if (n < 1e6) return scaled(n / 1e3) + "K";
			return scaled(n / 1e6) + "M";
		}
		/** 北京时间墙钟。 */
		const bj = (ms) => new Date(ms + 8 * 3600e3);
		const bjDayIndex = (ms) => Math.floor((ms + 8 * 3600e3) / 86400e3);
		const pad2 = (n) => String(n).padStart(2, "0");
		const bjHM = (ms) => { const d = bj(ms); return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()); };
		/** 相对日期前缀: 同日为空, 次日"明天", 一周内"周X", 更远"M月D日"。ref 为参照时刻。 */
		function dayPrefix(ms, ref, t) {
			const diff = bjDayIndex(ms) - bjDayIndex(ref);
			if (diff === 0) return "";
			if (diff === 1) return t("day.tomorrow") + " ";
			if (diff > 1 && diff < 7) return t("day.wd" + bj(ms).getUTCDay()) + " ";
			const d = bj(ms);
			return t("day.md", { m: d.getUTCMonth() + 1, d: d.getUTCDate() }) + " ";
		}
		/** 时刻标签: [日期前缀] HH:MM(北京时间)。 */
		const whenLabel = (ms, ref, t) => dayPrefix(ms, ref, t) + bjHM(ms);
		/** 时段区间: 起 – 止, 止与起同日只写时分。 */
		function rangeLabel(from, until, ref, t) {
			if (!Number.isFinite(until)) return whenLabel(from, ref, t) + " " + t("range.onwards");
			return whenLabel(from, ref, t) + "–" + whenLabel(until, from, t);
		}
		function formatClock(ms) {
			if (ms <= 0) return "—";
			return new Date(ms).toLocaleTimeString();
		}
		/** 单价显示: 整数去尾零(¥2 / ¥8), 小数保留 ≤3 位(¥0.2)。 */
		function formatPrice(n, currency) {
			const num = Number(n);
			if (!Number.isFinite(num)) return currencySymbol(currency) + "?";
			return currencySymbol(currency) + (num % 1 === 0 ? String(num) : String(Math.round(num * 1000) / 1000));
		}
		/** 倒计时: 2天3时 / 2时15分 / 45分 / 12秒。 */
		function formatDuration(ms, t) {
			if (!Number.isFinite(ms) || ms < 0) ms = 0;
			const totalSec = Math.floor(ms / 1000);
			const d = Math.floor(totalSec / 86400);
			const h = Math.floor((totalSec % 86400) / 3600);
			const m = Math.floor((totalSec % 3600) / 60);
			if (d > 0) return t("dur.days", { d, h });
			if (h > 0) return t("dur.hours", { h, m });
			if (m > 0) return t("dur.minutes", { m });
			return t("dur.seconds", { s: Math.max(totalSec, 0) });
		}
		/** 服务端下发的错误码集合(有限枚举, 不再透传原始异常文本)。 */
		const ERROR_CODES = new Set([
			"api-key-missing", "bad-base-url", "timeout", "network-error",
			"http-401", "http-402", "http-403", "http-429", "http-error",
			"forbidden", "unknown"
		]);
		/** 三种访问控制拒绝原因对用户是同一件事, 统一成一句人话。 */
		const ACCESS_CODES = new Set(["missing-host", "host-not-allowed", "origin-not-allowed"]);
		/** 错误码 → 本地化文案; 未知码原样显示, 便于排查。 */
		function errorLabel(code, t) {
			if (typeof code !== "string" || code === "") return t("err.unknown");
			if (ACCESS_CODES.has(code)) return t("err.forbidden");
			return ERROR_CODES.has(code) ? t("err." + code) : code;
		}
		/** 官方定价页。 */
		const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
		//#endregion

		//#region tide store (单例轮询器: 全页面共享一个 fetch 循环)
		const DEFAULT_POLL_MS = 30000;
		let snapshot = { status: "loading" };
		const listeners = new Set();
		let timer = null;
		let pollMs = DEFAULT_POLL_MS;
		let inflight = null;
		let started = false;

		function notify() {
			for (const fn of [...listeners]) fn();
		}

		async function refresh() {
			if (inflight !== null) return inflight;
			inflight = (async () => {
				try {
					const res = await fetch("/query-tide", {
						cache: "no-store",
						credentials: "same-origin",
						headers: { accept: "application/json" }
					});
					if (!res.ok) {
						// 403 来自服务端的同源 / Host 校验, 值得单独提示而非笼统的 HTTP 错误。
						throw Object.assign(new Error("HTTP " + res.status), {
							code: res.status === 403 ? "forbidden" : "http-error"
						});
					}
					const data = await res.json();
					if (typeof data.clientPollIntervalMs === "number" && data.clientPollIntervalMs >= 5000) {
						pollMs = Math.min(data.clientPollIntervalMs, 3600000);
					}
					snapshot = { status: "ok", payload: data, at: Date.now() };
				} catch (error) {
					snapshot = {
						status: "error",
						code: error?.code ?? "network-error",
						at: Date.now()
					};
				}
				inflight = null;
				notify();
			})();
			return inflight;
		}

		function schedule() {
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				if (document.hidden) return; // 页面隐藏时暂停; 由 visibilitychange 恢复
				refresh().then(schedule, schedule);
			}, pollMs);
		}

		const tideStore = {
			subscribe(fn) {
				listeners.add(fn);
				if (!started) {
					started = true;
					refresh().then(schedule, schedule);
				}
				return () => {
					listeners.delete(fn);
					if (listeners.size === 0) {
						started = false;
						if (timer !== null) {
							clearTimeout(timer);
							timer = null;
						}
					}
				};
			},
			getSnapshot() {
				return snapshot;
			}
		};
		//#endregion

		//#region locale
		const NS = "queryTide";
		const zh = {
			"phase.flat": "现行价",
			"phase.peak": "高峰",
			"phase.offpeak": "低峰",
			"phase.flatFull": "现行统一价",
			"phase.peakFull": "高峰时段",
			"phase.offpeakFull": "低峰时段",
			"countdown.flat": "峰谷计价 {time} 后生效",
			"countdown.peak": "距低峰 {time}",
			"countdown.offpeak": "距高峰 {time}",
			"ends": "至 {when} 结束 · 剩 {left}",
			"nextRange": "下个{label} {range}",
			"range.onwards": "起",
			"day.tomorrow": "明天",
			"day.md": "{m}月{d}日",
			"day.wd0": "周日", "day.wd1": "周一", "day.wd2": "周二", "day.wd3": "周三",
			"day.wd4": "周四", "day.wd5": "周五", "day.wd6": "周六",
			"dayType.weekend": "今天是周末, 全天低峰",
			"dayType.holiday": "今天是法定节假日({name}), 全天低峰",
			"tip.schedule": "当前{label}: {since} 起, 预计 {end} 结束\n下个{nextLabel}: {nextRange}",
			"tip.rule": "规则: 周一至周五(不含法定节假日) 09:00-12:00、14:00-18:00 为高峰, 其余时段及周末、法定节假日全天为低峰(北京时间)",
			"balance": "余额 {amount}",
			"balanceError": "余额不可用",
			"balanceMissing": "未配置 API Key",
			"sessionCost": "本会话 {amount}",
			"tip.tide": "当前时段: {label} · {countdown}",
			"tip.flatNote": "峰谷定价将于 2026-08-17 00:00(北京时间)生效, 空闲时段价格为高峰的一半",
			"tip.currentPrices": "当前价(每 1M token · {currency}):\n{models}",
			"tip.nextPrices": "切换后({label}, 每 1M token):\n{models}",
			"tip.pricingModel": "{model}: 命中 {hit} · 未命中 {miss} · 输出 {output}",
			"tip.balance": "余额: 总额 {total} · 赠送 {granted} · 充值 {toppedUp}\n状态: {status} · 更新于 {time}",
			"tip.statusAvailable": "可用",
			"tip.statusUnavailable": "不足",
			"tip.cost": "本会话消耗(估算, 按当前时段计价): {amount}\n{models}\n输入 {input} tok · 输出 {output} tok",
			"tip.costModel": "{model}: {amount}",
			"tip.billingNote": "估算值仅供参考, 实际扣费以官方账单为准",
			"tip.balanceOther": "其他币种: {list}",
			"tip.error": "获取失败: {error}",
			"err.api-key-missing": "未配置 API Key",
			"err.bad-base-url": "baseUrl 配置无效(必须为 https)",
			"err.timeout": "请求超时",
			"err.network-error": "网络错误",
			"err.http-401": "API Key 无效 (401)",
			"err.http-402": "账户余额不足 (402)",
			"err.http-403": "无访问权限 (403)",
			"err.http-429": "请求过于频繁 (429)",
			"err.http-error": "接口返回错误",
			"err.forbidden": "读取被拒绝: 来源跨源, 或 Host 不在 allowedHosts 中",
			"err.unknown": "未知错误",
			"tip.gap": "峰谷差距: 高峰价 = 低峰价 × 2",
			"tip.advice": "💡 高峰时段价格为低峰的 2 倍, 大任务尽量放到低峰跑",
			"pricing.aria": "查看 DeepSeek 官方定价策略",
			"model.unknown": "未知模型",
			"model.other": "其他模型",
			"unit.minutes": "{n} 分钟",
			"unit.seconds": "{n} 秒",
			"dur.days": "{d}天{h}时",
			"dur.hours": "{h}时{m}分",
			"dur.minutes": "{m}分",
			"dur.seconds": "{s}秒"
		};
		const en = {
			"phase.flat": "standard",
			"phase.peak": "peak",
			"phase.offpeak": "off-peak",
			"phase.flatFull": "Standard pricing",
			"phase.peakFull": "Peak pricing",
			"phase.offpeakFull": "Off-peak pricing",
			"countdown.flat": "peak pricing starts in {time}",
			"countdown.peak": "off-peak in {time}",
			"countdown.offpeak": "peak in {time}",
			"ends": "ends {when} · {left} left",
			"nextRange": "next {label} {range}",
			"range.onwards": "onwards",
			"day.tomorrow": "tmrw",
			"day.md": "{m}/{d}",
			"day.wd0": "Sun", "day.wd1": "Mon", "day.wd2": "Tue", "day.wd3": "Wed",
			"day.wd4": "Thu", "day.wd5": "Fri", "day.wd6": "Sat",
			"dayType.weekend": "Weekend: off-peak all day",
			"dayType.holiday": "Public holiday ({name}): off-peak all day",
			"tip.schedule": "Current {label}: since {since}, ends {end}\nNext {nextLabel}: {nextRange}",
			"tip.rule": "Rule: Mon–Fri (excl. CN public holidays) 09:00-12:00 & 14:00-18:00 are peak; everything else incl. weekends/holidays is off-peak (Beijing time)",
			"balance": "Balance {amount}",
			"balanceError": "Balance unavailable",
			"balanceMissing": "API key not configured",
			"sessionCost": "~{amount} this session",
			"tip.tide": "Now: {label} · {countdown}",
			"tip.flatNote": "Peak/off-peak pricing takes effect 2026-08-17 00:00 (Beijing), off-peak is half of peak",
			"tip.currentPrices": "Current prices (per 1M tokens · {currency}):\n{models}",
			"tip.nextPrices": "After switch ({label}, per 1M tokens):\n{models}",
			"tip.pricingModel": "{model}: hit {hit} · miss {miss} · output {output}",
			"tip.balance": "Balance: total {total} · granted {granted} · topped up {toppedUp}\nStatus: {status} · updated {time}",
			"tip.statusAvailable": "available",
			"tip.statusUnavailable": "insufficient",
			"tip.cost": "This session (est., current period): {amount}\n{models}\nInput {input} tok · Output {output} tok",
			"tip.costModel": "{model}: {amount}",
			"tip.billingNote": "Estimate only — the official invoice is authoritative",
			"tip.balanceOther": "Other currencies: {list}",
			"tip.error": "Fetch failed: {error}",
			"err.api-key-missing": "API key not configured",
			"err.bad-base-url": "Invalid baseUrl (https required)",
			"err.timeout": "Request timed out",
			"err.network-error": "Network error",
			"err.http-401": "Invalid API key (401)",
			"err.http-402": "Insufficient balance (402)",
			"err.http-403": "Access denied (403)",
			"err.http-429": "Rate limited (429)",
			"err.http-error": "API returned an error",
			"err.forbidden": "Read refused: cross-origin, or Host not in allowedHosts",
			"err.unknown": "Unknown error",
			"tip.gap": "Peak/off-peak gap: peak = off-peak × 2 (legacy pricing not affected)",
			"tip.advice": "💡 Peak hours cost 2× off-peak — plan your usage accordingly",
			"pricing.aria": "View the official DeepSeek pricing",
			"model.unknown": "unknown model",
			"model.other": "other models",
			"unit.minutes": "{n} min",
			"unit.seconds": "{n} s",
			"dur.days": "{d}d {h}h",
			"dur.hours": "{h}h {m}m",
			"dur.minutes": "{m}m",
			"dur.seconds": "{s}s"
		};
		//#endregion

		//#region component
		function formatInterval(ms, t) {
			const minutes = Math.round(ms / 60000);
			return minutes >= 1 ? t("unit.minutes", { n: minutes }) : t("unit.seconds", { n: Math.round(ms / 1000) });
		}

		/**
		 * 余额 + 潮汐读数: 徽章(峰/谷/现行) + 倒计时 + 余额 + 本会话花费。
		 * 独立一行居中显示, 不做任何负 margin 对齐(避免与底部文字重叠)。
		 */
		/** 宿主缺 Tooltip 时退化为原生 title, 不让整行因依赖缺失而崩掉。 */
		function SafeTooltip(props) {
			if (primitives && typeof primitives.Tooltip === "function" || (primitives && typeof primitives.Tooltip === "object")) {
				return react.createElement(primitives.Tooltip, { portal: true, ...props });
			}
			const child = props.children;
			return react.isValidElement(child) ? react.cloneElement(child, { title: props.label }) : child;
		}
		/** 宿主未注入 useProjection 时的占位(保持 hooks 调用次序稳定)。 */
		const noProjection = () => undefined;

		const TideReadout = react.memo(function TideReadout({ useProjection, t }) {
			const project = typeof useProjection === "function" ? useProjection : noProjection;
			// 宿主未注入 t 时用内置中文词典兜底。
			if (typeof t !== "function") t = (key, vars) => String(zh[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? "");
			const cost = project("queryTideCost");
			const usage = project("tokenUsage");
			const snap = react.useSyncExternalStore(tideStore.subscribe, tideStore.getSnapshot, tideStore.getSnapshot);
			const [pricingHover, setPricingHover] = react.useState(false);
			// 换行到默认状态行下方: 找到包住本读数的最近 flex 容器, 让它换行,
			// 并让本读数所在的那个直接子项独占一整行、排在最后。
			// 宿主 CSS 类名是哈希的, 所以用运行时查找而不是写死选择器。
			const wrapRef = react.useRef(null);
			react.useLayoutEffect(() => {
				const el = wrapRef.current;
				if (el === null) return;
				const dock = el.closest("[data-composer-dock]");
				let item = el;
				let box = el.parentElement;
				while (box !== null && box !== document.body) {
					const display = getComputedStyle(box).display;
					if (display === "flex" || display === "inline-flex") break;
					if (box === dock) { box = null; break; }
					item = box;
					box = box.parentElement;
				}
				if (box === null || box === document.body) return;
				const saved = [box.style.flexWrap, box.style.rowGap, item.style.flex, item.style.order, item.style.minWidth];
				box.style.flexWrap = "wrap";
				box.style.rowGap = "2px";
				item.style.flex = "1 0 100%";
				item.style.order = "99";
				item.style.minWidth = "0";
				return () => {
					[box.style.flexWrap, box.style.rowGap, item.style.flex, item.style.order, item.style.minWidth] = saved;
				};
			}, []);
			const [, setTick] = react.useState(0);
			// 有效会话成本: 优先服务端 queryTideCost; 若为 0/缺失, 用可靠的 tokenUsage + 当前单价兜底重算。
			let sessCost = 0;
			let sessTokens = null;
			if (cost !== undefined && cost.cost > 0) {
				sessCost = cost.cost;
				sessTokens = cost.tokens;
			} else if (usage !== undefined) {
				const inp = (usage.uncachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
				const hit = usage.cacheReadTokens ?? 0;
				const out = usage.outputTokens ?? 0;
				if (inp + hit + out > 0) {
					const tideObj = snap.payload?.tide;
					const prices = (tideObj && typeof tideObj === "object") ? (tideObj.currentPrices ?? {}) : {};
					const def = snap.payload?.defaultPrices ?? { cacheHit: 0.1, cacheMiss: 1, output: 2 };
					const model = (cost?.models ?? []).find((m) => (cost?.costByModel?.[m] ?? 0) > 0) ?? (cost?.models ?? [])[0];
					const p = (model && prices[model]) || def;
					sessCost = ((inp * p.cacheMiss) + (hit * p.cacheHit) + (out * p.output)) / 1e6;
					sessTokens = { uncachedInput: usage.uncachedInputTokens ?? 0, cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0, output: usage.outputTokens ?? 0 };
				}
			}
			// 每秒 tick 一次, 驱动倒计时刷新。
			react.useEffect(() => {
				const id = setInterval(() => setTick((x) => x + 1), 1000);
				return () => clearInterval(id);
			}, []);

			const groups = [];
			const tooltipLines = [];

			// —— 潮汐段(独立于余额, 只要 /query-tide 可达就显示) ——
			if (snap.status === "ok" && snap.payload !== null && snap.payload.tide !== null && typeof snap.payload.tide === "object") {
				const tide = snap.payload.tide;
				const phase = tide.phase ?? "flat";
				const badgeCls = phase === "peak" ? "dshbt_peak" : phase === "offpeak" ? "dshbt_off" : "dshbt_flat";
				const label = t("phase." + phase);
				const now = Date.now();
				const nextAt = tide.next?.at ?? 0;
				const remaining = nextAt - now;
				// 切换时刻已过但服务端快照还没更新: 立即拉一次, 避免显示过期档位。
				if (remaining <= 0 && snap.status === "ok" && snap.at < nextAt) void refresh();
				const countdown = t("countdown." + phase, { time: formatDuration(remaining, t) });
				const nextPhase = tide.next?.phase ?? (phase === "peak" ? "offpeak" : "peak");
				const nextLabel = t("phase." + nextPhase);
				const nextRange = rangeLabel(nextAt, tide.next?.until, now, t);

				groups.push(react.createElement("span", { className: "dshbt_badge " + badgeCls, key: "tide" }, label));
				if (phase === "flat") {
					groups.push(react.createElement("span", { className: "dshbt_countdown", key: "cd" }, countdown));
				} else {
					groups.push(react.createElement("span", { className: "dshbt_countdown", key: "cd" },
						t("ends", { when: whenLabel(nextAt, now, t), left: formatDuration(remaining, t) })));
					groups.push(react.createElement("span", { className: "dshbt_next", key: "nx" },
						t("nextRange", { label: nextLabel, range: nextRange })));
				}

				const fullLabel = t("phase." + phase + "Full");
				tooltipLines.push(t("tip.tide", { label: fullLabel, countdown }));
				if (phase !== "flat" && Number.isFinite(tide.since)) {
					tooltipLines.push(t("tip.schedule", {
						label: fullLabel,
						since: whenLabel(tide.since, now, t),
						end: whenLabel(nextAt, now, t),
						nextLabel: t("phase." + nextPhase + "Full"),
						nextRange
					}));
				}
				if (tide.day?.type === "weekend") tooltipLines.push(t("dayType.weekend"));
				if (tide.day?.type === "holiday") tooltipLines.push(t("dayType.holiday", { name: tide.day.name || "—" }));
				tooltipLines.push(t("tip.rule"));
				if (tide.note === "tide-not-started") {
					tooltipLines.push(t("tip.flatNote"));
				}

				// 当前档与切换后档的单价表。
				const currency = typeof snap.payload.currency === "string" ? snap.payload.currency : "CNY";
				const priceLines = (table, titleKey, labelForNext) => {
					if (table === null || typeof table !== "object") return;
					const lines = [];
					for (const [model, p] of Object.entries(table)) {
						if (p !== null && typeof p === "object") {
							lines.push(t("tip.pricingModel", {
								model,
								hit: formatPrice(p.cacheHit, currency),
								miss: formatPrice(p.cacheMiss, currency),
								output: formatPrice(p.output, currency)
							}));
						}
					}
					if (lines.length > 0) {
						tooltipLines.push(t(titleKey, { currency, label: labelForNext, models: lines.join("\n") }));
					}
				};
				priceLines(tide.currentPrices, "tip.currentPrices", "");
				if (tide.next?.phase !== undefined && tide.next.phase !== phase) {
					priceLines(tide.nextPrices, "tip.nextPrices", t("phase." + tide.next.phase + "Full"));
				}

				// 峰谷差距(生效后): 恒在建议行之前。
				if (tide.phase !== "flat") {
					tooltipLines.push(t("tip.gap"));
				}

				// 使用建议恒在潮汐段末尾。
				tooltipLines.push(t("tip.advice"));
			}

			// —— 余额段 ——
			if (snap.status === "ok") {
				const info = snap.payload;
				if (info.ok === true && Array.isArray(info.balances) && info.balances.length > 0) {
					const primary = info.balances[0];
					const amount = formatMoney(primary.total, primary.currency);
					groups.push(react.createElement("span", { className: "dshbt_amount", key: "bal" }, t("balance", { amount })));
					const status = info.isAvailable === true ? t("tip.statusAvailable") : t("tip.statusUnavailable");
					tooltipLines.push(t("tip.balance", {
						total: formatMoney(primary.total, primary.currency),
						granted: formatMoney(primary.granted, primary.currency),
						toppedUp: formatMoney(primary.toppedUp, primary.currency),
						status,
						time: formatClock(info.fetchedAt)
					}));
					// 多币种账户: 主行只放首个, 其余进悬停明细, 避免整行被撑爆。
					if (info.balances.length > 1) {
						const others = info.balances.slice(1)
							.map((b) => formatMoney(b.total, b.currency))
							.join(" · ");
						tooltipLines.push(t("tip.balanceOther", { list: others }));
					}
					if (info.stale === true && typeof info.error === "string") {
						tooltipLines.push(t("tip.error", { error: errorLabel(info.error, t) }));
					}
				} else {
					const message = info.error === "api-key-missing" ? t("balanceMissing") : t("balanceError");
					groups.push(react.createElement("span", { className: "dshbt_error", key: "bal" }, message));
					if (typeof info.error === "string") {
						tooltipLines.push(t("tip.error", { error: errorLabel(info.error, t) }));
					}
				}
			} else if (snap.status === "error") {
				const message = snap.code === "api-key-missing" ? t("balanceMissing") : t("balanceError");
				groups.push(react.createElement("span", { className: "dshbt_error", key: "bal" }, message));
				tooltipLines.push(t("tip.error", { error: errorLabel(snap.code, t) }));
			}

			// —— 本会话花费段 ——
			if (sessCost > 0) {
				const ccy = cost?.currency ?? "CNY";
				const amount = formatMoney(sessCost, ccy);
				groups.push(react.createElement("span", { key: "cost" }, t("sessionCost", { amount })));
				const tks = sessTokens ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
				const modelLines = (cost?.models ?? [])
					.filter((model) => (cost?.costByModel?.[model] ?? 0) > 0)
					.map((model) => t("tip.costModel", {
						model: model === "unknown" ? t("model.unknown") : model,
						amount: formatMoney(cost.costByModel[model], ccy)
					}));
				tooltipLines.push(t("tip.cost", {
					amount,
					models: modelLines.length > 0 ? modelLines.join("\n") : "",
					input: formatTokens((tks.uncachedInput ?? 0) + (tks.cacheRead ?? 0) + (tks.cacheWrite ?? 0)),
					output: formatTokens(tks.output ?? 0)
				}));
				tooltipLines.push(t("tip.billingNote"));
			}

			// —— "?" 图标: 点击打开官方定价页 ——
			groups.push(react.createElement(SafeTooltip, {
				key: "pricing",
				label: t("pricing.aria"),
				side: "top",
				delayMs: 300,
				children: react.createElement("a", {
					className: "dshbt_pricing",
					href: PRICING_URL,
					target: "_blank",
					rel: "noreferrer",
					"aria-label": t("pricing.aria"),
					title: t("pricing.aria"),
					onMouseEnter: () => setPricingHover(true),
					onMouseLeave: () => setPricingHover(false),
					// 0.2.x 移除了 IconQuestionOutline14, 改用纯 CSS 圆圈问号, 不依赖宿主图标集。
					children: react.createElement("span", { className: "dshbt_q", "aria-hidden": true }, "?")
				})
			}));

			if (groups.length === 0) return null;

			const line = groups.map((node, i) => react.createElement(react.Fragment, { key: i }, i > 0 ? react.createElement("span", {
				className: "dshbt_sep",
				"aria-hidden": true
			}, "|") : null, node));

			return react.createElement("div", {
				ref: wrapRef,
				className: "dshbt_wrap",
				children: react.createElement(SafeTooltip, {
					label: tooltipLines.length > 0 ? tooltipLines.join("\n") : "",
					side: "top",
					delayMs: 500,
					disabled: tooltipLines.length === 0 || pricingHover,
					children: react.createElement("div", {
						className: "dshbt_root",
						children: line
					})
				})
			});
		});
		//#endregion

		//#region plugin
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-balance-tide: dictionaries");
			// 等待 ui-conversation 声明 composer.dock 槽位后再注册本条目。
			ctx.slots.inject("conversation.composer.dock", () => {
				const dispose = ctx.slots.register({
					name: "conversation.composer.dock",
					id: "dsh-balance-tide",
					order: 1,
					locale: NS
				}, TideReadout);
				return () => {
					dispose();
				};
			});
			// 页面回到前台时立即刷新一次, 并在隐藏期间跳过定时器。
			// 必须先确认 store 已有订阅者(started): 否则这里会拉起一条没人消费、
			// 也永远不会被 unsubscribe 停掉的轮询循环, 架空 store 的按需启停。
			ctx.effect(() => {
				const onVisibility = () => {
					if (!document.hidden && started) refresh().then(schedule, schedule);
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => document.removeEventListener("visibilitychange", onVisibility);
			}, "dsh-balance-tide: visibility resume");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
