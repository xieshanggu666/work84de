import express from 'express'
import db, { ts, now, DEFAULT_WEIGHTS, DEFAULT_KEYWORD_CAP } from './db.js'

const app = express()
app.use(express.json())
const PORT = 4160

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseSkills = s => { try { return JSON.parse(s || '[]') } catch { return [] } }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const parseDims = (s, d) => parseJSON(s, parseJSON(d, []))

// Node:sqlite 同步执行；所有“多步业务动作”放进一个事务，保证策略发布/重算/流程推进不会交叉出半条链路
function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const STAGES = ['submitted', 'screening', 'interview', 'offer', 'hired']
const STAGE_LABEL = { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }
const NEXT_STAGE = { submitted: 'screening', screening: 'interview', interview: 'offer', offer: 'hired' }
const PREV_STAGE = { screening: 'submitted', interview: 'screening', offer: 'interview', hired: 'offer' }
const EVENT_LABEL = {
  advance: '阶段推进', reject: '淘汰', offer_accepted: 'Offer 接受',
  offer_rejected: 'Offer 拒绝', rollback: '异常回退'
}
const OFFER_FLOW = ['pending', 'accepted', 'joined']

// 可预期的业务异常：携带 HTTP 状态码与错误码，事务回滚后按 4xx 返回，前端可直接提示
class ApiError extends Error {
  constructor(status, code, msg) {
    super(msg)
    this.status = status
    this.code = code
  }
}
const badRequest = (msg, code = 'invalid') => { throw new ApiError(400, code, msg) }
const conflict = (msg, code = 'conflict') => { throw new ApiError(409, code, msg) }
const forbidden = (msg, code = 'forbidden') => { throw new ApiError(403, code, msg) }

// ---------------- 角色权限与审批链 ----------------
const ROLES = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }
// 审批链：按角色逐级审批，任一节点可「退回」给发起人修改后重新提交
const APPROVAL_TYPES = {
  stage_advance: { label: '候选人推进', chain: ['hiring_manager'] },
  interview_conclusion: { label: '面试结论', chain: ['recruiter'] },
  offer_issue: { label: 'Offer 发放', chain: ['hiring_manager', 'recruiter'] }
}
// 各审批类型允许的发起角色
const APPROVAL_REQUESTER = {
  stage_advance: ['recruiter'],
  interview_conclusion: ['interviewer', 'recruiter'],
  offer_issue: ['recruiter']
}
const APPROVAL_STATUS_LABEL = { pending: '审批中', approved: '已通过', returned: '已退回', cancelled: '已取消' }
const APPROVAL_ACTION_LABEL = { submit: '提交', resubmit: '重新提交', approve: '批准', return: '退回', cancel: '取消' }

// 服务端强制鉴权：请求必须携带合法角色，且在允许列表内
function requireRole(b, roles) {
  const role = b?.role
  if (!ROLES[role]) forbidden('缺少合法操作角色，请先在右上角选择身份', 'role_required')
  if (!roles.includes(role)) forbidden(`「${ROLES[role]}」无权执行此操作，需要：${roles.map(r => ROLES[r]).join('/')}`, 'role_denied')
  return role
}

// 乐观锁：阶段协同类操作必须携带读取时的 version；并发/重复点击导致版本错位时拒绝
function checkVersion(app, expected) {
  if (expected !== undefined && expected !== null && expected !== '' && num(expected) !== num(app.version)) {
    conflict('流程状态已被其他操作更新，请刷新后重试', 'version_conflict')
  }
}

function latestInterviewOf(applicationId) {
  return db.prepare('SELECT * FROM interviews WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null
}

// 面试结论约束：进入 Offer 前，最近一轮必须已有「通过」结论（待定/不通过均拦截）
function assertCanEnterOffer(app) {
  const iv = latestInterviewOf(app.id)
  if (!iv) badRequest('请先安排并完成至少一轮面试', 'interview_required')
  const c = iv.conclusion || iv.result || 'pending'
  if (c === 'pending') badRequest(`最近一轮「${iv.round}」尚未给出面试结论，不能进入 Offer`, 'interview_pending')
  if (c === 'fail') badRequest(`最近一轮「${iv.round}」结论为不通过，不能进入 Offer；如需推进请先改判结论`, 'interview_failed')
}

function offerOfApp(applicationId) {
  return db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null
}

function addOfferLog({ offerId, applicationId, changeType, of, toStatus, toSalary, operator = 'HR-Sandy', note = '' }) {
  db.prepare(`INSERT INTO offer_change_logs(offer_id,application_id,change_type,from_status,to_status,from_salary,to_salary,changed_at,operator,note)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(offerId, applicationId, changeType,
      of?.status || '', toStatus ?? of?.status ?? '',
      num(of?.salary, 0), num(toSalary ?? of?.salary, 0),
      ts(), operator, note)
}

// ---------------- 审批引擎 ----------------
// 审计通知：只追加不删除；recipient 指定到人，否则按角色广播
function notify({ role = '', recipient = '', title, body = '', taskId = 0, applicationId = 0 }) {
  db.prepare(`INSERT INTO notifications(recipient_role,recipient,kind,title,body,task_id,application_id,read,created_at)
              VALUES(?,?,?,?,?,?,?,0,?)`)
    .run(role, recipient, 'approval', title, body, num(taskId), num(applicationId), ts())
}

function addApprovalStep(taskId, { seq, stepRole = '', action, operator, note = '' }) {
  db.prepare(`INSERT INTO approval_steps(task_id,seq,step_role,action,operator,note,acted_at)
              VALUES(?,?,?,?,?,?,?)`)
    .run(taskId, num(seq), stepRole, action, operator || '', note, ts())
}

function approvalTask(id) {
  return db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(num(id)) || null
}

// 同一应聘同类型只允许一个「审批中」任务；有「已退回」任务时应在其上修改重提，避免审批链分叉
function assertNoOpenTask(type, applicationId, interviewId = 0) {
  const pending = db.prepare(`SELECT id FROM approval_tasks WHERE type=? AND application_id=? AND status='pending'`).get(type, applicationId)
  if (pending) conflict(`该候选人已有进行中的「${APPROVAL_TYPES[type].label}」审批（#${pending.id}），请勿重复提交`, 'approval_duplicate')
  const returned = db.prepare(`SELECT id FROM approval_tasks WHERE type=? AND application_id=? AND interview_id=? AND status='returned'`).get(type, applicationId, num(interviewId))
  if (returned) conflict(`存在被退回的「${APPROVAL_TYPES[type].label}」审批（#${returned.id}），请在审批中心修改后重新提交`, 'approval_returned_exists')
}

// 面试结论应用（审批通过的执行体）：与阶段联动、阶段快照同事务提交
function applyInterviewConclusion(iv, a, conclusion, operator) {
  const current = iv.conclusion || iv.result || 'pending'
  if (conclusion === current) return { idempotent: true }
  if (a.stage === 'hired') conflict('候选人已录用，面试结论已锁定', 'terminal_locked')
  const stamp = ts()
  db.prepare('UPDATE interviews SET conclusion=?, result=?, decided_at=?, decided_by=? WHERE id=?')
    .run(conclusion, conclusion, stamp, operator, iv.id)
  // 最近一轮「不通过」自动淘汰；淘汰态改判「通过/待定」复活回面试阶段
  const last = latestInterviewOf(a.id)
  if (conclusion === 'fail' && last && last.id === iv.id && a.stage !== 'rejected') {
    const fromStage = a.stage
    moveStage(a, 'rejected', { eventType: 'reject', operator, fromStage })
    db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, a.id)
  }
  if (conclusion !== 'fail' && a.stage === 'rejected') {
    const target = a.reject_from && STAGES.includes(a.reject_from) && STAGES.indexOf(a.reject_from) <= STAGES.indexOf('interview')
      ? a.reject_from : 'interview'
    moveStage(a, target, { eventType: 'rollback', operator, fromStage: 'rejected' })
    db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(a.id)
  }
  return { idempotent: false }
}

// Offer 发放执行体（审批通过）：必要时协同推进到 Offer 阶段，创建/重开 Offer 并留痕
function issueOffer(a, { salary, due, note }, operator) {
  if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能发放 Offer', 'terminal_locked')
  if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) assertCanEnterOffer(a)
  const exist = offerOfApp(a.id)
  if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer，请勿重复发起', 'offer_duplicate')
  if (exist && (exist.status === 'accepted' || exist.status === 'joined')) conflict('该候选人的 Offer 已被接受，不能重新发起', 'offer_accepted_locked')
  if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
  const stamp = ts()
  if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) {
    moveStage(a, 'offer', { eventType: 'advance', operator, fromStage: a.stage })
  }
  let offerId
  if (exist) {
    db.prepare('UPDATE offers SET salary=?, status=?, due=?, note=?, decided_at=?, decided_by=?, joined_at=? WHERE id=?')
      .run(salary, 'pending', due || stamp, note || '', '', '', '', exist.id)
    offerId = exist.id
    addOfferLog({ offerId, applicationId: a.id, changeType: 'reopen', of: exist, toStatus: 'pending', toSalary: salary, operator, note: note || '' })
  } else {
    const r = db.prepare('INSERT INTO offers(application_id,salary,status,due,note) VALUES(?,?,?,?,?)')
      .run(a.id, salary, 'pending', due || stamp, note || '')
    offerId = Number(r.lastInsertRowid)
    addOfferLog({ offerId, applicationId: a.id, changeType: 'create', of: { status: '', salary: 0 }, toStatus: 'pending', toSalary: salary, operator, note: note || '' })
  }
  return { offerId }
}

