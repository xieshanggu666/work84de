<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const tab = ref('todo')
const noteOf = ref({})      // 各任务审批意见输入
const editOf = ref({})      // 退回重提时的参数编辑

const STAGE_LABEL = { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }
const CONCLUSION_LABEL = { pass: '✅ 通过', fail: '❌ 不通过', pending: '⏳ 待定' }
const STATUS_META = {
  pending: ['⏳', 'var(--accent2)'], approved: ['✅', 'var(--green)'],
  returned: ['↩️', 'var(--red)'], cancelled: ['🚫', 'var(--muted)']
}
const TYPE_ICON = { stage_advance: '➡️', interview_conclusion: '💬', offer_issue: '📄' }

const todo = computed(() => store.todoApprovals)
const mine = computed(() => store.approvals.filter(t => t.requested_by === store.me?.name))
const all = computed(() => store.approvals)

const appOf = id => store.applications.find(a => a.id === id) || null
const fmtTime = t => t ? String(t).replace('T', ' ').slice(0, 16) : ''
const busy = t => !!store.pending[`appr:${t.id}`]

// 审批内容摘要：推进→目标阶段；结论→结论；Offer→薪资
function summary(t) {
  if (t.type === 'stage_advance') return `推进到「${STAGE_LABEL[t.payload.to_stage] || t.payload.to_stage}」`
  if (t.type === 'interview_conclusion') {
    const iv = appOf(t.application_id)?.interviews?.find(i => i.id === t.interview_id)
    return `${iv ? `「${iv.round}」` : ''}结论：${CONCLUSION_LABEL[t.payload.conclusion] || t.payload.conclusion}`
  }
  if (t.type === 'offer_issue') return `月薪 ¥${Number(t.payload.salary || 0).toLocaleString()}${t.payload.due ? ` · 期限 ${t.payload.due}` : ''}`
  return ''
}
function subject(t) {
  const a = appOf(t.application_id)
  return a ? `${a.candidate} · ${a.position}` : `应聘 #${t.application_id}`
}

function act(t, action) {
  store.actApproval(t.id, action, noteOf.value[t.id] || '')
  noteOf.value = { ...noteOf.value, [t.id]: '' }
}

// 退回重提：按类型初始化可编辑参数
function startEdit(t) {
  editOf.value = { ...editOf.value, [t.id]: { ...t.payload } }
}
function resubmit(t) {
  store.resubmitApproval(t.id, editOf.value[t.id] || {}, noteOf.value[t.id] || '')
  const next = { ...editOf.value }
  delete next[t.id]
  editOf.value = next
}
</script>

