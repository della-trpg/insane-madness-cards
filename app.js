// =====================================================================
// 인세인 광기 카드 공모 — 사이트 동작
// ---------------------------------------------------------------------
// 화면 문구는 index.html, 디자인은 style.css 에서 고치면 됩니다.
// 이 파일은 로그인·목록·좋아요·투고 같은 동작을 담당합니다.
// =====================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/+esm';

// ---------- 설정 ----------
// 아래 두 값은 공개되어도 괜찮은 값입니다. (비밀 키는 절대 넣지 마세요)
const SUPABASE_URL = 'https://zahuloavitkzbeykpvig.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x7GP6lnHX7uA39dXoHObQA_JJdcbNTk';

// 월드세팅 목록 (데이터베이스 규칙과 똑같아야 합니다)
const WORLD_SETTINGS = [
  '범용',
  '사실은 무서운 현대 일본',
  '광란의 20년대',
  '빅토리아의 어둠',
  '데드 루프',
  '인세인 SCP',
  '기타',
];

const LIMITS = { title: 30, trigger: 100, effect: 500, tagCount: 3, tagLen: 10, nickMin: 2, nickMax: 20 };
const PAGE_SIZE = 24;

const CARD_COLUMNS =
  'id,title,trigger_text,effect,world_setting,tags,like_count,status,created_at,approved_at,author_id,author:profiles(nickname)';

// ---------- 준비 ----------
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
});

const state = {
  user: null,        // 로그인한 사용자
  profile: null,     // { nickname, is_admin }
  likedIds: new Set(),
  pendingCount: 0,
};

const app = document.getElementById('app');
let renderSeq = 0;

// ---------- 작은 도우미 ----------
/** 화면 요소 만들기. 글자는 항상 textContent 로 넣어서 사용자가 쓴 내용이 코드로 실행되지 않게 합니다. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 본문 영역을 새 내용으로 바꾸기 (빈 값은 건너뜀) */
function show(...nodes) {
  app.replaceChildren();
  appendChildren(app, nodes);
}

function fromTemplate(id) {
  const tpl = document.getElementById(id);
  return tpl ? tpl.content.cloneNode(true) : document.createDocumentFragment();
}

const charCount = (s) => [...(s || '')].length;

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function safeSession(action, key, value) {
  try {
    if (action === 'get') return sessionStorage.getItem(key);
    if (action === 'set') sessionStorage.setItem(key, value);
    if (action === 'remove') sessionStorage.removeItem(key);
  } catch (_) { /* 저장소를 쓸 수 없는 환경이면 무시 */ }
  return null;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 3000);
}