// 审批通过后的业务回写：推进→应用阶段；结论→面试结论+阶段联动；Offer→发放并回写 Offer 状态
function executeApproval(task, operator) {
  const payload = parseJSON(task.payload, {})
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(task.application_id)
  if (!a) badRequest('审批关联的应聘记录不存在', 'app_missing')
  if (task.type === 'stage_advance') {
    const to = payload.to_stage
    if (a.stage === 'rejected') conflict('候选人已淘汰，请先「异常回退」复活后再推进', 'rejected_locked')
    if (a.stage === to) return { detail: '已处于目标阶段，幂等通过' }
    if (NEXT_STAGE[a.stage] !== to) conflict(`当前阶段为「${STAGE_LABEL[a.stage]}」，无法推进到「${STAGE_LABEL[to]}」，请退回该审批`, 'stage_mismatch')
    if (to === 'offer') assertCanEnterOffer(a)
    if (to === 'hired') {
      const of = offerOfApp(a.id)
      if (!of || of.status !== 'accepted') badRequest('候选人尚未接受 Offer，不能录用', 'offer_not_accepted')
    }
    moveStage(a, to, { eventType: 'advance', operator })
    return { detail: `阶段已推进到「${STAGE_LABEL[to]}」` }
  }
  if (task.type === 'interview_conclusion') {
    const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(num(task.interview_id))
    if (!iv) badRequest('审批关联的面试记录不存在', 'interview_missing')
    const r = applyInterviewConclusion(iv, a, payload.conclusion, operator)
    return { detail: `面试结论已回写为「${{ pass: '通过', fail: '不通过', pending: '待定' }[payload.conclusion]}」${r.idempotent ? '（幂等）' : ''}` }
  }
  if (task.type === 'offer_issue') {
    const r = issueOffer(a, { salary: num(payload.salary), due: payload.due, note: payload.note }, operator)
    return { detail: `Offer 已发放（¥${num(payload.salary).toLocaleString()}/月，Offer #${r.offerId}）` }
  }
  badRequest('未知审批类型', 'approval_type')
}

// ---------------- 人岗匹配评分算法 ----------------
// 系统默认五维权重合计闭合为 1.0；每个职位可发布自己的策略（match_strategies）
const WEIGHT_KEYS = ['skill', 'year', 'salary', 'edu', 'city']

// 把前端传入的权重归一化为合计 1.0；允许将某维权重设为 0（如不看学历）
function normalizeWeights(input) {
  const raw = {}
  WEIGHT_KEYS.forEach(k => { raw[k] = Math.max(0, num(input?.[k], DEFAULT_WEIGHTS[k])) })
  const total = WEIGHT_KEYS.reduce((s, k) => s + raw[k], 0)
  if (total <= 0) return { ...DEFAULT_WEIGHTS }
  // 先保留两位小数，再把舍入残差补到权重最大的维度，保证合计严格为 1
  const w = {}
  WEIGHT_KEYS.forEach(k => { w[k] = Math.round(raw[k] / total * 100) / 100 })
  let rest = Math.round((1 - WEIGHT_KEYS.reduce((s, k) => s + w[k], 0)) * 100) / 100
  if (rest !== 0) {
    const maxK = WEIGHT_KEYS.reduce((a, b) => w[b] > w[a] ? b : a, WEIGHT_KEYS[0])
    w[maxK] = Math.round((w[maxK] + rest) * 100) / 100
  }
  return w
}

// 读取职位已发布的策略；未配置则回退系统默认
function getStrategy(posId) {
  const row = db.prepare('SELECT * FROM match_strategies WHERE position_id=?').get(num(posId))
  if (!row) {
    return { positionId: num(posId), weights: { ...DEFAULT_WEIGHTS }, keywordCap: DEFAULT_KEYWORD_CAP, versionId: 0, publishedAt: '', publishedBy: '', isDefault: true }
  }
  const ver = db.prepare('SELECT id FROM strategy_versions WHERE position_id=? ORDER BY id DESC LIMIT 1').get(row.position_id)
  return {
    positionId: row.position_id,
    weights: normalizeWeights(parseJSON(row.weights, { ...DEFAULT_WEIGHTS })),
    keywordCap: Math.max(0, num(row.keyword_cap, DEFAULT_KEYWORD_CAP)),
    versionId: ver ? ver.id : 0,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    isDefault: false
  }
}

function getStrategyVersion(versionId) {
  const id = num(versionId)
  if (!id) return null
  const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(id)
  if (!v) return null
  return {
    ...v,
    keyword_cap: num(v.keyword_cap),
    weights: normalizeWeights(parseJSON(v.weights, { ...DEFAULT_WEIGHTS }))
  }
}

function computeMatch(cand, pos, strategy) {
  const W = strategy?.weights || DEFAULT_WEIGHTS
  const keywordCap = strategy?.keywordCap ?? DEFAULT_KEYWORD_CAP
  const cSkills = parseSkills(cand.skills)
  const pSkills = parseSkills(pos.skills)
  const dims = []

  // 技能匹配：候选者命中职位要求技能的熟练度按职位权重加权
  let skillScore = 0, matched = 0, skillWeightSum = 0
  pSkills.forEach(req => {
    const hit = cSkills.find(c => c.k === req.k)
    if (hit) { skillScore += Math.min(100, (num(hit.idx, 3) / 5) * 100) * req.w; matched++ }
    skillWeightSum += req.w
  })
  const skillCover = pSkills.length ? matched / pSkills.length : 1
  skillScore = pSkills.length ? (skillWeightSum ? skillScore / skillWeightSum : 0) : 70
  dims.push({ k: '技能', score: Math.round(skillScore), w: W.skill })

  // 年限匹配
  const ideal = num(pos.years, 0)
  const yearScore = num(cand.years, 0) >= ideal ? 90 : Math.max(30, 100 - (ideal - num(cand.years, 0)) * 15)
  dims.push({ k: '经验年限', score: Math.round(yearScore), w: W.year })

  // 薪资带宽匹配（先判低于带宽，再判高于带宽，避免分支被吞）
  const sal = num(cand.exp_salary, 0)
  let salScore, salNote, salOver = false, salOverMuch = false
  if (sal <= 0) { salScore = 70; salNote = '期望薪资未填写' }
  else if (sal < pos.salary_min) { salScore = 75; salNote = '期望薪资低于带宽' }
  else if (sal <= pos.salary_max) { salScore = 90; salNote = '期望薪资在带宽内' }
  else if (sal <= pos.salary_max * 1.15) { salScore = 70; salNote = '期望薪资略高于带宽'; salOver = true }
  else { salScore = 45; salNote = '期望薪资超出带宽'; salOver = true; salOverMuch = true }
  dims.push({ k: '薪资匹配', score: salScore, w: W.salary })

  // 学历匹配
  const eduRank = { '博士': 100, '硕士': 85, '本科': 70, '大专': 55 }
  const eduScore = eduRank[cand.edu] ?? 65
  dims.push({ k: '学历', score: eduScore, w: W.edu })

  // 城市匹配
  const cityHit = pos.city === '全国' || (!!cand.city && cand.city === pos.city)
  const cityScore = cityHit ? 90 : 65
  dims.push({ k: '城市地点', score: cityScore, w: W.city })

  // 简历关键词加分（在职位名/要求技能中命中，封顶，不计入维度权重；cap=0 关闭）
  const keywords = new Set([...pSkills.map(s => s.k), ...String(pos.name || '').split(/[\s/、,，]+/).filter(Boolean)])
  const tokens = String(cand.raw || '').split(/[,，。；;、/\s]+/).filter(Boolean)
  const hitKws = new Set([...keywords].filter(kw => tokens.some(t => t.includes(kw))))
  const keywordBonus = Math.min(keywordCap, hitKws.size * 1.5)

  // 五维加权（权重按职位策略，合计 1.0）+ 封顶关键词附加分
  const base = skillScore * W.skill
    + yearScore * W.year
    + salScore * W.salary
    + eduScore * W.edu
    + cityScore * W.city
  const score = Math.min(100, Math.round(base + keywordBonus))

  // 短板：覆盖技能/年限/薪资/学历/城市五个维度
  const weakness = []
  if (skillCover < 0.5) weakness.push('关键技能覆盖不足')
  if (yearScore < 65) weakness.push('经验年限偏低')
  if (salOverMuch) weakness.push('期望薪资超出带宽')
  else if (salOver) weakness.push('期望薪资略高于带宽')
  if (eduScore < 60) weakness.push('学历相对偏低')
  if (!cityHit) weakness.push('工作城市不匹配')

  const rating = score >= 80 ? '高匹配' : score >= 65 ? '匹配度良好' : score >= 55 ? '基本匹配' : '匹配度偏低'
  const cityNote = cityHit
    ? (pos.city === '全国' ? '城市全国可选' : `城市${cand.city}与职位一致`)
    : `城市${cand.city || '未知'}≠${pos.city}`
  const reason = [
    `技能覆盖${Math.round(skillCover * 100)}%`,
    `经验${cand.years}/${ideal}年`,
    salNote,
    `${cand.edu || '学历未知'}`,
    cityNote
  ].join('，') + `；综合${rating}${keywordBonus ? `（简历关键词+${keywordBonus.toFixed(1)}分）` : ''}`

  return { score, dims, reason, weakness: weakness.join('、') || '无显著短板' }
}

