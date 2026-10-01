<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const open = ref(false)
const editing = ref(null)
const form = ref({ name: '', dept: '技术部', city: '上海', level: 'P5', salary_min: 15000, salary_max: 30000, years: 2, slots: 1 })
const skillInput = ref('')
const skills = ref([])

const depts = ['技术部', '产品部', '设计部', '数据部', '质量部', '市场部']
const cities = ['北京', '上海', '深圳', '杭州', '广州', '成都', '武汉', '南京']

const appCount = pid => store.applications.filter(a => a.position_id === pid).length

// ---------------- 按职位匹配策略 ----------------
const DIM_META = [
  { k: 'skill', label: '技能匹配' },
  { k: 'year', label: '经验年限' },
  { k: 'salary', label: '薪资带宽' },
  { k: 'edu', label: '学历' },
  { k: 'city', label: '城市地点' }
]
const strategyOpen = ref(false)
const strategyPos = ref(null)
const strategyForm = ref({ weights: {}, keyword_cap: 5 })
const strategySaving = ref(false)
const strategyMsg = ref('')
const weightPct = k => Math.round((strategyForm.value.weights[k] || 0) * 100)
const weightSumPct = computed(() => Object.values(strategyForm.value.weights).reduce((s, v) => s + (Number(v) || 0), 0))
const lastVersionOf = pid => store.strategyVersions.find(v => v.position_id === pid) || null

async function openStrategy(p) {
  strategyPos.value = p
  strategyMsg.value = ''
  const r = await store.getStrategy(p.id)
  const st = r.strategy || {}
  strategyForm.value = { weights: { ...(st.weights || store.defaultStrategy.weights) }, keyword_cap: st.keywordCap ?? store.defaultStrategy.keywordCap }
  strategyOpen.value = true
}
function setWeight(k, pct) { strategyForm.value.weights[k] = Math.round(Number(pct)) / 100 }
async function submitStrategy(reset = false) {
  strategySaving.value = true
  strategyMsg.value = ''
  const r = await store.publishStrategy(strategyPos.value.id, {
    reset,
    weights: strategyForm.value.weights,
    keyword_cap: Number(strategyForm.value.keyword_cap),
    recalc: true,
    published_by: 'HR'
  })
  strategySaving.value = false
  if (r?.ok) {
    strategyMsg.value = `策略 ${r.strategy?.versionId ? 'v' + r.strategy.versionId : 'v0'} 已发布，批次 #${r.job_id || '-'} 已重算 ${r.recalced} 个候选人`
    setTimeout(() => { strategyOpen.value = false }, 900)
  } else {
    strategyMsg.value = '发布失败，请重试'
  }
}

function openNew() {
  editing.value = null
  form.value = { name: '', dept: '技术部', city: '上海', level: 'P5', salary_min: 15000, salary_max: 30000, years: 2, slots: 1 }
  skills.value = []
  skillInput.value = ''
  open.value = true
}
function openEdit(p) {
  editing.value = p
  form.value = { name: p.name, dept: p.dept, city: p.city, level: p.level, salary_min: p.salary_min, salary_max: p.salary_max, years: p.years, slots: p.slots }
  skills.value = p.skills.map(s => ({ ...s }))
  skillInput.value = ''
  open.value = true
}
function addSkill() {
  const k = skillInput.value.trim()
  if (k) skills.value.push({ k, w: 5 })
  skillInput.value = ''
}
function submit() {
  const payload = { ...form.value, skills: skills.value }
  if (editing.value) store.updatePosition(editing.value.id, { status: 'open' })
  else store.addPosition(payload)
  open.value = false
}
</script>