function friendlyError(error) {
  if (!error) return '알 수 없는 오류가 났어요.';
  const msg = error.message || '';
  if (msg.includes('24시간')) return msg;
  if (msg.includes('관리자만')) return msg;
  if (error.code === '23505') return '이미 처리된 요청이에요.';
  if (error.code === '23514') return '입력한 내용이 규칙에 맞지 않아요. 글자 수와 태그를 확인해 주세요.';
  if (error.code === '42501' || msg.includes('row-level security')) return '권한이 없어요. 로그인과 닉네임 설정을 확인해 주세요.';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
  return `오류가 났어요: ${msg}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'home', arg: parts[1] ? decodeURIComponent(parts[1]) : null, params: new URLSearchParams(query) };
}

// ---------- 창(모달) ----------
function openModal(build) {
  const root = document.getElementById('modal-root');
  root.replaceChildren();
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, modal);
  appendChildren(modal, [build(close)]);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  const focusable = modal.querySelector('input, button');
  if (focusable) focusable.focus();
  return close;
}

function confirmModal(title, message, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    const closeModal = openModal((close) => {
      const finish = (v) => { answered = true; close(); resolve(v); };
      return [
        h('h2', null, title),
        h('p', null, message),
        h('div', { class: 'form-actions' },
          h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false) }, '취소'),
          h('button', { class: danger ? 'btn danger' : 'btn primary', type: 'button', onclick: () => finish(true) }, okLabel),
        ),
      ];
    });
    // 바깥을 눌러 닫은 경우
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.modal-backdrop')) { observer.disconnect(); if (!answered) resolve(false); }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
    void closeModal;
  });
}

function loginPrompt(reason) {
  openModal((close) => [
    h('h2', null, '로그인이 필요해요'),
    h('p', null, reason || '구글 계정으로 로그인하면 투고하고 좋아요를 누를 수 있어요.'),
    h('div', { class: 'login-note' }, fromTemplate('text-login-note')),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn ghost', type: 'button', onclick: close }, '닫기'),
      h('button', { class: 'btn primary', type: 'button', onclick: signIn }, '구글로 로그인'),
    ),
  ]);
}

// ---------- 로그인 ----------
async function signIn() {
  safeSession('set', 'returnHash', location.hash || '#/');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) toast(friendlyError(error), true);
}

async function signOut() {
  await sb.auth.signOut();
  await setUser(null);
  toast('로그아웃했어요.');
  if (parseHash().name === 'home') route(); else location.hash = '#/';
}

async function loadProfile() {
  if (!state.user) { state.profile = null; return; }
  const { data, error } = await sb.from('profiles').select('nickname,is_admin').eq('id', state.user.id).maybeSingle();
  if (error) { toast(friendlyError(error), true); state.profile = null; return; }
  state.profile = data;
}

async function setUser(user) {
  const changed = (state.user?.id || null) !== (user?.id || null);
  state.user = user;
  if (changed) state.likedIds = new Set();
  await loadProfile();
  await refreshPendingCount();
  renderAccount();
  if (state.user && !state.profile) nicknameModal(true);
}

async function refreshPendingCount() {
  state.pendingCount = 0;
  if (!state.profile?.is_admin) return;
  const { count } = await sb.from('cards').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  state.pendingCount = count || 0;
}

function renderAccount() {
  const box = document.getElementById('account');
  box.replaceChildren();
  if (!state.user) {
    box.append(h('button', { class: 'btn primary small', type: 'button', onclick: signIn }, '구글로 로그인'));
  } else {
    const name = state.profile?.nickname;
    box.append(
      name
        ? h('span', { class: 'who' }, h('b', null, name), ' 님')
        : h('button', { class: 'btn small', type: 'button', onclick: () => nicknameModal(true) }, '닉네임 정하기'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: signOut }, '로그아웃'),
    );
  }
  document.querySelectorAll('.needs-login').forEach((el) => { el.hidden = !state.user; });
  document.querySelectorAll('.needs-admin').forEach((el) => {
    el.hidden = !state.profile?.is_admin;
    el.textContent = state.pendingCount ? `관리 (${state.pendingCount})` : '관리';
  });
}

function nicknameModal(isFirst) {
  openModal((close) => {
    const input = h('input', {
      class: 'input', type: 'text', maxlength: LIMITS.nickMax, placeholder: '2~20자',
      value: state.profile?.nickname || '', autocomplete: 'off',
    });
    const errorEl = h('p', { class: 'muted', style: 'color:#ff9aa8;margin:8px 0 0', hidden: true });
    const save = async (e) => {
      e.preventDefault();
      const nickname = input.value.trim();
      if (charCount(nickname) < LIMITS.nickMin || charCount(nickname) > LIMITS.nickMax) {
        errorEl.textContent = `닉네임은 ${LIMITS.nickMin}~${LIMITS.nickMax}자로 정해 주세요.`; errorEl.hidden = false; return;
      }
      button.disabled = true;
      const { error } = state.profile
        ? await sb.from('profiles').update({ nickname }).eq('id', state.user.id)
        : await sb.from('profiles').insert({ nickname });
      button.disabled = false;
      if (error) {
        errorEl.textContent = error.code === '23505' ? '이미 누가 쓰고 있는 닉네임이에요.' : friendlyError(error);
        errorEl.hidden = false;
        return;
      }
      await loadProfile();
      renderAccount();
      close();
      toast(isFirst ? `반가워요, ${nickname} 님!` : '닉네임을 저장했어요.');
      route();
    };
    const button = h('button', { class: 'btn primary', type: 'submit' }, '저장');
    return h('form', { onsubmit: save },
      h('h2', null, isFirst ? '닉네임을 정해 주세요' : '닉네임 변경'),
      h('p', null, '카드 작성자로 표시되는 이름이에요. 구글 계정 이름과 이메일은 공개되지 않아요.'),
      input,
      errorEl,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: close }, isFirst ? '나중에' : '취소'),
        button,
      ),
    );
  });
}

function withdrawModal() {
  openModal((close) => {
    const deleteCards = h('input', { type: 'checkbox', id: 'wd-cards' });
    const errorEl = h('p', { style: 'color:#ff9aa8;margin:8px 0 0', hidden: true });
    const confirmBtn = h('button', { class: 'btn danger', type: 'button' }, '탈퇴하기');
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      const { error } = await sb.rpc('delete_my_account', { p_delete_cards: deleteCards.checked });
      if (error) {
        confirmBtn.disabled = false;
        errorEl.textContent = friendlyError(error);
        errorEl.hidden = false;
        return;
      }
      await sb.auth.signOut({ scope: 'local' });
      close();
      await setUser(null);
      toast('탈퇴했어요. 그동안 고마웠어요.');
      if (parseHash().name === 'home') route(); else location.hash = '#/';
    });
    return [
      h('h2', null, '정말 탈퇴할까요?'),
      h('p', null, '로그인 정보, 닉네임, 좋아요 기록이 바로 삭제되고 되돌릴 수 없어요. 누른 좋아요도 카드에서 빠져요.'),
      state.profile?.is_admin
        ? h('p', { style: 'color:#ffb3bd' }, '⚠️ 관리자 계정이에요. 탈퇴하면 관리 권한도 사라져요.')
        : null,
      h('label', { for: 'wd-cards', style: 'display:flex;gap:8px;align-items:flex-start;font-size:14px;cursor:pointer' },
        deleteCards,
        h('span', null, '내가 투고한 카드도 모두 삭제할게요. ',
          h('span', { class: 'muted' }, '(체크하지 않으면 카드는 "(탈퇴한 사용자)" 이름으로 남아요)'))),
      errorEl,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: close }, '취소'),
        confirmBtn,
      ),
    ];
  });
}

// ---------- 광기 카드 템플릿 ----------
function renderCard(card, opts = {}) {
  const { rank, preview = false, showLike = true, extraMeta } = opts;
  const author = card.author?.nickname || card.author_nickname || (preview ? (state.profile?.nickname || '나') : '(탈퇴한 사용자)');

  const tags = (card.tags || []).map((tag) =>
    preview
      ? h('span', { class: 'mcard-tag' }, `#${tag}`)
      : h('button', { class: 'mcard-tag', type: 'button', title: `'${tag}' 태그 카드만 보기`, onclick: () => goHome({ tag }) }, `#${tag}`),
  );

  const cardEl = h('article', { class: 'mcard' },
    h('div', { class: 'mcard-inner' },
      h('div', { class: 'mcard-head' },
        h('span', { class: 'mcard-kind' }, '광기'),
        h('span', { class: 'mcard-world' }, card.world_setting || '범용'),
      ),
      h('h3', { class: 'mcard-title' }, card.title || '광기명'),
      h('div', { class: 'mcard-section' },
        h('div', { class: 'mcard-label' }, '트리거'),
        h('p', { class: 'mcard-text' }, card.trigger_text || '…'),
      ),
      effectSection(card.effect, preview),
      h('div', { class: 'mcard-foot' },
        h('div', { class: 'mcard-tags' }, tags),
        h('div', { class: 'mcard-author' }, `by ${author}`),
      ),
    ),
  );

  const wrap = h('div', { class: 'mcard-wrap' });
  if (rank) wrap.append(h('div', { class: rank <= 3 ? 'rank-badge top' : 'rank-badge', title: `${rank}위` }, `${rank}위`));
  wrap.append(cardEl);

  if (!preview && showLike) {
    wrap.append(h('div', { class: 'card-actions' }, likeButton(card), extraMeta ? h('span', { class: 'like-meta' }, extraMeta) : null));
  }
  return wrap;
}