// 计算评分但不落库：推荐列表浏览不隐式制造“最新结果”，避免与流程推进时看到的证据不一致
function computePair(candId, posId, strategy = getStrategy(posId)) {
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(candId)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(posId)
  if (!cand || !pos) return null
  const m = computeMatch(cand, pos, strategy)
  return {
    ...m,
    candidate_id: candId,
    position_id: posId,
    weights: strategy.weights,
    keyword_cap: strategy.keywordCap,
    strategy_id: strategy.versionId,
    strategy_is_default: strategy.isDefault,
    computed_at: now()
  }
}

function createRecalcJob({ triggerType, scope, positionId = 0, strategyId = 0, triggeredBy = 'HR' }) {
  const stamp = ts()
  const r = db.prepare(`INSERT INTO recalc_jobs(trigger_type,scope,position_id,strategy_id,status,pair_count,started_at,finished_at,triggered_by)
                        VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(triggerType, scope, num(positionId), num(strategyId), 'running', 0, stamp, stamp, triggeredBy)
  return Number(r.lastInsertRowid)
}

function completeRecalcJob(jobId, pairCount) {
  db.prepare('UPDATE recalc_jobs SET status=?, pair_count=?, finished_at=? WHERE id=?')
    .run('completed', pairCount, ts(), jobId)
}

// 按职位当前已发布策略重算并落库为「最新结果」（不影响 applications/events 中的历史快照）
function upsertMatch(candId, posId, jobId = 0) {
  const m = computePair(candId, posId)
  if (!m) return null
  const stamp = m.computed_at
  const jid = num(jobId)
  const existing = db.prepare('SELECT id FROM matches WHERE candidate_id=? AND position_id=?').get(candId, posId)
  if (existing) {
    db.prepare('UPDATE matches SET score=?,dims=?,reason=?,weakness=?,computed_at=?,strategy_id=? WHERE id=?')
      .run(m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp, m.strategy_id, existing.id)
  } else {
    db.prepare('INSERT INTO matches(candidate_id,position_id,score,dims,reason,weakness,computed_at,strategy_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(candId, posId, m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp, m.strategy_id)
  }
  if (jid) {
    db.prepare(`INSERT INTO recalc_items(job_id,candidate_id,position_id,strategy_id,score,dims,reason,weakness,computed_at)
                VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(jid, candId, posId, m.strategy_id, m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp)
  }
  return { ...m, recalc_job_id: jid }
}

// 投递/进入阶段时的评分依据快照：锁定分数、维度、理由、短板及所用策略版本，后续重算不再改变
function buildSnapshot(candId, posId, m, extra = {}) {
  const strategy = getStrategy(posId)
  return {
    score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness,
    weights: strategy.weights, keyword_cap: strategy.keywordCap,
    strategy_id: strategy.versionId, strategy_is_default: strategy.isDefault,
    published_at: strategy.publishedAt, published_by: strategy.publishedBy,
    candidate_id: candId, position_id: posId,
    matched_at: now(),
    ...extra
  }
}

// ---------------- 状态汇总 ----------------
app.get('/api/state', (req, res) => {
  const positions = db.prepare('SELECT * FROM positions ORDER BY id').all().map(p => {
    const st = db.prepare('SELECT published_at, published_by FROM match_strategies WHERE position_id=?').get(p.id)
    return { ...p, skills: parseSkills(p.skills), strategy: st ? { published_at: st.published_at, published_by: st.published_by } : null }
  })
  const candidates = db.prepare('SELECT * FROM candidates ORDER BY id').all().map(c => ({ ...c, skills: parseSkills(c.skills) }))
  const apps = db.prepare('SELECT * FROM applications ORDER BY id DESC').all()
  const interviews = db.prepare('SELECT * FROM interviews ORDER BY id DESC').all()
  const offers = db.prepare('SELECT * FROM offers ORDER BY id DESC').all()
  const offerLogs = db.prepare('SELECT * FROM offer_change_logs ORDER BY id ASC').all().map(l => ({
    ...l,
    from_salary: num(l.from_salary),
    to_salary: num(l.to_salary),
    change_label: {
      create: '发起 Offer', update_salary: '调整薪资', update_due: '调整期限',
      accept: '候选人接受', reject: '候选人拒绝', join: '确认入职',
      withdraw: '撤回 Offer', reopen: '重新发起'
    }[l.change_type] || l.change_type
  }))
  const channels = db.prepare('SELECT * FROM channels ORDER BY id').all()
  const strategyVersions = db.prepare('SELECT * FROM strategy_versions ORDER BY id DESC').all().map(v => ({
    ...v, weights: parseJSON(v.weights, { ...DEFAULT_WEIGHTS }), keyword_cap: num(v.keyword_cap)
  }))
  const recalcJobs = db.prepare('SELECT * FROM recalc_jobs ORDER BY id DESC').all().map(j => ({
    ...j,
    position_id: num(j.position_id),
    strategy_id: num(j.strategy_id),
    pair_count: num(j.pair_count)
  }))
  const recalcItems = db.prepare('SELECT id,job_id,candidate_id,position_id,strategy_id,score,computed_at FROM recalc_items ORDER BY id DESC LIMIT 500')
    .all().map(i => ({ ...i, strategy_id: num(i.strategy_id), score: num(i.score) }))
  const appEvents = db.prepare('SELECT * FROM application_events ORDER BY id ASC').all().map(e => ({
    ...e,
    from_stage: e.from_stage || '',
    match_score: num(e.match_score),
    strategy_id: num(e.strategy_id),
    recalc_job_id: num(e.recalc_job_id),
    backfilled: !!e.backfilled,
    stage_label: { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }[e.stage] || e.stage,
    scoreSnapshot: parseJSON(e.score_snapshot, null)
  }))
  const jobOf = new Map(recalcJobs.map(j => [j.id, j]))
  const members = db.prepare('SELECT * FROM members ORDER BY id').all()
  const stepsOf = taskId => db.prepare('SELECT * FROM approval_steps WHERE task_id=? ORDER BY id').all(taskId)
    .map(s => ({ ...s, action_label: APPROVAL_ACTION_LABEL[s.action] || s.action, role_label: ROLES[s.step_role] || '' }))
  const approvalTasks = db.prepare('SELECT * FROM approval_tasks ORDER BY id DESC').all().map(t => {
    const conf = APPROVAL_TYPES[t.type] || { label: t.type, chain: [] }
    return {
      ...t,
      payload: parseJSON(t.payload, {}),
      type_label: conf.label,
      status_label: APPROVAL_STATUS_LABEL[t.status] || t.status,
      chain: conf.chain,
      chain_labels: conf.chain.map(r => ROLES[r]),
      current_role: conf.chain[num(t.current_step)] || '',
      current_role_label: ROLES[conf.chain[num(t.current_step)]] || '',
      steps: stepsOf(t.id)
    }
  })
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 300').all()
    .map(n => ({ ...n, read: !!n.read, role_label: ROLES[n.recipient_role] || '' }))
  const matches = db.prepare('SELECT * FROM matches ORDER BY id DESC').all().map(m => ({
    ...m,
    score: num(m.score),
    dims: parseDims(m.dims, '[]'),
    strategy_id: num(m.strategy_id)
  }))
  const latestItemOf = (cid, pid) => db.prepare(`SELECT ri.* FROM recalc_items ri
    WHERE ri.candidate_id=? AND ri.position_id=? ORDER BY ri.id DESC LIMIT 1`).get(cid, pid) || null
  const matchOf = (cid, pid) => matches.find(m => m.candidate_id === cid && m.position_id === pid) || null
  const pipelines = apps.map(a => {
    const pos = positions.find(p => p.id === a.position_id)
    const cand = candidates.find(c => c.id === a.candidate_id)
    const its = interviews.filter(i => i.application_id === a.id)
    const of = offers.find(o => o.application_id === a.id) || null
    const mt = matchOf(a.candidate_id, a.position_id)
    const latestItem = latestItemOf(a.candidate_id, a.position_id)
    const latestJob = latestItem ? (jobOf.get(latestItem.job_id) || null) : null
    // 投递时锁定的历史评分依据；兼容旧数据：无快照时置空由前端回退最新分
    const snap = parseJSON(a.match_snapshot, null)
    const stageSnap = parseJSON(a.stage_snapshot, null)
    const latest = mt ? {
      score: mt.score, dims: mt.dims, reason: mt.reason, weakness: mt.weakness,
      computed_at: mt.computed_at, strategy_id: mt.strategy_id,
      recalc_job_id: latestItem?.job_id || 0,
      recalc_trigger: latestJob?.trigger_type || '',
      recalc_scope: latestJob?.scope || ''
    } : null
    return {
      ...a,
      version: num(a.version),
      position: pos ? pos.name : '', dept: pos ? pos.dept : '', city: pos ? pos.city : '',
      candidate: cand ? cand.name : '', candSkills: cand ? cand.skills : [],
      matchSnapshot: snap, matched_at: a.matched_at || '',
      stageSnapshot: stageSnap, entered_at: a.entered_at || '',
      match: latest,
      events: appEvents.filter(e => e.application_id === a.id),
      interviews: its, offer: of,
      offerLogs: offerLogs.filter(l => l.application_id === a.id)
    }
  })
  res.json({
    positions, candidates, applications: pipelines, interviews, offers, offerLogs, channels, matches,
    strategyVersions, recalcJobs, recalcItems, members, approvalTasks, notifications,
    roles: ROLES,
    defaultStrategy: { weights: { ...DEFAULT_WEIGHTS }, keywordCap: DEFAULT_KEYWORD_CAP }
  })
})