<template>
  <div class="positions">
    <div class="bar">
      <span class="muted">共 {{ store.positions.length }} 个职位 · 在招 {{ store.openPositions.length }}</span>
      <button class="primary" @click="openNew">＋ 发布职位</button>
    </div>

    <div class="cards">
      <div class="pcard card" v-for="p in store.positions" :key="p.id" :class="{ closed: p.status === 'closed' }">
        <div class="phead">
          <div>
            <b>{{ p.name }}</b>
            <span class="tag" :class="p.status">{{
            p.status === 'open' ? '🔥 招聘中' : '⏸ 已关闭' }}</span>
          </div>
          <div class="meta muted">
            <span>🏢 {{ p.dept }}</span><span>📍 {{ p.city }}</span><span>{{ p.level }}</span>
          </div>
        </div>
        <div class="sal money">¥{{ p.salary_min.toLocaleString() }} - {{ p.salary_max.toLocaleString() }}</div>
        <div class="chips">
          <span class="skill-chip" v-for="s in p.skills" :key="s.k">{{ s.k }} <i>x{{ s.w }}</i></span>
        </div>
        <div class="pmeta muted">
          <span>经验 {{ p.years }} 年+</span><span>编制 {{ p.slots }}</span><span>应聘 {{ appCount(p.id) }}</span>
        </div>
        <div class="stline">
          <span class="st-tag" :class="{ custom: !!p.strategy }">
            {{ p.strategy ? `⚙️ 定制策略 ${lastVersionOf(p.id) ? `v${lastVersionOf(p.id).id}` : ''}` : '⚙️ 默认匹配策略 v0' }}
          </span>
          <span class="muted st-w" v-if="lastVersionOf(p.id)">
            技{{ Math.round(lastVersionOf(p.id).weights.skill * 100) }}% · 薪{{ Math.round(lastVersionOf(p.id).weights.salary * 100) }}% · 词+{{ lastVersionOf(p.id).keyword_cap }}
          </span>
        </div>
        <div class="acts">
          <button class="ghost" @click="openEdit(p)">编辑</button>
          <button class="ghost" @click="openStrategy(p)">⚙️ 匹配策略</button>
          <button class="warn" v-if="p.status === 'open'" @click="store.updatePosition(p.id, { status: 'closed' })">关闭职位</button>
          <button class="succ" v-else @click="store.updatePosition(p.id, { status: 'open' })">重新开放</button>
        </div>
      </div>
    </div>

    <div class="modal" v-if="open">
      <div class="modal-box card">
        <h3>{{ editing ? '✏️ 编辑职位' : '📌 发布新职位' }}</h3>
        <div class="form">
          <div class="fg">
            <label>职位名称<input v-model="form.name" placeholder="如 前端开发工程师" /></label>
            <label>部门<select v-model="form.dept"><option v-for="d in depts" :key="d">{{ d }}</option></select></label>
          </div>
          <div class="fg">
            <label>城市<select v-model="form.city"><option v-for="c in cities" :key="c">{{ c }}</option></select></label>
            <label>职级<select v-model="form.level"><option v-for="l in ['P4','P5','P6','P7','P8']" :key="l">{{ l }}</option></select></label>
          </div>
          <div class="fg">
            <label>最低薪资<input type="number" v-model.number="form.salary_min" /></label>
            <label>最高薪资<input type="number" v-model.number="form.salary_max" /></label>
          </div>
          <div class="fg">
            <label>经验年限<input type="number" v-model.number="form.years" /></label>
            <label>编制人数<input type="number" v-model.number="form.slots" /></label>
          </div>
          <label>技能要求（权重5=必备）</label>
          <div class="skill-editor">
            <input v-model="skillInput" placeholder="输入技能回车添加" @keyup.enter="addSkill" />
            <button class="ghost" @click="addSkill">＋ 添加</button>
          </div>
          <div class="edit-chips">
            <span v-for="(s, i) in skills" :key="i" class="chipx">
              {{ s.k }}<select v-model.number="s.w"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option></select>
              <button class="x" @click="skills.splice(i, 1)">✕</button>
            </span>
          </div>
        </div>
        <div class="acts">
          <button class="primary" @click="submit">{{ editing ? '保存' : '发布' }}</button>
          <button class="ghost" @click="open = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 按职位配置/发布匹配策略 -->
    <div class="modal" v-if="strategyOpen">
      <div class="modal-box card">
        <h3>⚙️ 匹配策略 · {{ strategyPos?.name }}</h3>
        <div class="st-tip muted">
          配置该职位的人岗评分权重并发布，发布后立即批量重算该职位的推荐结果；
          <b>已投递候选人的投递时评分不受影响</b>。
        </div>
        <div class="st-form">
          <div class="st-row" v-for="d in DIM_META" :key="d.k">
            <label>{{ d.label }}</label>
            <input type="range" min="0" max="100" step="5" :value="weightPct(d.k)" @input="setWeight(d.k, $event.target.value)" />
            <b>{{ weightPct(d.k) }}%</b>
          </div>
          <div class="st-row">
            <label>简历关键词加分上限</label>
            <input type="range" min="0" max="10" step="1" v-model.number="strategyForm.keyword_cap" />
            <b>+{{ strategyForm.keyword_cap }}</b>
          </div>
        </div>
        <div class="st-sum" :class="{ ok: weightSumPct === 1, bad: weightSumPct !== 1 }">
          权重合计 {{ Math.round(weightSumPct * 100) }}%
          <em v-if="weightSumPct !== 1">（发布时将自动归一化为 100%）</em>
        </div>
        <div v-if="strategyMsg" class="st-msg">✅ {{ strategyMsg }}</div>
        <div class="acts">
          <button class="primary" :disabled="strategySaving" @click="submitStrategy(false)">发布并重算推荐</button>
          <button class="warn" :disabled="strategySaving" @click="submitStrategy(true)">恢复默认</button>
          <button class="ghost" @click="strategyOpen = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.positions { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.pcard { display: flex; flex-direction: column; gap: 10px; }