<template>
  <div class="approval">
    <div class="bar">
      <div class="tabs">
        <button :class="{ on: tab === 'todo' }" @click="tab = 'todo'">📥 待我审批 <em class="tag">{{ todo.length }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">📤 我发起的 <em class="tag">{{ mine.length }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">🗂 审批流水 <em class="tag">{{ all.length }}</em></button>
      </div>
      <span class="muted">当前身份：{{ store.me?.name }}（{{ store.roles[store.myRole] }}）</span>
    </div>

    <div class="consistency card">
      <span>🔐 审批链：候选人推进 → <b>用人经理</b>；面试结论 → <b>招聘负责人</b>；Offer 发放 → <b>用人经理 → 招聘负责人终审</b>。任一节点可退回，发起人修改后重新提交；批准后在同一事务回写招聘阶段 / Offer 状态，并保留审计通知。</span>
    </div>

    <!-- 待我审批 -->
    <div v-if="tab === 'todo'" class="tlist">
      <div class="tcard card" v-for="t in todo" :key="t.id">
        <div class="tmain">
          <div class="thead">
            <span class="ttype">{{ TYPE_ICON[t.type] }} {{ t.type_label }}</span>
            <b>{{ subject(t) }}</b>
            <em class="muted">#{{ t.id }}</em>
          </div>
          <div class="tbody-line">{{ summary(t) }}</div>
          <div class="muted tmeta">发起人 {{ t.requested_by }}（{{ t.requested_by_role === 'recruiter' ? '招聘负责人' : '面试官' }}） · {{ fmtTime(t.requested_at) }} · 当前第 {{ t.current_step + 1 }}/{{ t.chain.length }} 级</div>
          <input class="note-input" v-model="noteOf[t.id]" placeholder="审批意见（退回时必填说明，可选）" />
        </div>
        <div class="tacts">
          <button class="succ" :disabled="busy(t)" @click="act(t, 'approve')">✅ 批准</button>
          <button class="warn" :disabled="busy(t)" @click="act(t, 'return')">↩️ 退回</button>
        </div>
      </div>
      <div class="card empty" v-if="!todo.length">当前没有待你审批的任务。</div>
    </div>

    <!-- 我发起的 -->
    <div v-if="tab === 'mine'" class="tlist">
      <div class="tcard card" v-for="t in mine" :key="t.id">
        <div class="tmain">
          <div class="thead">
            <span class="ttype">{{ TYPE_ICON[t.type] }} {{ t.type_label }}</span>
            <b>{{ subject(t) }}</b>
            <span class="tstatus" :style="{ color: STATUS_META[t.status][1], borderColor: STATUS_META[t.status][1] }">{{ STATUS_META[t.status][0] }} {{ t.status_label }}</span>
          </div>
          <div class="tbody-line">{{ summary(t) }}</div>
          <div class="muted tmeta">
            提交于 {{ fmtTime(t.requested_at) }}
            <template v-if="t.status === 'pending'"> · 等待「{{ t.current_role_label }}」审批（第 {{ t.current_step + 1 }}/{{ t.chain.length }} 级）</template>
            <template v-if="t.decide_note"> · 审批意见：{{ t.decide_note }}</template>
          </div>
          <!-- 退回后修改重提 -->
          <div class="reedit" v-if="t.status === 'returned' && editOf[t.id]">
            <template v-if="t.type === 'offer_issue'">
              <label class="muted">月薪 <input type="number" v-model.number="editOf[t.id].salary" min="1000" max="1000000" /> ¥/月</label>
            </template>
            <template v-else-if="t.type === 'interview_conclusion'">
              <label class="muted">结论
                <select v-model="editOf[t.id].conclusion">
                  <option value="pass">通过</option><option value="fail">不通过</option><option value="pending">待定</option>
                </select>
              </label>
            </template>
            <input class="note-input" v-model="noteOf[t.id]" placeholder="重新提交说明（可选）" />
          </div>
        </div>
        <div class="tacts">
          <template v-if="t.status === 'returned'">
            <button v-if="!editOf[t.id]" class="primary" @click="startEdit(t)">✏️ 修改重提</button>
            <button v-else class="succ" :disabled="busy(t)" @click="resubmit(t)">📨 重新提交</button>
          </template>
          <button v-if="['pending', 'returned'].includes(t.status)" class="ghost" :disabled="busy(t)" @click="store.cancelApproval(t.id)">取消</button>
        </div>
      </div>
      <div class="card empty" v-if="!mine.length">你还没有发起过审批。可在「招聘流程 / 面试管理 / Offer 管理」中发起。</div>
    </div>

    <!-- 审批流水（审计） -->
    <div v-if="tab === 'all'" class="tlist">
      <div class="tcard card" v-for="t in all" :key="t.id">
        <div class="tmain">
          <div class="thead">
            <span class="ttype">{{ TYPE_ICON[t.type] }} {{ t.type_label }}</span>
            <b>{{ subject(t) }}</b>
            <span class="tstatus" :style="{ color: STATUS_META[t.status][1], borderColor: STATUS_META[t.status][1] }">{{ STATUS_META[t.status][0] }} {{ t.status_label }}</span>
            <em class="muted">#{{ t.id }}</em>
          </div>
          <div class="tbody-line">{{ summary(t) }}</div>
          <div class="chain">
            <span class="cnode" v-for="(role, i) in t.chain" :key="role"
              :class="{ done: t.status === 'approved' || i < t.current_step, now: t.status === 'pending' && i === t.current_step }">
              {{ t.chain_labels[i] }}
            </span>
          </div>
          <div class="steps">
            <div class="step" v-for="s in t.steps" :key="s.id">
              <span class="saction" :class="s.action">{{ s.action_label }}</span>
              <span>{{ s.operator }}<em class="muted" v-if="s.role_label">（{{ s.role_label }}）</em></span>
              <span class="muted" v-if="s.note">「{{ s.note }}」</span>
              <em class="muted stime">{{ fmtTime(s.acted_at) }}</em>
            </div>
          </div>
        </div>
      </div>
      <div class="card empty" v-if="!all.length">暂无审批记录。</div>
    </div>
  </div>
</template>

<style scoped>
.approval { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.tabs { display: flex; gap: 8px; }
.tabs button { padding: 7px 14px; font-size: 13px; opacity: .75; }
.tabs button.on { opacity: 1; border-color: var(--accent); background: rgba(91,140,255,.15); color: var(--accent); }
.tabs .tag { margin-left: 4px; }
.consistency { padding: 9px 12px; font-size: 12px; color: var(--muted); background: rgba(91,140,255,.07); border-color: rgba(91,140,255,.28); }
.consistency b { color: var(--accent); font-weight: 600; margin: 0 2px; }
.tlist { display: flex; flex-direction: column; gap: 10px; }
.tcard { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; padding: 13px 15px; }
.tmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.thead { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.ttype { font-size: 12px; color: var(--accent); background: rgba(91,140,255,.1); border: 1px solid rgba(91,140,255,.3); padding: 2px 8px; border-radius: 10px; }
.tstatus { font-size: 11px; border: 1px solid; padding: 2px 8px; border-radius: 10px; }
.tbody-line { font-size: 13px; }
.tmeta { font-size: 11.5px; }
.tacts { display: flex; gap: 8px; flex-shrink: 0; }
.note-input { background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 7px 10px; font-size: 12px; font-family: inherit; }
.reedit { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: var(--panel2); border-radius: 8px; padding: 8px 10px; }
.reedit label { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.reedit input[type="number"] { width: 110px; padding: 5px 8px; }
.reedit select { padding: 5px 8px; }
.chain { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.cnode { padding: 2px 9px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); }
.cnode:not(:last-child)::after { content: '→'; margin-left: 6px; color: var(--muted); }
.cnode.done { color: var(--green); border-color: rgba(87,214,160,.4); background: rgba(87,214,160,.08); }
.cnode.now { color: var(--accent2); border-color: rgba(255,209,102,.45); background: rgba(255,209,102,.1); }
.steps { display: flex; flex-direction: column; gap: 4px; border-top: 1px dashed var(--border); padding-top: 7px; }
.step { display: flex; gap: 8px; align-items: center; font-size: 12px; flex-wrap: wrap; }
.saction { font-size: 10px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--border); color: var(--muted); }
.saction.approve { color: var(--green); border-color: rgba(87,214,160,.4); }
.saction.return { color: var(--red); border-color: rgba(255,107,122,.4); }
.saction.submit, .saction.resubmit { color: var(--accent); border-color: rgba(91,140,255,.4); }
.stime { margin-left: auto; font-style: normal; font-size: 11px; }
.empty { text-align: center; color: var(--muted); font-size: 13px; padding: 22px; }
</style>