app.get('/api/summary', (req, res) => {
  const pos = db.prepare('SELECT status, COUNT(*) c FROM positions GROUP BY status').all()
  const apps = db.prepare('SELECT stage, COUNT(*) c FROM applications GROUP BY stage').all()
  const cand = db.prepare('SELECT COUNT(*) c FROM candidates').get().c
  return res.json({ positions: pos, applications: apps, candidates: cand })
})

// ---------------- 职位 ----------------
app.post('/api/positions', (req, res) => {
  const b = req.body || {}
  const r = db.prepare('INSERT INTO positions(name,dept,city,level,salary_min,salary_max,skills,years,slots,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(b.name, b.dept || '技术部', b.city || '上海', b.level || 'P5', num(b.salary_min, 15000), num(b.salary_max, 30000), JSON.stringify(b.skills || []), num(b.years, 2), num(b.slots, 1), 'open', ts())
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/positions/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.status) db.prepare('UPDATE positions SET status=? WHERE id=?').run(b.status, id)
  if (b.skills !== undefined) db.prepare('UPDATE positions SET skills=? WHERE id=?').run(JSON.stringify(b.skills), id)
  res.json({ ok: true })
})

// ---------------- 按职位配置/发布匹配策略 ----------------
// 读取某职位生效中的策略（未配置返回系统默认）
app.get('/api/positions/:id/strategy', (req, res) => {
  const id = num(req.params.id)
  const pos = db.prepare('SELECT id,name FROM positions WHERE id=?').get(id)
  if (!pos) return res.status(404).json({ ok: false })
  res.json({ ok: true, position: pos, strategy: getStrategy(id), defaults: { weights: { ...DEFAULT_WEIGHTS }, keywordCap: DEFAULT_KEYWORD_CAP } })
})

// 配置并发布策略：归一化权重 → 留痕版本 → upsert 生效配置
// body: { weights:{skill,year,salary,edu,city}, keyword_cap, reset, recalc, published_by }
app.post('/api/positions/:id/strategy', (req, res) => {
  const id = num(req.params.id)
  const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(id)
  if (!pos) return res.status(404).json({ ok: false })
  const b = req.body || {}
  const stamp = ts()
  let weights, keywordCap
  if (b.reset) {
    weights = { ...DEFAULT_WEIGHTS }
    keywordCap = DEFAULT_KEYWORD_CAP
  } else {
    weights = normalizeWeights(b.weights || {})
    keywordCap = Math.max(0, Math.min(20, num(b.keyword_cap, DEFAULT_KEYWORD_CAP)))
  }

  const result = tx(() => {
    const vr = db.prepare('INSERT INTO strategy_versions(position_id,weights,keyword_cap,published_at,published_by) VALUES(?,?,?,?,?)')
      .run(id, JSON.stringify(weights), keywordCap, stamp, b.published_by || 'HR')
    const versionId = Number(vr.lastInsertRowid)
    db.prepare(`INSERT INTO match_strategies(position_id,weights,keyword_cap,published_at,published_by)
                VALUES(?,?,?,?,?)
                ON CONFLICT(position_id) DO UPDATE SET weights=excluded.weights,keyword_cap=excluded.keyword_cap,published_at=excluded.published_at,published_by=excluded.published_by`)
      .run(id, JSON.stringify(weights), keywordCap, stamp, b.published_by || 'HR')

    // 发布与重算在同一事务：版本、生效策略、最新分和批次明细要么同时可见，要么全部回滚
    let jobId = 0, pairCount = 0
    if (b.recalc !== false) {
      jobId = createRecalcJob({ triggerType: 'strategy_publish', scope: 'position', positionId: id, strategyId: versionId, triggeredBy: b.published_by || 'HR' })
      pairCount = recomputePosition(id, jobId)
      completeRecalcJob(jobId, pairCount)
    }
    return { weights, keywordCap, versionId, jobId, pairCount }
  })
  res.json({
    ok: true,
    strategy: { weights, keywordCap, versionId: result.versionId, publishedAt: stamp },
    job_id: result.jobId,
    recalced: result.pairCount
  })
})

// ---------------- 批量重算推荐结果 ----------------
// 单职位：全部候选人 × 该职位（含未投递候选人，保证推荐列表可用）
function recomputePosition(posId, jobId = 0) {
  const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(posId)
  if (!pos) return 0
  const cands = db.prepare('SELECT id FROM candidates').all()
  cands.forEach(c => upsertMatch(c.id, posId, jobId))
  return cands.length
}

app.post('/api/match/recompute', (req, res) => {
  const b = req.body || {}
  const result = tx(() => {
    let pairCount = 0, posCount = 0, scope = 'global', targetPos = 0, strategyId = 0
    if (b.position_id) {
      const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(num(b.position_id))
      if (!pos) return { notFound: true }
      targetPos = pos.id
      scope = 'position'
      strategyId = getStrategy(pos.id).versionId
      const jobId = createRecalcJob({ triggerType: 'manual', scope, positionId: targetPos, strategyId, triggeredBy: b.triggered_by || 'HR' })
      pairCount = recomputePosition(targetPos, jobId)
      posCount = 1
      completeRecalcJob(jobId, pairCount)
      return { ok: true, jobId, positions: posCount, pairs: pairCount }
    }

    const jobId = createRecalcJob({ triggerType: 'manual', scope, triggeredBy: b.triggered_by || 'HR' })
    // 全局：所有在招职位 × 全部候选人；同时补上已关闭职位上已存在的匹配对
    const posIds = db.prepare("SELECT id FROM positions WHERE status='open'").all().map(p => p.id)
    db.prepare("SELECT DISTINCT m.position_id FROM matches m JOIN positions p ON p.id=m.position_id WHERE p.status!='open'")
      .all().forEach(r => posIds.push(r.position_id))
    posIds.forEach(pid => {
      // 批次是全局操作，明细保留每个职位实际使用的策略版本，职位级批次元数据记录在批次明细中可查
      pairCount += recomputePosition(pid, jobId)
      posCount++
    })
    completeRecalcJob(jobId, pairCount)
    return { ok: true, jobId, positions: posCount, pairs: pairCount }
  })
  if (result.notFound) return res.status(404).json({ ok: false })
  res.json({ ok: true, positions: result.positions, pairs: result.pairs, job_id: result.jobId, recomputed_at: ts() })
})

