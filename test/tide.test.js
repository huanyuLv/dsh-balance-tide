/**
 * 峰谷时段判定与价格查表的回归测试。
 * 时间断言一律用带 +08:00 偏移的字面量, 不依赖跑测试的机器时区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Config, TIDE_CUTOFF_MS, WEEKEND_CUTOFF_MS, PEAK_WINDOWS_BJT, TIDE_PRICES,
  computeTide, priceOf, describeWindows, resolveCutoff,
} from '../src/index.js'

const at = (iso) => Date.parse(iso)
/** 把绝对时刻还原成北京时间字面量, 便于断言可读。 */
const bjt = (t) => new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

test('cutoff 常量对应北京时间 2026-08-17 00:00', () => {
  assert.equal(TIDE_CUTOFF_MS, at('2026-08-17T00:00:00+08:00'))
})

test('生效前恒为现行价, 并指向 cutoff', () => {
  const r = computeTide(at('2026-08-16T20:00:00+08:00'))
  assert.equal(r.phase, 'flat')
  assert.equal(r.isPeak, null)
  assert.equal(r.note, 'tide-not-started')
  assert.equal(r.next.at, TIDE_CUTOFF_MS)
  // cutoff 当刻是 00:00, 落在低谷。
  assert.equal(r.next.phase, 'offpeak')
})

test('cutoff 当刻即进入潮汐体系', () => {
  const r = computeTide(TIDE_CUTOFF_MS)
  assert.equal(r.phase, 'offpeak')
  assert.equal(r.note, 'ok')
})

test('官方时段表逐段判定与下一次切换时刻', () => {
  const cases = [
    ['2026-08-17T00:00:00+08:00', 'offpeak', '2026-08-17 09:00', 'peak'],
    ['2026-08-17T08:59:00+08:00', 'offpeak', '2026-08-17 09:00', 'peak'],
    ['2026-08-17T09:00:00+08:00', 'peak', '2026-08-17 12:00', 'offpeak'],
    ['2026-08-17T11:59:00+08:00', 'peak', '2026-08-17 12:00', 'offpeak'],
    ['2026-08-17T12:00:00+08:00', 'offpeak', '2026-08-17 14:00', 'peak'],
    ['2026-08-17T13:59:00+08:00', 'offpeak', '2026-08-17 14:00', 'peak'],
    ['2026-08-17T14:00:00+08:00', 'peak', '2026-08-17 18:00', 'offpeak'],
    ['2026-08-17T17:59:00+08:00', 'peak', '2026-08-17 18:00', 'offpeak'],
    ['2026-08-17T18:00:00+08:00', 'offpeak', '2026-08-18 09:00', 'peak'],
    ['2026-08-17T23:59:00+08:00', 'offpeak', '2026-08-18 09:00', 'peak'],
  ]
  for (const [iso, phase, nextAt, nextPhase] of cases) {
    const r = computeTide(at(iso))
    assert.equal(r.phase, phase, `${iso} 档位`)
    assert.equal(r.isPeak, phase === 'peak', `${iso} isPeak`)
    assert.equal(bjt(r.next.at), nextAt, `${iso} 切换时刻`)
    assert.equal(r.next.phase, nextPhase, `${iso} 切换后档位`)
  }
})

test('夜间切换跨日 / 跨月 / 跨年', () => {
  assert.equal(bjt(computeTide(at('2026-08-31T23:30:00+08:00')).next.at), '2026-09-01 09:00')
  assert.equal(bjt(computeTide(at('2026-12-31T23:30:00+08:00')).next.at), '2027-01-01 09:00')
  // 闰年 2 月末。
  assert.equal(bjt(computeTide(at('2028-02-28T20:00:00+08:00')).next.at), '2028-02-29 09:00')
})

test('切换时刻恒在未来', () => {
  const start = at('2026-08-17T00:00:00+08:00')
  for (let i = 0; i < 24 * 40; i++) {
    const t = start + i * 3600e3
    const r = computeTide(t)
    assert.ok(r.next.at > t, `${bjt(t)} 的 next 应严格大于当前时刻`)
    // 切换后的档位必然与当前不同, 否则倒计时归零后画面不会变。
    assert.notEqual(r.next.phase, r.phase, `${bjt(t)} 切换前后档位应不同`)
  }
})