const CLAMP_OVER = 180; // 효과가 이 글자 수보다 길면 목록에서는 접어서 보여줌

function effectSection(effect, preview) {
  const long = !preview && charCount(effect) > CLAMP_OVER;
  const text = h('p', { class: long ? 'mcard-text clamp' : 'mcard-text' }, effect || '…');
  const section = h('div', { class: 'mcard-section' }, h('div', { class: 'mcard-label' }, '효과'), text);
  if (long) {
    const toggle = h('button', { class: 'mcard-more', type: 'button', 'aria-expanded': 'false' }, '전체 보기 ▾');
    toggle.addEventListener('click', () => {
      const open = text.classList.toggle('clamp') === false;
      toggle.textContent = open ? '접기 ▴' : '전체 보기 ▾';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    section.append(toggle);
  }
  return section;
}

function likeButton(card) {
  const liked = state.likedIds.has(card.id);
  const count = h('span', { class: 'count' }, String(card.like_count ?? 0));
  const heart = h('span', { class: 'heart', 'aria-hidden': 'true' }, liked ? '♥' : '♡');
  const btn = h('button', {
    class: 'like-btn', type: 'button', 'aria-pressed': liked ? 'true' : 'false',
    'aria-label': '좋아요',
    onclick: () => toggleLike(card, btn, heart, count),
  }, heart, count);
  return btn;
}

async function toggleLike(card, btn, heart, countEl) {
  if (!state.user) { loginPrompt('좋아요를 누르려면 로그인해 주세요.'); return; }
  if (btn.disabled) return;
  btn.disabled = true;

  const wasLiked = state.likedIds.has(card.id);
  const before = Number(countEl.textContent) || 0;
  const paint = (liked, count) => {
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    heart.textContent = liked ? '♥' : '♡';
    countEl.textContent = String(Math.max(count, 0));
  };
  paint(!wasLiked, before + (wasLiked ? -1 : 1));

  const { error } = wasLiked
    ? await sb.from('likes').delete().eq('card_id', card.id).eq('user_id', state.user.id)
    : await sb.from('likes').insert({ card_id: card.id });

  if (error && error.code !== '23505') {
    paint(wasLiked, before);
    toast(friendlyError(error), true);
  } else {
    if (wasLiked) state.likedIds.delete(card.id); else state.likedIds.add(card.id);
    // 서버의 실제 숫자로 맞추기
    const { data } = await sb.from('cards').select('like_count').eq('id', card.id).maybeSingle();
    if (data) { card.like_count = data.like_count; paint(!wasLiked, data.like_count); }
  }
  btn.disabled = false;
}

async function loadLikedFor(cards) {
  if (!state.user || !cards.length) return;
  const ids = cards.map((c) => c.id).filter((id) => !state.likedIds.has(id));
  if (!ids.length) return;
  const { data } = await sb.from('likes').select('card_id').in('card_id', ids);
  (data || []).forEach((row) => state.likedIds.add(row.card_id));
}

// ---------- 첫 화면: 카드 보기 ----------
const SORTS = [
  { key: 'total', label: '누적 인기' },
  { key: 'weekly', label: '이번 주 인기' },
  { key: 'latest', label: '최신' },
];

function goHome(changes) {
  const { params } = parseHash();
  const current = { sort: params.get('sort') || 'total', world: params.get('world') || '', tag: params.get('tag') || '' };
  const next = { ...current, ...changes };
  const q = new URLSearchParams();
  if (next.sort !== 'total') q.set('sort', next.sort);
  if (next.world) q.set('world', next.world);
  if (next.tag) q.set('tag', next.tag);
  const qs = q.toString();
  location.hash = `#/${qs ? `?${qs}` : ''}`;
}

async function fetchCards({ sort, world, tag, offset }) {
  if (sort === 'weekly') {
    const { data, error } = await sb.rpc('weekly_ranking', { p_world_setting: world || null, p_limit: 100 });
    if (error) return { error };
    let rows = data || [];
    if (tag) rows = rows.filter((r) => (r.tags || []).includes(tag));
    return { cards: rows.slice(offset, offset + PAGE_SIZE), hasMore: rows.length > offset + PAGE_SIZE };
  }
  let q = sb.from('cards').select(CARD_COLUMNS).eq('status', 'approved');
  if (world) q = q.eq('world_setting', world);
  if (tag) q = q.contains('tags', [tag]);
  q = sort === 'latest'
    ? q.order('approved_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
    : q.order('like_count', { ascending: false }).order('created_at', { ascending: true });
  const { data, error } = await q.range(offset, offset + PAGE_SIZE); // 1장 더 받아서 '더 보기' 여부 판단
  if (error) return { error };
  const rows = data || [];
  return { cards: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}

async function viewHome(alive, params) {
  const sort = SORTS.some((s) => s.key === params.get('sort')) ? params.get('sort') : 'total';
  const world = WORLD_SETTINGS.includes(params.get('world')) ? params.get('world') : '';
  const tag = params.get('tag') || '';

  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    SORTS.map((s) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': s.key === sort ? 'true' : 'false',
      onclick: () => goHome({ sort: s.key }),
    }, s.label)),
  );
  const worldSelect = h('select', { class: 'select', 'aria-label': '월드세팅', onchange: (e) => goHome({ world: e.target.value }) },
    h('option', { value: '' }, '모든 월드세팅'),
    WORLD_SETTINGS.map((w) => h('option', { value: w, selected: w === world }, w)),
  );
  const tagFilter = tag
    ? h('span', { class: 'filter-tag' }, `#${tag}`,
        h('button', { type: 'button', 'aria-label': '태그 필터 해제', onclick: () => goHome({ tag: '' }) }, '×'))
    : null;

  const grid = h('div', { class: 'grid' });
  const more = h('div', { class: 'more' });
  const weeklyNote = sort === 'weekly'
    ? h('p', { class: 'muted', style: 'margin:-8px 0 16px;font-size:13px' }, '최근 7일 동안 받은 좋아요 수로 순위를 매겨요.')
    : null;

  show(
    h('section', { class: 'intro' }, fromTemplate('text-home-intro')),
    h('div', { class: 'toolbar' }, tabs, worldSelect, tagFilter),
    weeklyNote,
    grid,
    more,
  );

  let offset = 0;
  const loadPage = async () => {
    more.replaceChildren(h('div', { class: 'loading' }, '불러오는 중…'));
    const { cards, hasMore, error } = await fetchCards({ sort, world, tag, offset });
    if (!alive()) return;
    if (error) { more.replaceChildren(h('div', { class: 'empty' }, friendlyError(error))); return; }
    await loadLikedFor(cards);
    if (!alive()) return;
    cards.forEach((card, i) => {
      const rank = sort === 'latest' ? null : offset + i + 1;
      const meta = sort === 'weekly' ? `이번 주 +${card.weekly_likes}` : formatDate(card.approved_at || card.created_at);
      grid.append(renderCard(card, { rank, extraMeta: meta }));
    });
    offset += cards.length;
    if (offset === 0) {
      more.replaceChildren(h('div', { class: 'empty', style: 'width:100%' },
        tag || world ? '조건에 맞는 카드가 아직 없어요.' : (sort === 'weekly' ? '이번 주에 좋아요를 받은 카드가 아직 없어요.' : '아직 게시된 카드가 없어요. 첫 광기를 투고해 보세요!'),
        h('div', { style: 'margin-top:14px' }, h('a', { class: 'btn primary', href: '#/submit' }, '투고하러 가기'))));
    } else if (hasMore) {
      more.replaceChildren(h('button', { class: 'btn', type: 'button', onclick: loadPage }, '더 보기'));
    } else {
      more.replaceChildren();
    }
  };
  await loadPage();
}

// ---------- 투고 / 수정 ----------
async function viewSubmit(alive, editId) {
  const intro = h('section', { class: 'intro' }, fromTemplate('text-submit-intro'));

  if (!state.user) {
    show(intro, h('div', { class: 'notice' },
      h('p', null, '투고하려면 구글 계정으로 로그인해 주세요.'),
      h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: signIn }, '구글로 로그인')),
      h('div', { class: 'login-note' }, fromTemplate('text-login-note')),
    ));
    return;
  }
  if (!state.profile) {
    show(intro, h('div', { class: 'notice' },
      h('p', null, '투고하기 전에 작성자로 표시될 닉네임을 정해 주세요.'),
      h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: () => nicknameModal(true) }, '닉네임 정하기')),
    ));
    return;
  }

  let existing = null;
  if (editId) {
    show(h('div', { class: 'loading' }, '불러오는 중…'));
    const { data, error } = await sb.from('cards').select(CARD_COLUMNS).eq('id', editId).maybeSingle();
    if (!alive()) return;
    if (error || !data || data.author_id !== state.user.id) {
      show(h('div', { class: 'empty' }, '수정할 카드를 찾지 못했어요.')); return;
    }
    if (data.status !== 'pending') {
      show(h('div', { class: 'empty' }, '이미 확인이 끝난 카드는 수정할 수 없어요.')); return;
    }
    existing = data;
  }

  const draft = {
    title: existing?.title || '',
    trigger_text: existing?.trigger_text || '',
    effect: existing?.effect || '',
    world_setting: existing?.world_setting || '범용',
    tags: [...(existing?.tags || [])],
  };

  const previewBox = h('div');
  const refreshPreview = () => {
    previewBox.replaceChildren(renderCard({ ...draft, author: { nickname: state.profile.nickname } }, { preview: true }));
  };

  const counterFor = (limit) => {
    const el = h('span');
    const update = (value) => {
      const n = charCount(value);
      el.textContent = `${n} / ${limit}`;
      el.className = n > limit ? 'over' : '';
    };
    return { el, update };
  };

  const textField = ({ key, label, limit, multiline, placeholder, hint }) => {
    const counter = counterFor(limit);
    const attrs = {
      class: multiline ? 'textarea' : 'input', id: `f-${key}`, maxlength: limit, placeholder,
      oninput: (e) => { draft[key] = e.target.value; counter.update(e.target.value); refreshPreview(); },
    };
    const control = multiline ? h('textarea', { ...attrs, rows: key === 'effect' ? 6 : 3 }) : h('input', { ...attrs, type: 'text' });
    control.value = draft[key];
    counter.update(draft[key]);
    return h('div', { class: 'field' },
      h('label', { for: `f-${key}` }, label),
      control,
      h('div', { class: 'hint' }, h('span', null, hint || ''), counter.el),
    );
  };

  // 태그 입력
  const tagChips = h('span', { style: 'display:contents' });
  const tagInput = h('input', { type: 'text', id: 'f-tags', maxlength: LIMITS.tagLen, placeholder: '입력 후 Enter', autocomplete: 'off' });
  const renderTags = () => {
    tagChips.replaceChildren(...draft.tags.map((t, i) => h('span', { class: 'tag-chip' }, `#${t}`,
      h('button', { type: 'button', 'aria-label': `${t} 태그 삭제`, onclick: () => { draft.tags.splice(i, 1); renderTags(); refreshPreview(); } }, '×'))));
    tagInput.hidden = draft.tags.length >= LIMITS.tagCount;
  };
  const addTag = () => {
    const t = tagInput.value.replace(/[#,]/g, '').trim();
    tagInput.value = '';
    if (!t) return;
    if (charCount(t) > LIMITS.tagLen) { toast(`태그는 ${LIMITS.tagLen}자까지예요.`, true); return; }
    if (draft.tags.includes(t)) return;
    if (draft.tags.length >= LIMITS.tagCount) { toast(`태그는 ${LIMITS.tagCount}개까지예요.`, true); return; }
    draft.tags.push(t);
    renderTags(); refreshPreview();
    tagInput.focus();
  };
  tagInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // 한글 조합 중에는 무시
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
    else if (e.key === 'Backspace' && !tagInput.value && draft.tags.length) { draft.tags.pop(); renderTags(); refreshPreview(); }
  });
  tagInput.addEventListener('blur', addTag);
  renderTags();

  const worldSelect = h('select', { class: 'select', id: 'f-world', onchange: (e) => { draft.world_setting = e.target.value; refreshPreview(); } },
    WORLD_SETTINGS.map((w) => h('option', { value: w, selected: w === draft.world_setting }, w)));

  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, existing ? '수정 저장' : '투고하기');

  const onSubmit = async (e) => {
    e.preventDefault();
    if (tagInput.value.trim()) addTag();
    const payload = {
      title: draft.title.trim(),
      trigger_text: draft.trigger_text.trim(),
      effect: draft.effect.trim(),
      world_setting: draft.world_setting,
      tags: draft.tags,
    };
    if (!payload.title || !payload.trigger_text || !payload.effect) { toast('광기명, 트리거, 효과를 모두 입력해 주세요.', true); return; }
    if (charCount(payload.title) > LIMITS.title || charCount(payload.trigger_text) > LIMITS.trigger || charCount(payload.effect) > LIMITS.effect) {
      toast('글자 수 제한을 넘은 칸이 있어요.', true); return;
    }
    submitBtn.disabled = true;
    const { error } = existing
      ? await sb.from('cards').update(payload).eq('id', existing.id)
      : await sb.from('cards').insert(payload);
    submitBtn.disabled = false;
    if (error) { toast(friendlyError(error), true); return; }
    toast(existing ? '수정했어요.' : '투고했어요! 관리자 확인 후 게시돼요.');
    await refreshPendingCount(); renderAccount();
    location.hash = '#/my';
  };

  const form = h('form', { class: 'form', onsubmit: onSubmit },
    textField({ key: 'title', label: '광기명', limit: LIMITS.title, placeholder: '예: 거울 속의 타인' }),
    textField({ key: 'trigger_text', label: '트리거', limit: LIMITS.trigger, multiline: true, placeholder: '이 광기가 발동하는 조건' }),
    textField({ key: 'effect', label: '효과', limit: LIMITS.effect, multiline: true, placeholder: '광기가 발동했을 때 일어나는 일' }),
    h('div', { class: 'field' }, h('label', { for: 'f-world' }, '월드세팅'), worldSelect),
    h('div', { class: 'field' },
      h('label', { for: 'f-tags' }, '장르 태그 ', h('span', { class: 'muted', style: 'font-weight:400' }, '(선택)')),
      h('div', { class: 'tag-box', onclick: () => tagInput.focus() }, tagChips, tagInput),
      h('div', { class: 'hint' }, h('span', null, `최대 ${LIMITS.tagCount}개, 태그당 ${LIMITS.tagLen}자까지`), h('span')),
    ),
    h('div', { class: 'form-actions' },
      submitBtn,
      existing ? h('a', { class: 'btn ghost', href: '#/my' }, '취소') : null,
    ),
  );

  refreshPreview();
  show(
    existing ? h('section', { class: 'intro' }, h('h1', null, '카드 수정'), h('p', null, '확인 대기 중인 카드는 게시 전까지 수정할 수 있어요.')) : intro,
    h('div', { class: 'submit-layout' },
      form,
      h('div', { class: 'preview-col' }, h('div', { class: 'preview-label' }, '미리보기'), previewBox),
    ),
  );
}