// ---------------- 候选人 ----------------
app.post('/api/candidates', (req, res) => {
  const b = req.body || {}
  const r = db.prepare('INSERT INTO candidates(name,phone,skills,years,edu,school,city,exp_salary,channel,raw) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(b.name, b.phone || '', JSON.stringify(b.skills || []), num(b.years, 0), b.edu || '本科', b.school || '', b.city || '', num(b.exp_salary, 0), b.channel || '内推', b.raw || `候选人${b.name}的简历`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.delete('/api/candidates/:id', (req, res) => {
  db.prepare('DELETE FROM candidates WHERE id=?').run(num(req.params.id))
  res.json({ ok: true })
})

// ---------------- 匹配 ----------------
app.get('/api/match/pos/:pid', (req, res) => {
  const posId = num(req.params.pid)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(posId)
  if (!pos) return res.status(404).json({ ok: false })
  const cands = db.prepare('SELECT * FROM candidates').all()
  const rows = cands.map(c => {
    // 浏览推荐时实时计算；只有显式“批量重算/发布策略”才更新最新结果与审计批次
    const m = computePair(c.id, posId)
    return { candidate_id: c.id, name: c.name, skills: parseSkills(c.skills), years: c.years, edu: c.edu, city: c.city, exp_salary: c.exp_salary, score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness, computed_at: m.computed_at, strategy_id: m.strategy_id }
  })
  rows.sort((a, b) => b.score - a.score)
  const strategy = getStrategy(posId)
  res.json({ position: { ...pos, skills: parseSkills(pos.skills) }, candidates: rows, strategy })
})

app.get('/api/match/cand/:cid', (req, res) => {
  const candId = num(req.params.cid)
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(candId)
  if (!cand) return res.status(404).json({ ok: false })
  const poss = db.prepare("SELECT * FROM positions WHERE status='open'").all()
  const rows = poss.map(p => {
    // 与按职位推荐共用同一实时计算逻辑；显式重算的结果才写入最新结果/批次明细
    const m = computePair(candId, p.id)
    return { position_id: p.id, name: p.name, dept: p.dept, city: p.city, level: p.level, salary_min: p.salary_min, salary_max: p.salary_max, score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness, computed_at: m.computed_at, strategy_id: m.strategy_id, strategy_is_default: m.strategy_is_default }
  })
  rows.sort((a, b) => b.score - a.score)
  res.json({ candidate: { name: cand.name, skills: parseSkills(cand.skills), years: cand.years }, positions: rows })
})

// ---------------- 应聘流程 ----------------
function getStoredMatch(candId, posId) {
  return db.prepare('SELECT * FROM matches WHERE candidate_id=? AND position_id=?').get(candId, posId) || null
}

function resultFromStored(row) {
  if (!row) return null
  return {
    score: num(row.score),
    dims: parseDims(row.dims, '[]'),
    reason: row.reason,
    weakness: row.weakness,
    computed_at: row.computed_at,
    strategy_id: num(row.strategy_id)
  }
}

function latestJobForPair(candId, posId) {
  return db.prepare(`SELECT ri.job_id, ri.strategy_id, ri.computed_at
                     FROM recalc_items ri
                     WHERE ri.candidate_id=? AND ri.position_id=?
                     ORDER BY ri.id DESC LIMIT 1`).get(candId, posId) || null
}

// 写入/刷新「进入某阶段」的正式事件（backfilled=0）：
// 同一 application×stage 永远只有一条正式事件（部分唯一索引兜底），候选人再次进入该阶段时
// 直接刷新该行，保证阶段快照、时间线与当前阶段口径一致；补录事件不受影响
function insertStageEvent({ applicationId, stage, fromStage, eventType = 'advance', operator = 'HR-Sandy', candId, posId, latest, backfilled = false }) {
  const source = latest || resultFromStored(getStoredMatch(candId, posId))
  const item = latestJobForPair(candId, posId)
  const linkedItem = source && item && item.computed_at === source.computed_at ? item : null
  const recalcJobId = latest && Object.prototype.hasOwnProperty.call(latest, 'recalc_job_id')
    ? num(latest.recalc_job_id)
    : num(linkedItem?.job_id || 0)
  const stamp = ts()
  const snap = buildSnapshot(candId, posId, source || {
    score: 0, dims: [], reason: '暂无已发布评分', weakness: '暂无评分依据'
  }, {
    stage,
    stage_label: STAGE_LABEL[stage] || stage,
    event_type: eventType,
    event_at: stamp,
    recalc_job_id: recalcJobId,
    backfilled
  })
  if (backfilled) {
    db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,recalc_job_id,backfilled)
                VALUES(?,?,?,?,?,?,?,?,?,?,1)
                ON CONFLICT(application_id,stage) WHERE backfilled=0 DO NOTHING`)
      .run(applicationId, stage, fromStage || '', eventType, stamp, operator,
        JSON.stringify(snap), snap.score, snap.strategy_id, snap.recalc_job_id)
  } else {
    db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,recalc_job_id,backfilled)
                VALUES(?,?,?,?,?,?,?,?,?,?,0)
                ON CONFLICT(application_id,stage) WHERE backfilled=0 DO UPDATE SET
                  from_stage=excluded.from_stage,event_type=excluded.event_type,event_at=excluded.event_at,
                  operator=excluded.operator,score_snapshot=excluded.score_snapshot,match_score=excluded.match_score,
                  strategy_id=excluded.strategy_id,recalc_job_id=excluded.recalc_job_id`)
      .run(applicationId, stage, fromStage || '', eventType, stamp, operator,
        JSON.stringify(snap), snap.score, snap.strategy_id, snap.recalc_job_id)
  }
  return snap
}

// 阶段协同的唯一入口：更新应用阶段 + 乐观锁版本 + 阶段快照 + 阶段事件，保证四处口径一次事务内一致
function moveStage(app, stage, { eventType, fromStage, operator }) {
  const stamp = ts()
  db.prepare('UPDATE applications SET stage=?, updated=?, entered_at=?, stage_snapshot=?, version=version+1 WHERE id=?')
    .run(stage, stamp, stamp, '', app.id)
  const snap = insertStageEvent({
    applicationId: app.id, stage, fromStage: fromStage ?? app.stage, eventType,
    operator: operator || app.recruiter || 'HR-Sandy', candId: app.candidate_id, posId: app.position_id
  })
  // 事件刚写入，stage_snapshot 与其同源：直接固化为该阶段事件的评分快照
  db.prepare('UPDATE applications SET stage_snapshot=? WHERE id=?').run(JSON.stringify(snap), app.id)
  app.stage = stage
  app.version = num(app.version) + 1
  return { stage, snapshot: snap }
}

// 异常回退到上一阶段的协同：终态先解除（Offer 重置为已撤回），再写 rollback 事件与新的阶段快照
function rollbackStage(app, { operator, expectedVersion, reason = '' }) {
  checkVersion(app, expectedVersion)
  if (app.stage === 'rejected') {
    const target = PREV_STAGE[app.reject_from || ''] || ''
    if (!target) badRequest('该淘汰记录缺少回退来源，请先在追溯中确认来源阶段', 'rollback_no_source')
    return reopenRejected(app, { target, operator, reason })
  }
  const target = PREV_STAGE[app.stage]
  if (!target) badRequest('投递阶段无法继续回退', 'rollback_first_stage')
  // 从 Offer 阶段回退：进行中/已接受的 Offer 必须撤回，避免 Offer 页与流程页口径不一致
  if (app.stage === 'offer') withdrawActiveOffer(app, { operator, reason })
  if (app.stage === 'hired') withdrawAcceptedOffer(app, { operator, reason })
  return moveStage(app, target, { eventType: 'rollback', operator, fromStage: app.stage })
}

function reopenRejected(app, { target, operator, reason = '' }) {
  const of = offerOfApp(app.id)
  if (of && (of.status === 'accepted' || of.status === 'joined')) {
    badRequest('候选人已接受 Offer/已入职，不能从淘汰复活', 'terminal_locked')
  }
  if (of && of.status === 'pending') withdrawActiveOffer(app, { operator, reason, force: true })
  return moveStage(app, target, { eventType: 'rollback', operator, fromStage: 'rejected' })
}

function withdrawActiveOffer(app, { operator, reason = '', force = false }) {
  const of = offerOfApp(app.id)
  if (!of || (of.status !== 'pending' && !force)) return null
  const stamp = ts()
  db.prepare('UPDATE offers SET status=?, note=?, decided_at=?, decided_by=? WHERE id=?')
    .run('withdrawn', reason || of.note, stamp, operator || 'HR-Sandy', of.id)
  addOfferLog({
    offerId: of.id, applicationId: app.id, changeType: 'withdraw', of,
    toStatus: 'withdrawn', operator: operator || 'HR-Sandy', note: reason
  })
  of.status = 'withdrawn'
  return of
}

function withdrawAcceptedOffer(app, { operator, reason }) {
  const of = offerOfApp(app.id)
  if (!of || (of.status !== 'accepted' && of.status !== 'joined')) return null
  const stamp = ts()
  db.prepare('UPDATE offers SET status=?, note=?, decided_at=?, decided_by=?, joined_at=? WHERE id=?')
    .run('withdrawn', reason || of.note, stamp, operator || 'HR-Sandy', app.stage === 'hired' ? '' : of.joined_at, of.id)
  addOfferLog({
    offerId: of.id, applicationId: app.id, changeType: 'withdraw', of,
    toStatus: 'withdrawn', operator: operator || 'HR-Sandy', note: reason
  })
  of.status = 'withdrawn'
  return of
}