test('weekend cutoff 常量对应北京时间 2026-08-23 00:00', () => {
  assert.equal(WEEKEND_CUTOFF_MS, at('2026-08-23T00:00:00+08:00'))
})

test('周末全天低谷: 峰段时间落在周六日也按低谷计价', () => {
  const cases = [
    ['2026-08-23T09:30:00+08:00', 'offpeak'], // 周日, 原 09:00-12:00 峰段
    ['2026-08-23T15:00:00+08:00', 'offpeak'], // 周日, 原 14:00-18:00 峰段
    ['2026-08-29T10:00:00+08:00', 'offpeak'], // 周六
    ['2026-08-24T09:30:00+08:00', 'peak'], // 周一, 不受影响
    ['2026-08-28T15:00:00+08:00', 'peak'], // 周五, 不受影响
  ]
  for (const [iso, phase] of cases) {
    const r = computeTide(at(iso))
    assert.equal(r.phase, phase, `${iso} 档位`)
    assert.equal(r.isPeak, phase === 'peak', `${iso} isPeak`)
  }
})

test('新规生效前的周末仍按旧规则, 不追溯改价', () => {
  // 2026-08-22 是周六, 但在生效时刻之前 —— 历史账单重算拿的是当时的时刻,
  // 无条件打折会把之前那些周末的账悄悄改小。
  const r = computeTide(at('2026-08-22T09:30:00+08:00'))
  assert.equal(r.phase, 'peak')
  assert.equal(bjt(r.next.at), '2026-08-22 12:00')
  // 生效当刻起立即改判。
  assert.equal(computeTide(WEEKEND_CUTOFF_MS).phase, 'offpeak')
})

test('周末按北京日历判定, 不是 UTC 日历', () => {
  // 北京的周末从周五 16:00 UTC 到周日 16:00 UTC; 两份日历只在 16:00-24:00 UTC
  // 这一段对不上, 而官方两个峰段窗口都不在这一段里 —— 用未平移的时刻取星期几,
  // 官方窗口下的用例全都能过。这里换一个覆盖该时段的窗口才钉得住。
  const opts = { cutoff: 0, peakWindows: [{ start: 0, end: 6 }] }
  // 北京 2026-08-29 00:30(周六) = UTC 2026-08-28 16:30(周五)。
  assert.equal(computeTide(at('2026-08-29T00:30:00+08:00'), opts).phase, 'offpeak')
  // 北京 2026-08-31 00:30(周一) = UTC 2026-08-30 16:30(周日), 已不算周末。
  assert.equal(computeTide(at('2026-08-31T00:30:00+08:00'), opts).phase, 'peak')
})

test('倒计时跳过整个周末, 指向周一开盘', () => {
  // 周末两侧都是低谷, 周末里的边界跨过去画面不变; 返回当天那个旧数字
  // 等于承诺一个不会发生的切换。
  assert.equal(bjt(computeTide(at('2026-08-28T18:30:00+08:00')).next.at), '2026-08-31 09:00')
  assert.equal(bjt(computeTide(at('2026-08-29T10:00:00+08:00')).next.at), '2026-08-31 09:00')
  assert.equal(computeTide(at('2026-08-29T10:00:00+08:00')).next.phase, 'peak')
})

test('自定义窗口: 官方调整时段后无需改代码', () => {
  const windows = [{ start: 0, end: 6 }]
  const opts = { cutoff: 0, peakWindows: windows }
  assert.equal(computeTide(at('2026-08-17T03:00:00+08:00'), opts).phase, 'peak')
  assert.equal(computeTide(at('2026-08-17T07:00:00+08:00'), opts).phase, 'offpeak')
  assert.equal(bjt(computeTide(at('2026-08-17T03:00:00+08:00'), opts).next.at), '2026-08-17 06:00')
  assert.equal(bjt(computeTide(at('2026-08-17T07:00:00+08:00'), opts).next.at), '2026-08-18 06:00')
})

test('未提供窗口时回退到官方默认', () => {
  for (const peakWindows of [null, undefined]) {
    const r = computeTide(at('2026-08-17T10:00:00+08:00'), { cutoff: 0, peakWindows })
    assert.equal(r.phase, 'peak', `peakWindows=${peakWindows} 应回退到官方窗口`)
  }
})