// ---------- 내 카드 ----------
const STATUS_LABEL = { pending: '확인 대기', approved: '게시됨', rejected: '반려됨' };

async function viewMy(alive) {
  if (!state.user) { show(h('div', { class: 'empty' }, '로그인하면 내가 투고한 카드를 볼 수 있어요.')); return; }

  const list = h('div', { class: 'list' }, h('div', { class: 'loading' }, '불러오는 중…'));
  show(
    h('div', { class: 'section-head' }, h('h1', null, '내 카드'), h('a', { class: 'btn primary', href: '#/submit' }, '새 카드 투고')),
    h('div', { class: 'profile-box' },
      h('span', null, '닉네임: ', h('b', null, state.profile?.nickname || '(아직 없음)')),
      h('button', { class: 'btn small', type: 'button', onclick: () => nicknameModal(!state.profile) }, state.profile ? '변경' : '정하기'),
      h('button', { class: 'btn small danger', type: 'button', style: 'margin-left:auto', onclick: withdrawModal }, '탈퇴하기'),
    ),
    list,
  );

  const { data, error } = await sb.from('cards').select(CARD_COLUMNS).eq('author_id', state.user.id).order('created_at', { ascending: false });
  if (!alive()) return;
  if (error) { list.replaceChildren(h('div', { class: 'empty' }, friendlyError(error))); return; }
  if (!data.length) { list.replaceChildren(h('div', { class: 'empty' }, '아직 투고한 카드가 없어요.')); return; }

  await loadLikedFor(data.filter((c) => c.status === 'approved'));
  if (!alive()) return;

  list.replaceChildren(...data.map((card) => {
    const del = async () => {
      const ok = await confirmModal('카드 삭제', `'${card.title}' 카드를 삭제할까요? 받은 좋아요도 함께 사라지고, 되돌릴 수 없어요.`, '삭제', true);
      if (!ok) return;
      const { error: err } = await sb.from('cards').delete().eq('id', card.id);
      if (err) { toast(friendlyError(err), true); return; }
      toast('삭제했어요.');
      route();
    };
    return h('div', { class: 'list-item' },
      renderCard(card, { showLike: card.status === 'approved' }),
      h('div', { class: 'list-side' },
        h('span', { class: `status ${card.status}` }, STATUS_LABEL[card.status]),
        h('span', { class: 'meta' }, `투고일 ${formatDate(card.created_at)}`),
        card.status === 'approved' ? h('span', { class: 'meta' }, `좋아요 ${card.like_count}개`) : null,
        card.status === 'rejected' ? h('span', { class: 'meta' }, '투고 규칙에 맞지 않아 게시되지 않았어요.') : null,
        h('div', { class: 'row-actions' },
          card.status === 'pending' ? h('a', { class: 'btn small', href: `#/edit/${encodeURIComponent(card.id)}` }, '수정') : null,
          h('button', { class: 'btn small danger', type: 'button', onclick: del }, '삭제'),
        ),
      ),
    );
  }));
}