app.post('/api/applications', (req, res) => {
  const b = req.body || {}
  const pid = num(b.position_id), cid = num(b.candidate_id)
  const dup = db.prepare('SELECT id FROM applications WHERE position_id=? AND candidate_id=?').get(pid, cid)
  if (dup) return res.status(409).json({ ok: false, code: 'duplicate_application', msg: '该候选人已投递此职位，请勿重复投递' })
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(cid)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(pid)
  if (!cand || !pos) return res.status(404).json({ ok: false, msg: '职位或候选人不存在' })
  const out = tx(() => {
    // 投递时同步固化当前评分证据；不创建重算批次，避免把单个投递伪装成批量策略重算
    const m = upsertMatch(cid, pid, 0)
    const stamp = now()
    const snap = buildSnapshot(cid, pid, { ...m, computed_at: stamp }, {
      stage: 'submitted',
      stage_label: '投递',
      event_type: 'advance',
      matched_at: stamp,
      recalc_job_id: 0
    })
    const r = db.prepare('INSERT INTO applications(position_id,candidate_id,stage,updated,recruiter,match_snapshot,matched_at,stage_snapshot,entered_at,version) VALUES(?,?,?,?,?,?,?,?,?,1)')
      .run(pid, cid, 'submitted', ts(), b.recruiter || 'HR-Sandy', JSON.stringify(snap), snap.matched_at, JSON.stringify(snap), ts())
    const appId = Number(r.lastInsertRowid)
    insertStageEvent({
      applicationId: appId, stage: 'submitted', fromStage: '', eventType: 'advance',
      operator: b.recruiter || 'HR-Sandy', candId: cid, posId: pid, latest: m
    })
    return { id: appId }
  })
  res.json({ ok: true, id: out.id })
})

// 阶段推进已纳入审批链：一律 403 引导到「候选人推进」审批（批准后由 executeApproval 回写阶段）
app.post('/api/applications/:id/advance', (req, res, next) => {
  try {
    requireRole(req.body || {}, ['recruiter', 'hiring_manager'])
    forbidden('候选人推进需提交「推进审批」，由用人经理批准后自动回写阶段', 'approval_required')
  } catch (e) { next(e) }
})

