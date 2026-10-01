import { defineStore } from 'pinia'

const BASE = '/api'
async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
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
    // 当前操作身份（成员+角色），本地持久化；所有写操作自动携带 operator/role 供服务端鉴权
    me: JSON.parse(localStorage.getItem('hr-me') || 'null'),
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
    members: s => s.data?.members || [],
    roles: s => s.data?.roles || {},
    approvals: s => s.data?.approvalTasks || [],
    notifications: s => s.data?.notifications || [],
    defaultStrategy: s => s.data?.defaultStrategy || { weights: { skill: 0.4, year: 0.2, salary: 0.15, edu: 0.15, city: 0.1 }, keywordCap: 5 },
    openPositions: s => (s.data?.positions || []).filter(p => p.status === 'open'),
    isBusy: s => key => !!s.pending[key],
    myRole: s => s.me?.role || '',
    // 待我审批：审批中且当前节点角色与我的角色一致
    todoApprovals() {
      return this.approvals.filter(t => t.status === 'pending' && t.current_role === this.myRole)
    },
    // 我的通知：指定到人优先，否则按角色广播
    myNotifications() {
      if (!this.me) return []
      return this.notifications.filter(n => n.recipient === this.me.name || (!n.recipient && n.recipient_role === this.me.role))
    },
    unreadCount() { return this.myNotifications.filter(n => !n.read).length },
    // 某应聘进行中的审批（看板/面试/Offer 页置灰与徽标共用）
    pendingApprovalOf: s => (appId, type = null) =>
      (s.data?.approvalTasks || []).find(t => t.application_id === appId && t.status === 'pending' && (!type || t.type === type)) || null
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
        // 首次进入默认以第一位成员（招聘负责人）身份操作
        if (!this.me && this.data?.members?.length) this.setMe(this.data.members[0])
      } catch (e) {
        this.notify('error', e.message)
      }
    },
    setMe(m) {
      this.me = m ? { id: m.id, name: m.name, role: m.role, title: m.title } : null
      localStorage.setItem('hr-me', JSON.stringify(this.me))
    },
    async api(method, path, body, opts = {}) {
      try {
        // 自动携带当前身份：服务端按角色鉴权并留痕操作人
        const payload = body !== undefined ? { operator: this.me?.name, role: this.me?.role, ...body } : body
        const r = await j(method, path, payload)
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
    // ---------------- 审批链 ----------------
    requestApproval(p) {
      return this.runBusy(`appr-new:${p.type}:${p.application_id}:${p.interview_id || 0}`, () =>
        this.api('POST', '/approvals', p, { success: '审批已提交，等待审批人处理' }))
    },
    actApproval(id, action, note = '') {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/act`, { action, note },
          { success: action === 'approve' ? '已批准' : '已退回发起人' }))
    },
    resubmitApproval(id, payload, note = '') {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/resubmit`, { payload, note }, { success: '已重新提交审批' }))
    },
    cancelApproval(id) {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/cancel`, {}, { success: '审批已取消' }))
    },
    markNotificationsRead() {
      return this.api('POST', '/notifications/read', {})
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
    }
  }
})
