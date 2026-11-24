/* 领票系统前端：抢票端 + 发票端（单页，靠路径区分） */
const $ = (id) => document.getElementById(id);
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
  return { status: res.status, data };
};

let state = { types: [], selectedId: null, open: false, title: '领票登记' };
let adminKey = sessionStorage.getItem('tickits.key') || '';

/* ---------------- 抢票端 ---------------- */

function renderTitle() {
  $('appTitle').textContent = state.title || '领票登记';
  document.title = state.title || '领票登记';
}

function renderTypes() {
  const box = $('gTypes');
  if (!state.types.length) {
    box.innerHTML = '<p class="empty">发票端还没有设置票型，请稍后再来</p>';
    $('gSubmit').disabled = true;
    return;
  }
  box.innerHTML = state.types
    .map((t) => {
      const sold = t.remaining <= 0;
      const on = state.selectedId === t.id && !sold;
      return `<label class="type ${on ? 'on' : ''} ${sold ? 'sold' : ''}" data-id="${t.id}">
        <input type="radio" name="type" value="${t.id}" ${on ? 'checked' : ''} ${sold ? 'disabled' : ''} />
        <span class="tname">${esc(t.name)}</span>
        <span class="left-num">剩余 <b>${t.remaining}</b> / ${t.total}</span>
      </label>`;
    })
    .join('');
  box.querySelectorAll('.type').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.classList.contains('sold')) return;
      state.selectedId = Number(el.dataset.id);
      renderTypes();
      syncSubmit();
    });
  });
  syncSubmit();
}

function syncSubmit() {
  const name = $('gName').value.trim();
  const sid = $('gSid').value.trim();
  $('gSubmit').disabled = !(state.open && state.selectedId && name && sid);
  $('gSubmit').textContent = state.open ? '确定领取' : '当前未开放领票';
}

async function loadState() {
  const { data } = await api('/api/state');
  if (!data.ok) return;
  state.title = data.title;
  state.open = data.open;
  state.types = data.types;
  if (!state.types.some((t) => t.id === state.selectedId && t.remaining > 0)) state.selectedId = null;
  renderTitle();
  renderTypes();
}

function showResult(html, kind) {
  const el = $('gResult');
  el.className = `result ${kind}`;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

async function submitClaim() {
  const btn = $('gSubmit');
  btn.disabled = true;
  const { data } = await api('/api/claim', {
    method: 'POST',
    body: JSON.stringify({
      name: $('gName').value.trim(),
      studentId: $('gSid').value.trim(),
      typeId: state.selectedId,
    }),
  });

  if (data.ok) {
    const c = data.claim;
    showResult(
      `<h3>领取成功</h3>
       <dl>
         <dt>姓名</dt><dd>${esc(c.name)}</dd>
         <dt>学号</dt><dd>${esc(c.student_id)}</dd>
         <dt>票型</dt><dd>${esc(c.type_name)}</dd>
         <dt>票号</dt><dd>${String(c.seat_no).padStart(3, '0')}</dd>
         <dt>时间</dt><dd>${esc(c.created_at)}</dd>
       </dl>`,
      'ok',
    );
    state.types = data.types;
    renderTypes();
  } else {
    showResult(`<h3>领取失败</h3><p style="margin:0">${esc(data.error || '未知错误')}</p>`, 'err');
    await loadState();
  }
  syncSubmit();
}

/* ---------------- 发票端 ---------------- */

async function adminApi(url, opts = {}) {
  const { status, data } = await api(url, {
    ...opts,
    headers: { 'x-admin-key': adminKey, ...(opts.headers || {}) },
  });
  if (status === 401) adminLogout('秘钥不正确');
  return { status, data };
}

function adminLogout(msg) {
  adminKey = '';
  sessionStorage.removeItem('tickits.key');
  $('adminPanel').classList.add('hidden');
  $('adminLogin').classList.remove('hidden');
  const el = $('aLoginMsg');
  el.className = 'msg err';
  el.textContent = msg || '';
}

function addTypeRow(name = '', total = '') {
  const row = document.createElement('div');
  row.className = 'type-row';
  row.innerHTML = `<input type="text" placeholder="票型名称，如 内场票" value="${esc(name)}" maxlength="40" />
                   <input type="number" placeholder="票数" min="0" step="1" value="${esc(total)}" />
                   <button class="del ghost small" type="button" title="删除">✕</button>`;
  row.querySelector('.del').addEventListener('click', () => {
    row.remove();
    if (!$('aTypeRows').children.length) addTypeRow();
  });
  $('aTypeRows').appendChild(row);
}

function collectTypeRows() {
  return [...$('aTypeRows').querySelectorAll('.type-row')].map((r) => ({
    name: r.children[0].value.trim(),
    total: Number(r.children[1].value),
  })).filter((t) => t.name !== '' || !Number.isNaN(t.total));
}

function renderAdminTypes(types) {
  $('aTypeRows').innerHTML = '';
  const shown = types.filter((t) => t.active);
  if (!shown.length) addTypeRow();
  shown.forEach((t) => addTypeRow(t.name, t.total));
}

function renderOpenState() {
  const on = state.open;
  $('aOpenState').textContent = on ? '领票进行中' : '已关闭';
  $('aOpenState').className = `pill ${on ? '' : 'off'}`;
  $('aToggleOpen').textContent = on ? '关闭领票' : '开放领票';
}

function renderClaims(claims) {
  $('aCount').textContent = claims.length ? `共 ${claims.length} 人` : '（暂无）';
  const tb = $('aTable').querySelector('tbody');
  tb.innerHTML = claims
    .map(
      (c) => `<tr>
        <td class="num">${String(c.seat_no).padStart(3, '0')}</td>
        <td>${esc(c.name)}</td>
        <td>${esc(c.student_id)}</td>
        <td>${esc(c.type_name)}</td>
        <td>${esc(c.created_at)}</td>
        <td><button class="del" data-id="${c.id}" title="删除该记录">删除</button></td>
      </tr>`,
    )
    .join('');
  tb.querySelectorAll('.del').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('删除这条领取记录？该学号可重新领取。')) return;
      await adminApi('/api/admin/claim/delete', { method: 'POST', body: JSON.stringify({ id: Number(b.dataset.id) }) });
      await refreshAdmin();
      await loadState();
    }),
  );
}