app.post('/api/applications/:id/reject', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  try {
    requireRole(b, ['recruiter'])
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      checkVersion(a, b.version)
      if (a.stage === 'rejected') conflict('该候选人已淘汰，请勿重复操作', 'already_rejected')
      if (a.stage === 'hired') conflict('候选人已录用，不能淘汰；如需修正请走异常回退', 'hired_locked')
      // 待回应 Offer 随淘汰一并撤回，Offer 记录与流程阶段保持同一口径
      withdrawActiveOffer(a, { operator: b.operator, reason: b.reason || '候选人流程淘汰', force: true })
      const fromStage = a.stage
      const r = moveStage(a, 'rejected', {
        eventType: fromStage === 'offer' ? 'offer_rejected' : 'reject',
        operator: b.operator, fromStage
      })
      db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, id)
      return { ok: true, stage: 'rejected', from: fromStage, version: a.version, snapshot: r.snapshot }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 异常回退：仅允许回到上一阶段（淘汰复活除外），写 rollback 事件并刷新阶段快照，全程留痕
app.post('/api/applications/:id/rollback', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  try {
    requireRole(b, ['recruiter'])
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      const r = rollbackStage(a, { operator: b.operator, expectedVersion: b.version, reason: b.reason || '' })
      if (a.stage === 'rejected') db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(id)
      return { ok: true, stage: a.stage, version: a.version, snapshot: r.snapshot }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 面试 ----------------
app.post('/api/applications/:id/interview', (req, res, next) => {
  const b = req.body || {}
  try {
    requireRole(b, ['recruiter'])
    const out = tx(() => {
      const appId = num(req.params.id)
      const a = db.prepare('SELECT id,stage FROM applications WHERE id=?').get(appId)
      if (!a) return { notFound: true }
      if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能再安排面试', 'terminal_locked')
      const r = db.prepare('INSERT INTO interviews(application_id,interviewer,time,round,eval,result,conclusion) VALUES(?,?,?,?,?,?,\'pending\')')
        .run(appId, b.interviewer || '面试官', b.time || ts(), b.round || '初试', b.eval || '', b.result === 'pass' || b.result === 'fail' ? b.result : 'pending')
      return { ok: true, id: Number(r.lastInsertRowid) }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 面试评价可直接编辑（面试官/招聘负责人）；面试结论已纳入审批链，需提交「面试结论」审批
app.post('/api/interviews/:id', (req, res, next) => {
  const b = req.body || {}
  const ivId = num(req.params.id)
  try {
    requireRole(b, ['interviewer', 'recruiter'])
    const wantsConclusion = ['pass', 'fail', 'pending'].includes(b.conclusion) || ['pass', 'fail', 'pending'].includes(b.result)
    if (wantsConclusion) forbidden('面试结论需提交「面试结论审批」，由招聘负责人批准后自动回写并联动阶段', 'approval_required')
    const out = tx(() => {
      const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(ivId)
      if (!iv) return { notFound: true }
      const sets = [], vals = []
      if (b.eval !== undefined) { sets.push('eval=?'); vals.push(String(b.eval)) }
      if (b.interviewer !== undefined) { sets.push('interviewer=?'); vals.push(String(b.interviewer)) }
      if (b.time !== undefined) { sets.push('time=?'); vals.push(String(b.time)) }
      if (sets.length) {
        vals.push(ivId)
        db.prepare(`UPDATE interviews SET ${sets.join(',')} WHERE id=?`).run(...vals)
      }
      return { ok: true, conclusion: iv.conclusion || iv.result }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- Offer ----------------
const SALARY_MIN = 1000, SALARY_MAX = 1000000

// 发起 Offer 已纳入审批链：一律 403 引导到「Offer 发放」审批（批准后由 executeApproval 发放并回写）
app.post('/api/applications/:id/offer', (req, res, next) => {
  try {
    requireRole(req.body || {}, ['recruiter'])
    forbidden('Offer 发放需提交「Offer 发放审批」，经用人经理→招聘负责人批准后自动发放', 'approval_required')
  } catch (e) { next(e) }
})

// Offer 变更统一入口：
//  - 字段更新 salary/due/note 仅允许 pending（避免接受后暗改薪酬）
//  - status 仅允许 pending→accepted/rejected/withdrawn、accepted→joined（终态/跳跃变更拒绝）
//  - 每次变更追加 offer_change_logs；接受/拒绝/入职与应用阶段、阶段事件同事务提交
app.post('/api/offers/:id', (req, res, next) => {
  const b = req.body || {}
  const offerId = num(req.params.id)
  try {
    requireRole(b, ['recruiter'])
    const out = tx(() => {
      const of = db.prepare('SELECT * FROM offers WHERE id=?').get(offerId)
      if (!of) return { notFound: true }
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(of.application_id)
      if (!a) return { appNotFound: true }
      checkVersion(a, b.version)
      const operator = b.operator || a.recruiter || 'HR-Sandy'
      const stamp = ts()

      // ---- 字段变更（仅待回应可改，且写留痕）----
      if (b.salary !== undefined) {
        if (of.status !== 'pending') conflict('仅待回应的 Offer 可以调整薪资', 'offer_locked')
        const salary = num(b.salary, of.salary)
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        if (salary !== num(of.salary)) {
          db.prepare('UPDATE offers SET salary=? WHERE id=?').run(salary, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'update_salary', of, toStatus: of.status, toSalary: salary, operator, note: b.note || '' })
          of.salary = salary
        }
      }
      if (b.due !== undefined && String(b.due) !== String(of.due)) {
        if (of.status !== 'pending') conflict('仅待回应的 Offer 可以调整期限', 'offer_locked')
        db.prepare('UPDATE offers SET due=? WHERE id=?').run(String(b.due), offerId)
        addOfferLog({ offerId, applicationId: a.id, changeType: 'update_due', of, toStatus: of.status, toSalary: of.salary, operator })
      }
      if (b.note !== undefined && String(b.note) !== String(of.note)) {
        db.prepare('UPDATE offers SET note=? WHERE id=?').run(String(b.note), offerId)
      }

      // ---- 状态流转 ----
      let moved = null
      if (b.status && b.status !== of.status) {
        const s = b.status
        const allowed = {
          pending: ['accepted', 'rejected', 'withdrawn'],
          accepted: ['joined', 'withdrawn'],
          rejected: [], withdrawn: [], joined: []
        }[of.status] || []
        if (of.status === s) return { ok: true, idempotent: true, stage: a.stage, version: num(a.version) }
        if (!allowed.includes(s)) conflict(`Offer 不能从「${of.status}」变更为「${s}」，请按待回应→接受/拒绝→入职流转`, 'offer_transition')

        if (s === 'accepted') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=? WHERE id=?').run('accepted', stamp, operator, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'accept', of, toStatus: 'accepted', operator, note: b.note || '' })
          if (a.stage !== 'hired' && a.stage !== 'rejected') {
            // 接受 Offer 即进入「录用」阶段，固化当时评分证据
            moved = moveStage(a, 'hired', { eventType: 'offer_accepted', operator, fromStage: a.stage })
          }
        } else if (s === 'joined') {
          db.prepare('UPDATE offers SET status=?, joined_at=COALESCE(NULLIF(joined_at,\'\'),?), decided_at=? WHERE id=?')
            .run('joined', stamp, stamp, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'join', of: { ...of, status: 'accepted' }, toStatus: 'joined', operator, note: b.note || '' })
          if (a.stage !== 'hired') moved = moveStage(a, 'hired', { eventType: 'offer_accepted', operator, fromStage: a.stage })
        } else if (s === 'rejected') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=? WHERE id=?').run('rejected', stamp, operator, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'reject', of, toStatus: 'rejected', operator, note: b.note || '' })
          if (a.stage !== 'rejected') {
            const fromStage = a.stage
            moved = moveStage(a, 'rejected', { eventType: 'offer_rejected', operator, fromStage })
            db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, a.id)
          }
        } else if (s === 'withdrawn') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=?, note=? WHERE id=?')
            .run('withdrawn', stamp, operator, b.note || of.note, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'withdraw', of, toStatus: 'withdrawn', operator, note: b.note || '' })
          // 已接受/已入职后撤回：录用阶段同步回退到 Offer（单步回退，事件留痕）
          if (a.stage === 'hired') moved = moveStage(a, 'offer', { eventType: 'rollback', operator, fromStage: 'hired' })
        }
      }
      return { ok: true, status: b.status || of.status, stage: a.stage, version: num(a.version), moved: !!moved }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    if (out.appNotFound) return res.status(409).json({ ok: false, code: 'app_missing', msg: 'Offer 对应的应聘记录不存在' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 审批链 ----------------
// 提交审批：按类型校验发起角色与参数，生成任务+首个「提交」步骤，并通知首节点审批角色
app.post('/api/approvals', (req, res, next) => {
  const b = req.body || {}
  try {
    const type = b.type
    const conf = APPROVAL_TYPES[type]
    if (!conf) badRequest('未知审批类型', 'approval_type')
    requireRole(b, APPROVAL_REQUESTER[type])
    const operator = String(b.operator || '').trim()
    if (!operator) badRequest('缺少操作人', 'operator_required')
    const appId = num(b.application_id)
    const payload = b.payload || {}

    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(appId)
      if (!a) return { notFound: true }
      const c = db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
      const p = db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id)
      const who = `${c?.name || '候选人'} · ${p?.name || '职位'}`

      // 按类型做提交前校验（执行时会再校验一次，双保险）
      let interviewId = 0
      if (type === 'stage_advance') {
        const to = payload.to_stage
        if (a.stage === 'rejected') conflict('候选人已淘汰，请先「异常回退」复活', 'rejected_locked')
        if (NEXT_STAGE[a.stage] !== to) badRequest(`当前阶段为「${STAGE_LABEL[a.stage]}」，只能推进到「${STAGE_LABEL[NEXT_STAGE[a.stage]] || '终点'}」`, 'stage_mismatch')
        if (to === 'offer') assertCanEnterOffer(a)
        if (to === 'hired') {
          const of = offerOfApp(a.id)
          if (!of || of.status !== 'accepted') badRequest('候选人尚未接受 Offer，不能申请录用', 'offer_not_accepted')
        }
        assertNoOpenTask(type, appId)
      } else if (type === 'interview_conclusion') {
        interviewId = num(b.interview_id)
        const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(interviewId)
        if (!iv || iv.application_id !== appId) badRequest('面试记录不存在或不属于该应聘', 'interview_missing')
        if (!['pass', 'fail', 'pending'].includes(payload.conclusion)) badRequest('面试结论只能为 通过/不通过/待定', 'conclusion_invalid')
        if (a.stage === 'hired') conflict('候选人已录用，面试结论已锁定', 'terminal_locked')
        const current = iv.conclusion || iv.result || 'pending'
        if (payload.conclusion === current) conflict(`「${iv.round}」已是该结论，无需重复提交审批`, 'conclusion_same')
        assertNoOpenTask(type, appId, interviewId)
      } else if (type === 'offer_issue') {
        const salary = num(payload.salary)
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能发放 Offer', 'terminal_locked')
        if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) assertCanEnterOffer(a)
        const exist = offerOfApp(a.id)
        if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer', 'offer_duplicate')
        if (exist && (exist.status === 'accepted' || exist.status === 'joined')) conflict('该候选人的 Offer 已被接受', 'offer_accepted_locked')
        assertNoOpenTask(type, appId)
      }

      const stamp = ts()
      const r = db.prepare(`INSERT INTO approval_tasks(type,application_id,interview_id,payload,status,current_step,requested_by,requested_by_role,requested_at,updated)
                            VALUES(?,?,?,?,'pending',0,?,?,?,?)`)
        .run(type, appId, interviewId, JSON.stringify(payload), operator, b.role, stamp, stamp)
      const taskId = Number(r.lastInsertRowid)
      addApprovalStep(taskId, { seq: 0, stepRole: b.role, action: 'submit', operator, note: b.note || '' })
      notify({
        role: conf.chain[0],
        title: `【${conf.label}】待审批：${who}`,
        body: `${operator} 提交了「${conf.label}」审批，请及时处理`,
        taskId, applicationId: appId
      })
      return { ok: true, id: taskId }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '应聘记录不存在' })
    res.json(out)
  } catch (e) { next(e) }
})

// 审批/退回：仅当前节点角色可处理；批准到末节点时在同事务执行回写；退回则打回发起人
app.post('/api/approvals/:id/act', (req, res, next) => {
  const b = req.body || {}
  try {
    const action = b.action
    if (!['approve', 'return'].includes(action)) badRequest('审批动作只能为 approve/return', 'approval_action')
    const operator = String(b.operator || '').trim()
    if (!operator) badRequest('缺少操作人', 'operator_required')
    const out = tx(() => {
      const t = approvalTask(req.params.id)
      if (!t) return { notFound: true }
      if (t.status !== 'pending') conflict(`该审批已${APPROVAL_STATUS_LABEL[t.status]}，请勿重复处理`, 'approval_done')
      const conf = APPROVAL_TYPES[t.type]
      const stepIdx = num(t.current_step)
      const needRole = conf.chain[stepIdx]
      requireRole(b, [needRole])
      if (operator === t.requested_by) forbidden('不能审批自己提交的申请', 'self_approval')
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(t.application_id)
      const c = a ? db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id) : null
      const who = c?.name || '候选人'
      const stamp = ts()

      if (action === 'return') {
        db.prepare("UPDATE approval_tasks SET status='returned', decided_at=?, decide_note=?, updated=? WHERE id=?")
          .run(stamp, b.note || '', stamp, t.id)
        addApprovalStep(t.id, { seq: stepIdx, stepRole: needRole, action: 'return', operator, note: b.note || '' })
        notify({
          role: t.requested_by_role, recipient: t.requested_by,
          title: `【${conf.label}】已退回：${who}`,
          body: `${operator}（${ROLES[needRole]}）退回了你的「${conf.label}」审批${b.note ? `：${b.note}` : ''}，可修改后重新提交`,
          taskId: t.id, applicationId: t.application_id
        })
        return { ok: true, status: 'returned' }
      }

      // 批准：记录本节点；未到末节点则流转下一节点，到末节点则执行回写
      addApprovalStep(t.id, { seq: stepIdx, stepRole: needRole, action: 'approve', operator, note: b.note || '' })
      if (stepIdx < conf.chain.length - 1) {
        db.prepare('UPDATE approval_tasks SET current_step=?, updated=? WHERE id=?').run(stepIdx + 1, stamp, t.id)
        notify({
          role: conf.chain[stepIdx + 1],
          title: `【${conf.label}】待终审：${who}`,
          body: `「${conf.label}」审批已经${ROLES[needRole]}批准，等待你终审`,
          taskId: t.id, applicationId: t.application_id
        })
        return { ok: true, status: 'pending', next_step: stepIdx + 1 }
      }
      const result = executeApproval(t, t.requested_by)
      db.prepare("UPDATE approval_tasks SET status='approved', decided_at=?, decide_note=?, updated=? WHERE id=?")
        .run(stamp, b.note || '', stamp, t.id)
      notify({
        role: t.requested_by_role, recipient: t.requested_by,
        title: `【${conf.label}】已通过：${who}`,
        body: `你的「${conf.label}」审批已通过。${result.detail}`,
        taskId: t.id, applicationId: t.application_id
      })
      return { ok: true, status: 'approved', detail: result.detail }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '审批任务不存在' })
    res.json(out)
  } catch (e) { next(e) }
})

// 重新提交：仅发起人、仅「已退回」状态；可修改参数快照后回到审批链首节点
app.post('/api/approvals/:id/resubmit', (req, res, next) => {
  const b = req.body || {}
  try {
    const operator = String(b.operator || '').trim()
    const out = tx(() => {
      const t = approvalTask(req.params.id)
      if (!t) return { notFound: true }
      if (t.status !== 'returned') conflict('仅「已退回」的审批可以重新提交', 'approval_not_returned')
      if (operator !== t.requested_by) forbidden('只有发起人本人可以重新提交', 'not_requester')
      const conf = APPROVAL_TYPES[t.type]
      // 合并修改后的参数并重新做提交前校验
      const payload = { ...parseJSON(t.payload, {}), ...(b.payload || {}) }
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(t.application_id)
      if (!a) return { notFound: true }
      if (t.type === 'stage_advance') {
        if (NEXT_STAGE[a.stage] !== payload.to_stage) badRequest(`当前阶段为「${STAGE_LABEL[a.stage]}」，目标阶段需调整为「${STAGE_LABEL[NEXT_STAGE[a.stage]] || '终点'}」`, 'stage_mismatch')
        if (payload.to_stage === 'offer') assertCanEnterOffer(a)
      } else if (t.type === 'interview_conclusion') {
        if (!['pass', 'fail', 'pending'].includes(payload.conclusion)) badRequest('面试结论只能为 通过/不通过/待定', 'conclusion_invalid')
      } else if (t.type === 'offer_issue') {
        const salary = num(payload.salary)
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        const exist = offerOfApp(a.id)
        if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer', 'offer_duplicate')
      }
      const stamp = ts()
      db.prepare("UPDATE approval_tasks SET payload=?, status='pending', current_step=0, decided_at='', decide_note='', updated=? WHERE id=?")
        .run(JSON.stringify(payload), stamp, t.id)
      addApprovalStep(t.id, { seq: 0, stepRole: t.requested_by_role, action: 'resubmit', operator, note: b.note || '' })
      notify({
        role: conf.chain[0],
        title: `【${conf.label}】重新提交待审批`,
        body: `${operator} 修改后重新提交了「${conf.label}」审批（#${t.id}）`,
        taskId: t.id, applicationId: t.application_id
      })
      return { ok: true, status: 'pending' }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '审批任务不存在' })
    res.json(out)
  } catch (e) { next(e) }
})

// 取消：仅发起人，审批中/已退回可取消
app.post('/api/approvals/:id/cancel', (req, res, next) => {
  const b = req.body || {}
  try {
    const operator = String(b.operator || '').trim()
    const out = tx(() => {
      const t = approvalTask(req.params.id)
      if (!t) return { notFound: true }
      if (!['pending', 'returned'].includes(t.status)) conflict('仅审批中/已退回的审批可以取消', 'approval_done')
      if (operator !== t.requested_by) forbidden('只有发起人本人可以取消', 'not_requester')
      const stamp = ts()
      db.prepare("UPDATE approval_tasks SET status='cancelled', updated=? WHERE id=?").run(stamp, t.id)
      addApprovalStep(t.id, { seq: num(t.current_step), stepRole: t.requested_by_role, action: 'cancel', operator, note: b.note || '' })
      return { ok: true, status: 'cancelled' }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '审批任务不存在' })
    res.json(out)
  } catch (e) { next(e) }
})

// 通知已读：按角色（+本人）一键已读
app.post('/api/notifications/read', (req, res) => {
  const b = req.body || {}
  db.prepare(`UPDATE notifications SET read=1 WHERE read=0 AND (recipient=? OR (recipient='' AND recipient_role=?))`)
    .run(String(b.operator || ''), String(b.role || ''))
  res.json({ ok: true })
})

// ---------------- 渠道 ----------------
app.post('/api/channels', (req, res) => {
  const b = req.body || {}
  db.prepare('INSERT INTO channels(name,cost) VALUES(?,?)').run(b.name, num(b.cost, 5000))
  res.json({ ok: true })
})

// 启动迁移：旧库中已有的 matches/applications 归入一个 startup 批次，并补齐投递快照与阶段事件
function migrateHistory() {
  const hadStartupJob = db.prepare("SELECT COUNT(*) c FROM recalc_jobs WHERE trigger_type='startup'").get().c > 0
  const pairRows = db.prepare(`
    SELECT candidate_id, position_id FROM matches
    UNION SELECT candidate_id, position_id FROM applications
  `).all()
  const appsNeedBackfill = db.prepare(`
    SELECT a.* FROM applications a
    WHERE (a.match_snapshot IS NULL OR a.match_snapshot='')
       OR NOT EXISTS (SELECT 1 FROM application_events e WHERE e.application_id=a.id)
  `).all()

  if (!pairRows.length || (hadStartupJob && !appsNeedBackfill.length)) return

  tx(() => {
    let jobId = 0
    const latestStartupJob = hadStartupJob
      ? num(db.prepare("SELECT MAX(id) id FROM recalc_jobs WHERE trigger_type='startup'").get().id || 0)
      : 0
    if (pairRows.length && !hadStartupJob) {
      jobId = createRecalcJob({ triggerType: 'startup', scope: 'startup', triggeredBy: 'system-migration' })
      pairRows.forEach(r => upsertMatch(r.candidate_id, r.position_id, jobId))
      completeRecalcJob(jobId, pairRows.length)
    } else {
      jobId = latestStartupJob
    }

    appsNeedBackfill.forEach(a => {
      let snap = parseJSON(a.match_snapshot, null)
      const latest = resultFromStored(getStoredMatch(a.candidate_id, a.position_id))
      const item = latestJobForPair(a.candidate_id, a.position_id)
      if (!snap) {
        snap = buildSnapshot(a.candidate_id, a.position_id, latest || {
          score: 0, dims: [], reason: '暂无已发布评分', weakness: '暂无评分依据'
        }, {
          stage: 'submitted', stage_label: '投递', event_type: 'advance',
          recalc_job_id: item?.job_id || jobId, backfilled: true
        })
        db.prepare('UPDATE applications SET match_snapshot=?, matched_at=? WHERE id=?')
          .run(JSON.stringify(snap), snap.matched_at, a.id)
      }

      const eventExists = stage => db.prepare('SELECT id FROM application_events WHERE application_id=? AND stage=?').get(a.id, stage)
      const insertRawEvent = (stage, eventType, fromStage, payload) => {
        const enriched = {
          ...payload,
          stage,
          stage_label: { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }[stage] || stage,
          event_type: eventType,
          event_at: payload.event_at || payload.matched_at || ts(),
          backfilled: true
        }
        db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,recalc_job_id,backfilled)
                    VALUES(?,?,?,?,?,?,?,?,?,?,1)`)
          .run(a.id, stage, fromStage, eventType, enriched.event_at, a.recruiter || 'system-migration',
            JSON.stringify(enriched), num(enriched.score), num(enriched.strategy_id),
            num(enriched.recalc_job_id || item?.job_id || jobId))
      }

      if (!eventExists('submitted')) insertRawEvent('submitted', 'advance', '', snap)
      if (a.stage !== 'submitted' && !eventExists(a.stage)) {
        const order = ['submitted', 'screening', 'interview', 'offer', 'hired']
        const currentIndex = order.indexOf(a.stage)
        const fromStage = currentIndex > 0 ? order[currentIndex - 1] : 'submitted'
        const eventType = a.stage === 'rejected' ? 'reject' : 'advance'
        const stageSnap = buildSnapshot(a.candidate_id, a.position_id, latest || snap, {
          recalc_job_id: item?.job_id || jobId
        })
        insertRawEvent(a.stage, eventType, a.stage === 'rejected' ? fromStage : fromStage, stageSnap)
      }
    })

    if (jobId) console.log(`[HR] startup recalc job #${jobId} refreshed ${pairRows.length} pairs`)
    if (appsNeedBackfill.length) console.log(`[HR] backfilled trace events for ${appsNeedBackfill.length} applications`)
  })
}
migrateHistory()

// 统一业务错误出口：ApiError 携带状态码与错误码，其余错误按 500 返回
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ ok: false, code: err.code, msg: err.message })
  console.error('[HR] unhandled error:', err)
  res.status(500).json({ ok: false, code: 'internal', msg: '服务内部错误' })
})

app.listen(PORT, () => console.log(`[HR] API running at http://localhost:${PORT}`))