.pcard.closed { opacity: .6; }
.phead { display: flex; justify-content: space-between; align-items: flex-start; }
.phead b { font-size: 16px; }
.meta { display: flex; gap: 8px; font-size: 12px; }
.sal { font-size: 15px; }
.chips { display: flex; flex-wrap: wrap; }
.chips i { font-style: normal; opacity: .7; font-size: 10px; }
.pmeta { display: flex; gap: 12px; font-size: 12px; }
.tag.open { background: rgba(87,214,160,.15); color: var(--green); border-color: rgba(87,214,160,.4); }
.tag.closed { background: rgba(140,149,176,.1); }
.acts { display: flex; gap: 6px; }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.fg { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.skill-editor { display: flex; gap: 8px; }
.skill-editor input { flex: 1; }
.edit-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chipx { display: inline-flex; align-items: center; gap: 4px; background: rgba(91,140,255,.14); border: 1px solid rgba(91,140,255,.35); padding: 2px 6px; border-radius: 10px; font-size: 12px; }
.chipx select { background: transparent; border: none; color: var(--accent2); width: 34px; }
.chipx .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 0 2px; }
.stline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.st-tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.st-tag.custom { background: rgba(167,139,250,.15); color: var(--purple); border-color: rgba(167,139,250,.4); }
.st-w { font-size: 11px; }
.st-tip { line-height: 1.7; margin: 8px 0 12px; }
.st-tip b { color: var(--green); font-weight: 600; }
.st-form { display: flex; flex-direction: column; gap: 10px; }
.st-row { display: grid; grid-template-columns: 130px 1fr 48px; align-items: center; gap: 10px; font-size: 13px; }
.st-row input[type=range] { width: 100%; padding: 0; accent-color: var(--accent); }
.st-row b { text-align: right; color: var(--accent2); }
.st-sum { margin: 12px 0; font-size: 13px; padding: 8px 10px; border-radius: 8px; background: var(--panel2); }
.st-sum.ok { color: var(--green); }
.st-sum.bad { color: var(--accent2); }
.st-sum em { font-style: normal; font-size: 11px; color: var(--muted); }
.st-msg { margin-bottom: 10px; font-size: 12px; color: var(--green); }
</style>