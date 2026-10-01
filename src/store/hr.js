import { defineStore } from 'pinia'

const BASE = '/api'
// 当前登录身份（演示环境顶栏切换，持久化到 localStorage）；每次请求携带供服务端做角色权限校验
let currentUserId = localStorage.getItem('hr-user-id') || 'u-sandy'
async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json', 'x-user-id': currentUserId } }
  if (body !== undefined) opt.body = JSON.stringify(body)
  let r
  try {
    r = await fetch(BASE + path, opt)
  } catch {
    throw Object.assign(new Error('网络异常，请稍后重试'), { code: 'network' })
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.msg || '操作失败'), { code: data.code || `http_${r.status}`, data })
  return data
}

export const useHrStore = defineStore('hr', {
  state: () => ({
    data: null,
    loaded: false,
    userId: currentUserId,
    // 全局轻提示：服务端 4xx 约束（重复操作/状态冲突/乐观锁）统一在此提示，保证各页面口径一致
    toast: null,
    // 进行中的操作键（如 advance:3）：按钮置灰，防止重复点击/并发提交
    pending: {}
  }),
  getters: {
    positions: s => s.data?.positions || [],
    candidates: s => s.data?.candidates || [],
    applications: s => s.data?.applications || [],
    interviews: s => s.data?.interviews || [],
    offers: s => s.data?.offers || [],
    offerLogs: s => s.data?.offerLogs || [],
    channels: s => s.data?.channels || [],
    matches: s => s.data?.matches || [],
    strategyVersions: s => s.data?.strategyVersions || [],
    recalcJobs: s => s.data?.recalcJobs || [],
    recalcItems: s => s.data?.recalcItems || [],
    users: s => s.data?.users || [],
    approvals: s => s.data?.approvals || [],
    notifications: s => s.data?.notifications || [],
    defaultStrategy: s => s.data?.defaultStrategy || { weights: { skill: 0.4, year: 0.2, salary: 0.15, edu: 0.15, city: 0.1 }, keywordCap: 5 },
    openPositions: s => (s.data?.positions || []).filter(p => p.status === 'open'),
    isBusy: s => key => !!s.pending[key],
    // 当前身份与角色能力：关键动作（提请推进/给结论/发起 Offer/审批）按角色在 UI 层前置拦截
    currentUser(s) { return (s.data?.users || []).find(u => u.id === s.userId) || null },
    myRole() { return this.currentUser?.role || 'recruiter' },
    myNotifications() {
      return this.notifications.filter(n => n.recipient_role === this.myRole)
    },
    unreadCount() { return this.myNotifications.filter(n => !n.is_read).length },
    // 某应聘是否存在进行中的审批（可选指定类型）：看板/面试/Offer 页用来显示「审批中」并禁止重复提请
    pendingTask: s => (appId, type) =>
      (s.data?.approvals || []).find(t => t.application_id === appId && t.status === 'pending' && (!type || t.type === type)) || null,
    // 待当前角色审批的任务数（审批中心红点）
    todoCount() {
      return this.approvals.filter(t =>
        t.status === 'pending' && t.chain[t.current_step]?.role === this.myRole
      ).length
    }
  },
  actions: {
    notify(type, msg) {
      this.toast = { type, msg, at: Date.now() }
      if (this._toastTimer) clearTimeout(this._toastTimer)
      this._toastTimer = setTimeout(() => { this.toast = null }, 3600)
    },
    // 串行化同一键的操作：重复触发直接复用进行中的 Promise，杜绝重复提交
    async runBusy(key, fn) {
      if (this.pending[key]) return this.pending[key]
      const p = Promise.resolve().then(fn)
      this.pending = { ...this.pending, [key]: p }
      try {
        return await p
      } finally {
        const next = { ...this.pending }
        delete next[key]
        this.pending = next
      }
    },
    async refresh() {
      try {
        this.data = await j('GET', '/state')
        this.loaded = true
      } catch (e) {
        this.notify('error', e.message)
      }
    },
    async api(method, path, body, opts = {}) {
      try {
        const r = await j(method, path, body)
        await this.refresh()
        if (opts.success) this.notify('success', opts.success)
        return r
      } catch (e) {
        // 版本冲突说明页面数据已过期，先刷新再提示
        if (e.code === 'version_conflict') await this.refresh()
        this.notify('error', e.message)
        return null
      }
    },
    async matchPos(pid) {
      try { return await j('GET', `/match/pos/${pid}`) } catch (e) { this.notify('error', e.message); return null }
    },
    async matchCand(cid) {
      try { return await j('GET', `/match/cand/${cid}`) } catch (e) { this.notify('error', e.message); return null }
    },
    async summary() {
      try { return await j('GET', '/summary') } catch { return null }
    },
    async getStrategy(pid) {
      try { return await j('GET', `/positions/${pid}/strategy`) } catch (e) { this.notify('error', e.message); return null }
    },
    publishStrategy(pid, payload) { return this.api('POST', `/positions/${pid}/strategy`, payload) },
    recomputeAll(positionId) {
      return this.api('POST', '/match/recompute', positionId ? { position_id: positionId } : {})
    },
    addPosition(p) { return this.api('POST', '/positions', p) },
    updatePosition(id, p) { return this.api('POST', `/positions/${id}`, p) },
    addCandidate(c) { return this.api('POST', '/candidates', c) },
    delCandidate(id) { return this.api('DELETE', `/candidates/${id}`) },
    apply(pid, cid) {
      return this.runBusy(`apply:${pid}:${cid}`, () =>
        this.api('POST', '/applications', { position_id: pid, candidate_id: cid }, { success: '已纳入招聘流程' }))
    },
    advance(id, version) {
      return this.runBusy(`stage:${id}`, () =>
        this.api('POST', `/applications/${id}/advance`, { version }, { success: '阶段已推进' }))
    },
    reject(id, version, reason) {
      return this.runBusy(`stage:${id}`, () =>
        this.api('POST', `/applications/${id}/reject`, { version, reason }, { success: '已淘汰' }))
    },
    rollback(id, version, reason) {
      return this.runBusy(`stage:${id}`, () =>
        this.api('POST', `/applications/${id}/rollback`, { version, reason }, { success: '已回退到上一阶段' }))
    },
    addInterview(id, p) {
      return this.runBusy(`iv-add:${id}`, () =>
        this.api('POST', `/applications/${id}/interview`, p, { success: '面试已安排' }))
    },
    setInterview(ivId, p) {
      // 评价录入不打成功提示，避免每输入一次都弹 toast；结论变更才提示
      return this.runBusy(`iv:${ivId}`, () =>
        this.api('POST', `/interviews/${ivId}`, p, p.conclusion ? { success: '面试结论已更新' } : {}))
    },
    addOffer(id, p = {}) {
      return this.runBusy(`offer-add:${id}`, () =>
        this.api('POST', `/applications/${id}/offer`, p, { success: 'Offer 已发起' }))
    },
    updateOffer(ofId, p = {}, successMsg) {
      return this.runBusy(`offer:${ofId}`, () =>
        this.api('POST', `/offers/${ofId}`, p, successMsg ? { success: successMsg } : {}))
    },
    // 兼容旧调用
    setOffer(ofId, status, version) {
      const msg = { accepted: '候选人已接受 Offer', rejected: 'Offer 已拒绝', joined: '已确认入职', withdrawn: 'Offer 已撤回' }[status]
      return this.updateOffer(ofId, { status, version }, msg)
    },
    // ---------------- 身份与审批 ----------------
    setUser(id) {
      this.userId = id
      currentUserId = id
      localStorage.setItem('hr-user-id', id)
    },
    // 提交审批申请（候选人推进/面试结论/Offer 发放）
    submitApproval(payload) {
      return this.runBusy(`appr-new:${payload.type}:${payload.application_id}`, () =>
        this.api('POST', '/approvals', payload, { success: '审批申请已提交，待审批人处理' }))
    },
    // 审批决定：approve 通过 / return 退回（退回必须带意见）
    decideApproval(id, payload, successMsg) {
      return this.runBusy(`appr:${id}`, async () => {
        const r = await this.api('POST', `/approvals/${id}/decide`, payload, successMsg ? { success: successMsg } : {})
        // 终审通过但业务回写失败（流程状态漂移）：接口仍返回 ok，这里把失败原因提示出来
        if (r?.status === 'failed') this.notify('error', `审批已通过但执行失败：${r.msg}`)
        return r
      })
    },
    resubmitApproval(id, payload) {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/resubmit`, { payload }, { success: '已修改并重新提交审批' }))
    },
    cancelApproval(id) {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/cancel`, {}, { success: '申请已撤销' }))
    },
    markNotificationsRead(ids) {
      return this.api('POST', '/notifications/read', ids?.length ? { ids } : {})
    }
  }
})
