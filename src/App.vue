<script setup>
import { ref, computed, onMounted } from 'vue'
import { useHrStore } from '@/store/hr'
import OverviewView from '@/components/OverviewView.vue'
import PositionsView from '@/components/PositionsView.vue'
import CandidatesView from '@/components/CandidatesView.vue'
import MatchView from '@/components/MatchView.vue'
import PipelineView from '@/components/PipelineView.vue'
import InterviewView from '@/components/InterviewView.vue'
import OfferView from '@/components/OfferView.vue'
import ApprovalView from '@/components/ApprovalView.vue'
import ReportsView from '@/components/ReportsView.vue'

const store = useHrStore()
const view = ref('overview')
const showNotif = ref(false)

const navs = [
  { k: 'overview', icon: '📊', label: '招聘总览' },
  { k: 'positions', icon: '📌', label: '职位管理' },
  { k: 'candidates', icon: '👥', label: '候选人库' },
  { k: 'match', icon: '🎯', label: '智能匹配' },
  { k: 'pipeline', icon: '🔄', label: '招聘流程' },
  { k: 'interview', icon: '💬', label: '面试管理' },
  { k: 'offer', icon: '📄', label: 'Offer 管理' },
  { k: 'approval', icon: '✅', label: '审批中心' },
  { k: 'reports', icon: '📈', label: '报表中心' }
]

const myNotifs = computed(() => store.myNotifications.slice(0, 30))
function switchMember(e) {
  const m = store.members.find(x => x.id === Number(e.target.value))
  if (m) store.setMe(m)
}
function toggleNotif() {
  showNotif.value = !showNotif.value
  if (showNotif.value && store.unreadCount) store.markNotificationsRead()
}

onMounted(store.refresh)
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <span class="logo">📋</span>
        <div><b>TalentFlow</b><em class="muted">招聘智能匹配平台</em></div>
      </div>
      <nav>
        <button v-for="n in navs" :key="n.k" class="navitem" :class="{ on: view === n.k }" @click="view = n.k">
          <span>{{ n.icon }}</span>{{ n.label }}
          <em v-if="n.k === 'approval' && store.todoApprovals.length" class="nav-badge">{{ store.todoApprovals.length }}</em>
        </button>
      </nav>
      <div class="mini card">
        <div class="mini-row"><span class="muted">在招职位</span><b>{{ store.openPositions.length }}</b></div>
        <div class="mini-row"><span class="muted">候选池</span><b>{{ store.candidates.length }}</b></div>
        <div class="mini-row"><span class="muted">在途应聘</span><b>{{ store.applications.filter(a => !['hired','rejected'].includes(a.stage)).length }}</b></div>
      </div>
    </aside>

    <main>
      <header class="topbar">
        <h2>{{ navs.find(n => n.k === view)?.label }}</h2>
        <div class="pills">
          <span class="pill">💼 在招 <b>{{ store.openPositions.length }}</b></span>
          <span class="pill">👥 候选人 <b>{{ store.candidates.length }}</b></span>
          <span class="pill">🎉 已入职 <b>{{ store.offers.filter(o => o.status === 'joined').length }}</b></span>
          <!-- 审计通知铃铛：按当前身份（角色+本人）聚合 -->
          <span class="pill bell" @click="toggleNotif">
            🔔 通知 <b v-if="store.unreadCount" class="unread">{{ store.unreadCount }}</b>
          </span>
          <!-- 身份切换：不同角色看到/可执行的审批与操作不同 -->
          <select class="me-select" :value="store.me?.id" @change="switchMember" title="切换当前操作身份">
            <option v-for="m in store.members" :key="m.id" :value="m.id">{{ m.name }} · {{ m.title }}</option>
          </select>
        </div>
      </header>

      <!-- 通知面板：审批提交/批准/退回/执行结果的审计留痕 -->
      <div class="notif-panel card" v-if="showNotif">
        <div class="np-head"><b>🔔 审计通知</b><button class="ghost sm" @click="showNotif = false">收起</button></div>
        <div class="np-item" v-for="n in myNotifs" :key="n.id" :class="{ unread: !n.read }">
          <div class="np-title">{{ n.title }}<em class="muted np-time">{{ n.created_at }}</em></div>
          <div class="muted np-body">{{ n.body }}</div>
        </div>
        <div class="muted np-empty" v-if="!myNotifs.length">暂无通知。</div>
      </div>

      <section class="views">
        <OverviewView v-if="view === 'overview'" />
        <PositionsView v-else-if="view === 'positions'" />
        <CandidatesView v-else-if="view === 'candidates'" />
        <MatchView v-else-if="view === 'match'" />
        <PipelineView v-else-if="view === 'pipeline'" />
        <InterviewView v-else-if="view === 'interview'" />
        <OfferView v-else-if="view === 'offer'" />
        <ApprovalView v-else-if="view === 'approval'" />
        <ReportsView v-else />
      </section>
    </main>

    <!-- 全局操作反馈：业务约束（重复操作/状态冲突/版本过期）由服务端统一返回，此处统一展示 -->
    <transition name="toast">
      <div v-if="store.toast" class="toast" :class="store.toast.type">
        <span>{{ store.toast.type === 'success' ? '✅' : '⚠️' }}</span>{{ store.toast.msg }}
      </div>
    </transition>
  </div>