test('空窗口 / 全部非法的窗口退化为全天低谷, 而不是抛错', () => {
  // 例如官方日后取消峰谷定价, 用户配 peakWindows: [] 即可, 无需卸插件。
  for (const peakWindows of [[], [{ start: 12, end: 9 }], [{ start: 'x', end: 3 }], [{ start: 5 }]]) {
    const r = computeTide(at('2026-08-17T10:00:00+08:00'), { cutoff: 0, peakWindows })
    assert.equal(r.phase, 'offpeak', `peakWindows=${JSON.stringify(peakWindows)}`)
    assert.ok(Number.isFinite(r.next.at))
    assert.ok(r.next.at > at('2026-08-17T10:00:00+08:00'))
  }
})

test('describeWindows 输出官方口径的窗口描述', () => {
  assert.equal(describeWindows(PEAK_WINDOWS_BJT), '09:00-12:00 / 14:00-18:00')
  assert.equal(describeWindows([]), '—')
})

test('resolveCutoff 接受字符串, 非法值回退官方值', () => {
  assert.equal(resolveCutoff(''), TIDE_CUTOFF_MS)
  assert.equal(resolveCutoff('not-a-date'), TIDE_CUTOFF_MS)
  assert.equal(resolveCutoff(undefined), TIDE_CUTOFF_MS)
  assert.equal(resolveCutoff('2027-01-01T00:00:00+08:00'), at('2027-01-01T00:00:00+08:00'))
})

test('价格表与官方定价页一致', () => {
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ (2026-08 版)
  assert.deepEqual(TIDE_PRICES.flat['deepseek-v4-flash'], { cacheHit: 0.02, cacheMiss: 1, output: 2 })
  assert.deepEqual(TIDE_PRICES.flat['deepseek-v4-pro'], { cacheHit: 0.025, cacheMiss: 3, output: 6 })
  assert.deepEqual(TIDE_PRICES.offpeak['deepseek-v4-flash'], { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 })
  assert.deepEqual(TIDE_PRICES.offpeak['deepseek-v4-pro'], { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 })
  assert.deepEqual(TIDE_PRICES.peak['deepseek-v4-flash'], { cacheHit: 0.1, cacheMiss: 3, output: 9 })
  assert.deepEqual(TIDE_PRICES.peak['deepseek-v4-pro'], { cacheHit: 0.3, cacheMiss: 9, output: 27 })
  // 官方口径: 空闲价 = 高峰价的一半。
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    for (const field of ['cacheHit', 'cacheMiss', 'output']) {
      assert.equal(TIDE_PRICES.offpeak[model][field] * 2, TIDE_PRICES.peak[model][field],
        `${model}.${field} 应满足 峰价 = 谷价 × 2`)
    }
  }
})

test('priceOf 按档位取价, 逐级回退', () => {
  const config = Config({})
  assert.deepEqual(priceOf(config, 'deepseek-v4-pro', 'peak'), TIDE_PRICES.peak['deepseek-v4-pro'])
  assert.deepEqual(priceOf(config, 'deepseek-v4-pro', 'flat'), TIDE_PRICES.flat['deepseek-v4-pro'])
  // 历史模型不参与峰谷, 回退到静态表。
  assert.deepEqual(priceOf(config, 'deepseek-chat', 'peak'), config.prices['deepseek-chat'])
  // 完全未知的模型回退到 defaultPrices。
  assert.deepEqual(priceOf(config, 'llama-42b', 'peak'), config.defaultPrices)
})

test('priceOf 不被原型链上的属性名穿透', () => {
  const config = Config({})
  // 旧实现用 `model in table` + 裸索引, 这些名字会取到 Object.prototype 上的函数,
  // 令后续算术全部变成 NaN。
  for (const model of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const p = priceOf(config, model, 'peak')
    assert.equal(typeof p, 'object', `${model} 应返回价格对象`)
    assert.ok(Number.isFinite(p.cacheMiss), `${model} 的 cacheMiss 应是有限数`)
    assert.deepEqual(p, config.defaultPrices, `${model} 应回退到 defaultPrices`)
  }
})