// ---------- 관리 ----------
const ADMIN_TABS = [
  { key: 'pending', label: '확인 대기' },
  { key: 'approved', label: '게시됨' },
  { key: 'rejected', label: '반려됨' },
];

async function viewAdmin(alive, params) {
  if (!state.profile?.is_admin) { show(h('div', { class: 'empty' }, '관리자만 볼 수 있는 화면이에요.')); return; }
  const tab = ADMIN_TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'pending';

  const list = h('div', { class: 'list' }, h('div', { class: 'loading' }, '불러오는 중…'));
  show(
    h('div', { class: 'section-head' }, h('h1', null, '관리')),
    h('div', { class: 'toolbar' },
      h('div', { class: 'tabs', role: 'tablist' },
        ADMIN_TABS.map((t) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': t.key === tab ? 'true' : 'false',
          onclick: () => { location.hash = `#/admin?tab=${t.key}`; },
        }, t.key === 'pending' && state.pendingCount ? `${t.label} (${state.pendingCount})` : t.label)),
      ),
    ),
    list,
  );

  const { data, error } = await sb.from('cards').select(CARD_COLUMNS).eq('status', tab)
    .order('created_at', { ascending: tab === 'pending' }).limit(200);
  if (!alive()) return;
  if (error) { list.replaceChildren(h('div', { class: 'empty' }, friendlyError(error))); return; }
  if (!data.length) { list.replaceChildren(h('div', { class: 'empty' }, tab === 'pending' ? '확인할 카드가 없어요. 👍' : '카드가 없어요.')); return; }

  const setStatus = async (card, status, button) => {
    button.disabled = true;
    const { error: err } = await sb.rpc('admin_set_card_status', { p_card_id: card.id, p_status: status });
    if (err) { button.disabled = false; toast(friendlyError(err), true); return; }
    toast(status === 'approved' ? '승인했어요.' : status === 'rejected' ? '반려했어요.' : '대기로 돌렸어요.');
    await refreshPendingCount(); renderAccount();
    route();
  };
  const remove = async (card) => {
    const ok = await confirmModal('카드 삭제', `'${card.title}' 카드를 완전히 삭제할까요? 되돌릴 수 없어요.`, '삭제', true);
    if (!ok) return;
    const { error: err } = await sb.from('cards').delete().eq('id', card.id);
    if (err) { toast(friendlyError(err), true); return; }
    toast('삭제했어요.');
    await refreshPendingCount(); renderAccount();
    route();
  };

  list.replaceChildren(...data.map((card) => {
    const actions = h('div', { class: 'row-actions' });
    const btn = (label, cls, fn) => { const b = h('button', { class: `btn small ${cls}`, type: 'button' }, label); b.addEventListener('click', () => fn(b)); return b; };
    if (card.status !== 'approved') actions.append(btn('승인', 'ok', (b) => setStatus(card, 'approved', b)));
    if (card.status !== 'rejected') actions.append(btn(card.status === 'approved' ? '게시 내리기(반려)' : '반려', 'danger', (b) => setStatus(card, 'rejected', b)));
    if (card.status !== 'pending') actions.append(btn('대기로', '', (b) => setStatus(card, 'pending', b)));
    actions.append(btn('삭제', 'danger', () => remove(card)));

    return h('div', { class: 'list-item' },
      renderCard(card, { showLike: false }),
      h('div', { class: 'list-side' },
        h('span', { class: `status ${card.status}` }, STATUS_LABEL[card.status]),
        h('span', { class: 'meta' }, `작성자 ${card.author?.nickname || '(탈퇴한 사용자)'} · 투고일 ${formatDate(card.created_at)}`),
        card.status === 'approved' ? h('span', { class: 'meta' }, `좋아요 ${card.like_count}개`) : null,
        actions,
      ),
    );
  }));
}