async function refreshAdmin() {
  const { data } = await adminApi('/api/admin/data');
  if (!data.ok) return;
  state.title = data.title;
  state.open = data.open;
  $('aTitle').value = data.title;
  renderOpenState();
  renderAdminTypes(data.types);
  renderClaims(data.claims);
  renderTitle();
}

function setMsg(id, text, kind = '') {
  const el = $(id);
  el.className = `msg ${kind}`;
  el.textContent = text;
}

async function adminLogin(useInput = false) {
  // 手动登录时以输入框为准；刷新页面自动登录时沿用 sessionStorage 里已保存的秘钥
  if (useInput) adminKey = $('aKey').value.trim() || adminKey;
  if (!adminKey) return setMsg('aLoginMsg', '请输入秘钥', 'err');
  const { data } = await adminApi('/api/admin/login', { method: 'POST', body: '{}' });
  if (!data.ok) {
    adminLogout(data.error || '进入失败');
    $('aKey').value = '';
    return;
  }
  sessionStorage.setItem('tickits.key', adminKey);
  $('aLoginMsg').textContent = '';
  $('adminLogin').classList.add('hidden');
  $('adminPanel').classList.remove('hidden');
  await refreshAdmin();
}

/* ---------------- 绑定与路由 ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function route() {
  const isAdmin = location.pathname.replace(/\/+$/, '') === '/admin';
  $('view-grab').classList.toggle('hidden', isAdmin);
  $('view-admin').classList.toggle('hidden', !isAdmin);
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (isAdmin ? 'admin' : 'grab')));
  if (isAdmin) {
    if (adminKey) adminLogin();
    else adminLogout('');
  } else {
    loadState();
  }
}

$('gName').addEventListener('input', syncSubmit);
$('gSid').addEventListener('input', syncSubmit);
$('gSubmit').addEventListener('click', submitClaim);
$('gRefresh').addEventListener('click', loadState);
$('aLogin').addEventListener('click', () => adminLogin(true));
$('aKey').addEventListener('keydown', (e) => e.key === 'Enter' && adminLogin(true));
$('aAddRow').addEventListener('click', () => addTypeRow());
$('aSaveTypes').addEventListener('click', async () => {
  const types = collectTypeRows();
  if (!types.length) return setMsg('aTypeMsg', '至少填写一个票型', 'err');
  const { data } = await adminApi('/api/admin/types', { method: 'POST', body: JSON.stringify({ types }) });
  if (!data.ok) return setMsg('aTypeMsg', data.error, 'err');
  setMsg('aTypeMsg', `已保存：${data.types.map((t) => `${t.name} ${t.total} 张`).join('、')}`, 'ok');
  await refreshAdmin();
  await loadState();
});
$('aSaveTitle').addEventListener('click', async () => {
  await adminApi('/api/admin/settings', { method: 'POST', body: JSON.stringify({ title: $('aTitle').value }) });
  await refreshAdmin();
});
$('aToggleOpen').addEventListener('click', async () => {
  await adminApi('/api/admin/settings', { method: 'POST', body: JSON.stringify({ open: !state.open }) });
  await refreshAdmin();
});
$('aRefresh').addEventListener('click', refreshAdmin);
$('aExport').addEventListener('click', async () => {
  const res = await fetch('/api/admin/claims.csv', { headers: { 'x-admin-key': adminKey } });
  if (!res.ok) return alert('导出失败');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '领取名单.csv';
  a.click();
  URL.revokeObjectURL(url);
});

window.addEventListener('popstate', route);
document.querySelectorAll('.tabs a').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', a.getAttribute('href'));
    route();
  }),
);

route();
setInterval(() => {
  if (!$('view-grab').classList.contains('hidden')) loadState();
}, 5000);