</template>

<style scoped>
.layout { display: flex; min-height: 100vh; }
.sidebar { width: 225px; flex-shrink: 0; padding: 18px 14px; background: rgba(13,18,32,.85); border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; gap: 10px; align-items: center; padding: 4px 6px; }
.brand .logo { font-size: 28px; }
.brand b { font-size: 17px; display: block; }
.brand em { font-style: normal; font-size: 11px; }
nav { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.navitem { display: flex; align-items: center; gap: 10px; text-align: left; width: 100%; background: transparent; border: 1px solid transparent; color: var(--muted); font-size: 14px; padding: 10px 12px; }
.navitem:hover { background: var(--panel); color: var(--text); }
.navitem.on { background: linear-gradient(135deg, rgba(91,140,255,.2), rgba(91,140,255,.05)); border-color: rgba(91,140,255,.4); color: var(--accent); }
.mini { display: flex; flex-direction: column; gap: 8px; }
.mini-row { display: flex; justify-content: space-between; font-size: 13px; }
.mini-row b { color: var(--accent2); }
main { flex: 1; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; border-bottom: 1px solid var(--border); background: rgba(13,18,32,.6); position: sticky; top: 0; z-index: 20; backdrop-filter: blur(6px); }
.pills { display: flex; gap: 10px; }
.pill { font-size: 13px; color: var(--muted); background: var(--panel); border: 1px solid var(--border); padding: 6px 12px; border-radius: 20px; }
.pill b { color: var(--text); }
.pill.bell { cursor: pointer; user-select: none; }
.pill.bell:hover { border-color: var(--accent); }
.unread { color: var(--accent2) !important; }
.me-select { max-width: 180px; padding: 6px 10px; font-size: 13px; border-radius: 20px; }
.nav-badge { margin-left: auto; font-style: normal; font-size: 10px; background: var(--accent2); color: #2b1d00; border-radius: 9px; padding: 1px 7px; font-weight: 700; }
.notif-panel { position: fixed; top: 62px; right: 22px; z-index: 60; width: min(420px, 92vw); max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 14px 40px rgba(0,0,0,.5); }
.np-head { display: flex; justify-content: space-between; align-items: center; }
.np-head .sm { font-size: 11px; padding: 3px 9px; }
.np-item { background: var(--panel2); border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px; }
.np-item.unread { border-color: rgba(255,209,102,.4); }
.np-title { font-size: 13px; display: flex; justify-content: space-between; gap: 8px; }
.np-time { font-style: normal; font-size: 11px; flex-shrink: 0; }
.np-body { font-size: 12px; margin-top: 3px; }
.np-empty { text-align: center; font-size: 12px; padding: 12px; }
.toast { position: fixed; right: 22px; bottom: 22px; z-index: 100; padding: 11px 16px; border-radius: 10px; font-size: 13px;
  background: rgba(19,25,44,.96); border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,.4);
  display: flex; align-items: center; gap: 8px; max-width: 380px; }
.toast.success { border-color: rgba(87,214,160,.5); color: var(--green); }
.toast.error { border-color: rgba(255,107,122,.55); color: var(--red); }
.toast-enter-active, .toast-leave-active { transition: .22s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(10px); }
</style>