// ---------- 글 페이지 ----------
function viewTemplatePage(id) {
  show(fromTemplate(id));
}

// ---------- 화면 전환 ----------
async function route() {
  const seq = ++renderSeq;
  const alive = () => seq === renderSeq;
  const { name, arg, params } = parseHash();

  document.querySelectorAll('#nav a').forEach((a) => {
    const active = a.dataset.route === name || (name === 'edit' && a.dataset.route === 'submit');
    a.classList.toggle('active', active);
  });
  window.scrollTo(0, 0);

  try {
    switch (name) {
      case 'home': await viewHome(alive, params); break;
      case 'submit': await viewSubmit(alive, null); break;
      case 'edit': await viewSubmit(alive, arg); break;
      case 'my': await viewMy(alive); break;
      case 'admin': await viewAdmin(alive, params); break;
      case 'rules': viewTemplatePage('page-rules'); break;
      case 'privacy': viewTemplatePage('page-privacy'); break;
      default: show(h('div', { class: 'empty' }, '없는 페이지예요. ', h('a', { href: '#/' }, '처음으로')));
    }
  } catch (err) {
    console.error(err);
    if (alive()) show(h('div', { class: 'empty' }, friendlyError(err)));
  }
}

// ---------- 시작 ----------
async function init() {
  show(h('div', { class: 'loading' }, '불러오는 중…'));

  const search = new URLSearchParams(location.search);
  const { data: { session } } = await sb.auth.getSession(); // 로그인 직후라면 여기서 로그인 처리가 끝납니다

  if (search.has('code') || search.has('error')) {
    if (search.get('error')) toast(`로그인하지 못했어요: ${search.get('error_description') || search.get('error')}`, true);
    const back = safeSession('get', 'returnHash') || '#/';
    safeSession('remove', 'returnHash');
    history.replaceState(null, '', location.pathname + back);
  }

  await setUser(session?.user ?? null);

  sb.auth.onAuthStateChange((event, newSession) => {
    const newId = newSession?.user?.id || null;
    if (newId === (state.user?.id || null)) { if (newSession?.user) state.user = newSession.user; return; }
    // 콜백 안에서 바로 서버를 부르면 멈출 수 있어서 잠깐 미룹니다
    setTimeout(async () => { await setUser(newSession?.user ?? null); route(); }, 0);
  });

  window.addEventListener('hashchange', route);
  route();
}

init();
