// ── SUPABASE CONFIG ────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://rhadjnlmosxtxuonfhlq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoYWRqbmxtb3N4dHh1b25maGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MDEzMjEsImV4cCI6MjA5ODE3NzMyMX0.sdv8FLcCaDP7zYRIwFscR4WwEMg6RPqxtnfvveFFICc';
const DB = `${SUPABASE_URL}/rest/v1/media`;
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Prefer': 'return=minimal'
};

// ── STATE ──────────────────────────────────────────────────────────────────
let mediaList = JSON.parse(localStorage.getItem('medialog_v4') || '[]');
let settings  = JSON.parse(localStorage.getItem('medialog_settings') || '{"apiKey":"","lang":"es-ES"}');
let editingId = null;
let currentSection = 'all';
let currentFilter  = null;
let currentSearch  = '';
let activeSeasonTab = {};
let syncStatus = 'idle'; // idle | syncing | ok | error

const TMDB_IMG   = 'https://image.tmdb.org/t/p/w342';
const TMDB_BIG   = 'https://image.tmdb.org/t/p/w780';
const TYPE_EMOJI = { series: '📺', anime: '⛩️', movie: '🎬' };
const TYPE_LABEL = { series: 'Serie', anime: 'Anime', movie: 'Película' };
const STATUS_LABEL = { watching: 'Viendo', completed: 'Completada', pending: 'Pendiente', paused: 'En pausa', dropped: 'Abandonada' };
const CONT_LABEL = { unknown: '', no: 'No continúa', rumor: 'Continuación rumor', confirmed: 'Continuación confirmada', airing: 'Ya en emisión' };

// ── SUPABASE SYNC ──────────────────────────────────────────────────────────
function recalcRating(m) {
  // Limpiar ratings corruptos ([object Promise], [object Object], etc.)
  if (m.rating && (String(m.rating).includes('object') || String(m.rating).includes('Promise'))) {
    m.rating = '';
  }
  m.seasons?.forEach(s => {
    if (s.rating && (String(s.rating).includes('object') || String(s.rating).includes('Promise'))) {
      s.rating = '';
    }
  });
  // Recalcular como media de temporadas
  if (m.type !== 'movie' && m.seasons?.length > 0) {
    const ratings = m.seasons.map(s => parseFloat(s.rating)).filter(r => !isNaN(r) && r > 0);
    if (ratings.length > 0) m.rating = Math.round(ratings.reduce((a,b)=>a+b,0)/ratings.length*10)/10;
  }
  return m;
}

// Decide qué versión de un item tiene más info (más episodios vistos + más temporadas + tiene poster)
function moreComplete(a, b) {
  const scoreA = (parseInt(a.updatedAt)||0);
  const scoreB = (parseInt(b.updatedAt)||0);
  // Prefer whichever was updated more recently; tie-break by total ep seen
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
  const epA = (a.seasons||[]).reduce((s,t)=>s+(parseInt(t.epSeen)||0),0);
  const epB = (b.seasons||[]).reduce((s,t)=>s+(parseInt(t.epSeen)||0),0);
  return epA >= epB ? a : b;
}

async function loadFromSupabase() {
  setSyncStatus('syncing');
  try {
    const res = await fetch(`${DB}?select=id,data,updated_at&order=updated_at.desc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!res.ok) throw new Error('fetch failed');
    const rows = await res.json();

    // Build map from Supabase
    const remoteMap = {};
    rows.forEach(r => { remoteMap[r.id] = recalcRating({ ...r.data, id: r.id }); });

    // Build map from localStorage
    const local = JSON.parse(localStorage.getItem('medialog_v4') || '[]');
    const localMap = {};
    local.forEach(m => { localMap[m.id] = recalcRating(m); });

    // Merge: for each id, keep the more complete version
    const allIds = new Set([...Object.keys(remoteMap), ...Object.keys(localMap)]);
    const merged = [];
    const toSync = []; // items to push to Supabase that it doesn't have or has older version

    allIds.forEach(id => {
      const remote = remoteMap[id];
      const loc    = localMap[id];
      let winner;
      if (remote && loc) {
        winner = moreComplete(remote, loc);
      } else {
        winner = remote || loc;
      }
      merged.push(winner);
      // If local has something remote doesn't, or local is newer — sync up
      if (!remote || (loc && winner === loc && JSON.stringify(winner) !== JSON.stringify(remote))) {
        toSync.push(winner);
      }
    });

    // Sort by updatedAt desc
    merged.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
    mediaList = merged;
    localStorage.setItem('medialog_v4', JSON.stringify(mediaList));

    // Push any local-only or newer-local items to Supabase
    if (toSync.length > 0) {
      console.log(`Syncing ${toSync.length} local items to Supabase...`);
      for (const entry of toSync) await saveToSupabase(entry);
    }

    setSyncStatus('ok');
  } catch(e) {
    console.warn('Supabase load failed, using local data', e);
    // Fall back to localStorage
    const local = JSON.parse(localStorage.getItem('medialog_v4') || '[]');
    if (local.length > 0) mediaList = local;
    setSyncStatus('error');
  }
  render();
}

async function saveToSupabase(entry) {
  // Validate before saving — never save corrupt entries
  if (!entry || !entry.id || !entry.title || !entry.type) {
    console.warn('Skipping corrupt entry', entry);
    return;
  }
  setSyncStatus('syncing');
  try {
    const res = await fetch(DB, {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: entry.id, data: entry, updated_at: new Date().toISOString() })
    });
    if (!res.ok) throw new Error('save failed');
    setSyncStatus('ok');
  } catch(e) {
    console.warn('Supabase save failed', e);
    setSyncStatus('error');
  }
}

async function deleteFromSupabase(id) {
  try {
    await fetch(`${DB}?id=eq.${id}`, { method: 'DELETE', headers: HEADERS });
  } catch(e) { console.warn('Supabase delete failed', e); }
}

function setSyncStatus(status) {
  syncStatus = status;
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  const map = {
    syncing: { icon: 'ti-loader-2', color: 'var(--text-muted)',    title: 'Sincronizando...', spin: true },
    ok:      { icon: 'ti-cloud-check', color: 'var(--text-success)', title: 'Sincronizado',     spin: false },
    error:   { icon: 'ti-cloud-off',   color: 'var(--text-danger)',  title: 'Sin conexión',     spin: false },
    idle:    { icon: 'ti-cloud',       color: 'var(--text-muted)',   title: '',                 spin: false },
  };
  const s = map[status] || map.idle;
  el.innerHTML = `<i class="ti ${s.icon}" style="color:${s.color};font-size:16px;${s.spin?'animation:spin 1s linear infinite':''}" title="${s.title}"></i>`;
}

function saveData() {
  localStorage.setItem('medialog_v4', JSON.stringify(mediaList));
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ── NAVIGATION ─────────────────────────────────────────────────────────────
function setSection(s) {
  currentSection = s; currentFilter = null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + s)?.classList.add('active');
  const titles = { all: 'Mi biblioteca', series: 'Series', movie: 'Películas', anime: 'Anime' };
  document.getElementById('section-title').textContent = titles[s] ?? 'Mi biblioteca';
  render();
}
function setFilter(f) {
  if (currentFilter === f) { currentFilter = null; setSection('all'); return; }
  currentFilter = f; currentSection = 'all';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + f)?.classList.add('active');
  render();
}
function onSearch(q) { currentSearch = q; render(); }

// ── FILTERING ──────────────────────────────────────────────────────────────
function getFiltered() {
  let list = [...mediaList];
  if (currentSection === 'anime') list = list.filter(m => m.type === 'anime' || (m.type === 'movie' && m.isAnimeMovie));
  else if (currentSection !== 'all') list = list.filter(m => m.type === currentSection);
  if (currentFilter)            list = list.filter(m => m.status === currentFilter);
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    list = list.filter(m => m.title.toLowerCase().includes(q) || (m.genre||'').toLowerCase().includes(q));
  }
  const sort = document.getElementById('sort-select')?.value ?? 'recent';
  if (sort === 'recent') list.sort((a,b) => (b.addedAt||b.updatedAt||0) - (a.addedAt||a.updatedAt||0));
  if (sort === 'title')  list.sort((a,b) => a.title.localeCompare(b.title));
  if (sort === 'rating') list.sort((a,b) => (parseFloat(b.rating)||0) - (parseFloat(a.rating)||0));
  if (sort === 'year')   list.sort((a,b) => (parseInt(b.year)||0) - (parseInt(a.year)||0));
  return list;
}

// ── TAGS ───────────────────────────────────────────────────────────────────
function statusTag(s) {
  const cls = { watching:'tag-watching', completed:'tag-completed', pending:'tag-pending', paused:'tag-paused', dropped:'tag-dropped' };
  return `<span class="tag ${cls[s]??'tag-pending'}">${STATUS_LABEL[s]??s}</span>`;
}
function contTag(c) {
  if (!c || c === 'unknown') return '';
  const cls = { no:'tag-cont-no', rumor:'tag-cont-rumor', confirmed:'tag-cont-confirmed', airing:'tag-cont-airing' };
  return `<span class="tag ${cls[c]??''}">${CONT_LABEL[c]}</span>`;
}

// ── CARD ───────────────────────────────────────────────────────────────────
function totalEpSeen(m)  { return (m.seasons||[]).reduce((a,s)=>a+(parseInt(s.epSeen)||0),0); }
function totalEpTotal(m) { return (m.seasons||[]).reduce((a,s)=>a+(parseInt(s.epTotal)||0),0); }

function getCardPoster(m) {
  if (m.poster) return m.poster;
  return (m.seasons||[])[0]?.poster || '';
}

// ── STATS ──────────────────────────────────────────────────────────────────
function renderStats() {
  const all = mediaList;
  const badges = {
    all: all.length, series: all.filter(m=>m.type==='series').length,
    movie: all.filter(m=>m.type==='movie').length, anime: all.filter(m=>m.type==='anime').length,
    watching: all.filter(m=>m.status==='watching').length, completed: all.filter(m=>m.status==='completed').length,
    pending: all.filter(m=>m.status==='pending').length, paused: all.filter(m=>m.status==='paused').length,
  };
  Object.entries(badges).forEach(([k,v]) => { const el=document.getElementById('badge-'+k); if(el) el.textContent=v; });
  const totalEp  = all.reduce((a,m)=>a+totalEpSeen(m),0);
  const contConf = all.filter(m=>m.continuation==='confirmed'||m.continuation==='airing').length;
  const contRum  = all.filter(m=>m.continuation==='rumor').length;
  document.getElementById('stats-bar').innerHTML = [
    `<div class="stat-pill"><i class="ti ti-player-play s-accent"></i><b>${badges.watching}</b> viendo</div>`,
    `<div class="stat-pill"><i class="ti ti-circle-check s-green"></i><b>${badges.completed}</b> completadas</div>`,
    `<div class="stat-pill"><i class="ti ti-list-numbers s-accent"></i><b>${totalEp}</b> episodios vistos</div>`,
    contConf ? `<div class="stat-pill"><i class="ti ti-check s-green"></i><b>${contConf}</b> continuación confirmada</div>` : '',
    contRum  ? `<div class="stat-pill"><i class="ti ti-eye s-orange"></i><b>${contRum}</b> continuación rumor</div>` : '',
  ].join('');
}

function render() {
  const list = getFiltered();
  const grid = document.getElementById('media-grid');
  const empty = document.getElementById('empty-state');
  if (list.length === 0) { grid.innerHTML=''; empty.style.display='block'; }
  else { empty.style.display='none'; grid.innerHTML=list.map(renderCard).join(''); }
  renderStats();
}

// ── SEASON FIELDS IN MODAL ─────────────────────────────────────────────────
let seasonCount = 0;

function addSeasonField(data) {
  seasonCount++;
  const idx = seasonCount;
  const s = data || {};
  const div = document.createElement('div');
  div.className = 'season-item';
  div.id = `season-item-${idx}`;
  div.innerHTML = `
    <div class="season-item-header">
      <span class="season-item-title">Temporada ${idx}</span>
      <button class="icon-btn-sm" onclick="removeSeasonField(${idx})" title="Eliminar"><i class="ti ti-x"></i></button>
    </div>
    <div class="season-poster-row">
      <div class="field" style="flex:1;margin:0">
        <label>URL del póster</label>
        <input type="url" id="s${idx}-poster" placeholder="Se rellena con TMDB" value="${s.poster||''}" oninput="updateMiniPoster(${idx},this.value)">
      </div>
      <div class="poster-mini" id="s${idx}-mini">${s.poster?`<img src="${s.poster}" alt="">` : '<i class="ti ti-photo"></i>'}</div>
    </div>
    <div class="row-2">
      <div class="field"><label>Episodios vistos</label><input type="number" id="s${idx}-seen" min="0" value="${s.epSeen||0}"></div>
      <div class="field"><label>Total episodios</label><input type="number" id="s${idx}-total" min="0" value="${s.epTotal||''}"></div>
    </div>
    <div class="field"><label>Nota personal</label><textarea id="s${idx}-note" rows="2" placeholder="Qué te pareció esta temporada...">${s.note||''}</textarea></div>
    <div class="row-2">
      <div class="field"><label>Puntuación (0–10)</label><input type="number" id="s${idx}-rating" min="0" max="10" step="0.5" value="${s.rating||''}"></div>
      <div class="field"><label>Día emisión <span style="font-size:10px;color:var(--text-muted)">(corregir si TMDB falla)</span></label><input type="text" id="s${idx}-airday" placeholder="Lunes, Jueves..." value="${s.airDay||''}"></div>
    </div>
    <input type="hidden" id="s${idx}-tmdbSeason" value="${s.tmdbSeason||idx}">
  `;
  document.getElementById('seasons-list').appendChild(div);
}

function removeSeasonField(idx) {
  const items = document.getElementById("seasons-list").querySelectorAll(".season-item");
  const itemEl = document.getElementById("season-item-" + idx);
  if (!itemEl) return;
  const allItems = Array.from(items);
  const isLast = allItems[allItems.length - 1] === itemEl;
  if (!isLast) {
    alert("Solo puedes eliminar la última temporada.\nNo se pueden borrar temporadas anteriores para no perder el progreso.");
    return;
  }
  const epSeen = parseInt(document.getElementById("s" + idx + "-seen")?.value) || 0;
  const msg = epSeen > 0
    ? "¿Eliminar esta temporada? Tienes " + epSeen + " episodios registrados y se perderán."
    : "¿Estás seguro de que quieres eliminar esta temporada?";
  if (!confirm(msg)) return;
  itemEl.remove();
}

function updateMiniPoster(idx, url) {
  const id = idx === "movie" ? "smovie-mini" : `s${idx}-mini`;
  const mini = document.getElementById(id);
  if (!mini) return;
  mini.innerHTML = url ? `<img src="${url}" alt="" onerror="this.parentElement.innerHTML='<i class=\\"ti ti-photo\\"></i>'">` : '<i class="ti ti-photo"></i>';
}






function getSeasonData() {
  const items = document.getElementById('seasons-list').querySelectorAll('.season-item');
  return Array.from(items).map((item, i) => {
    const idx = item.id.replace('season-item-','');
    return {
      number:     i + 1,
      poster:     document.getElementById(`s${idx}-poster`)?.value.trim() || '',
      epSeen:     parseInt(document.getElementById(`s${idx}-seen`)?.value) || 0,
      epTotal:    parseInt(document.getElementById(`s${idx}-total`)?.value) || 0,
      note:       document.getElementById(`s${idx}-note`)?.value.trim() || '',
      rating:     document.getElementById(`s${idx}-rating`)?.value || '',
      airDay:     document.getElementById(`s${idx}-airday`)?.value.trim() || '',
      tmdbSeason: parseInt(document.getElementById(`s${idx}-tmdbSeason`)?.value) || i+1,
    };
  });
}

// ── MODAL ──────────────────────────────────────────────────────────────────
function openModal(id) {
  editingId = id || null;
  const m = id ? mediaList.find(x=>x.id===id) : null;
  seasonCount = 0;
  document.getElementById('seasons-list').innerHTML = '';
  document.getElementById('modal-title').textContent = m ? 'Editar título' : 'Añadir título';
  document.getElementById('f-type').value         = m ? m.type : 'series';
  document.getElementById('f-title').value        = m ? m.title : '';
  document.getElementById('f-year').value         = m ? (m.year||'') : '';
  document.getElementById('f-genre').value        = m ? (m.genre||'') : '';
  document.getElementById('f-status').value       = m ? m.status : 'watching';
  document.getElementById('f-rating').value       = m ? (m.rating||'') : '';
  document.getElementById('f-continuation').value = m ? (m.continuation||'unknown') : 'unknown';
  document.getElementById('f-tmdb-id').value      = m ? (m.tmdbId||'') : '';
  document.getElementById('f-tmdb-type').value    = m ? (m.tmdbType||'tv') : 'tv';
  document.getElementById('tmdb-query').value     = '';
  document.getElementById('tmdb-results').innerHTML = '';
  document.getElementById('f-movie-poster').value = m ? (m.poster||'') : '';
  document.getElementById('f-is-anime-movie').checked = m ? (m.isAnimeMovie||false) : false;
  updateMiniPoster('movie', m?.poster || '');
  updateModalFields();
  if (m?.seasons?.length > 0) m.seasons.forEach(s => addSeasonField(s));
  else if (!m || m.type !== 'movie') addSeasonField();
  document.getElementById('add-modal').classList.add('open');
}

function updateModalFields() {
  const isMovie = document.getElementById('f-type').value === 'movie';
  document.getElementById('seasons-section').style.display = isMovie ? 'none' : 'block';
  document.getElementById('f-continuation-wrap').style.display = isMovie ? 'none' : 'block';
  document.getElementById('movie-poster-section').style.display = isMovie ? 'block' : 'none';
}

function closeModal()    { document.getElementById('add-modal').classList.remove('open'); }
function closeModalBg(e) { if (e.target.id==='add-modal') closeModal(); }

function calcRating(type, manualRating, seasons) {
  // For movies use manual rating directly
  if (type === 'movie') return manualRating;
  // Collect season ratings that have a value
  const ratings = seasons.map(s => parseFloat(s.rating)).filter(r => !isNaN(r) && r > 0);
  if (ratings.length === 0) return manualRating; // fallback to manual if no season ratings
  const avg = ratings.reduce((a,b) => a+b, 0) / ratings.length;
  return Math.round(avg * 10) / 10; // round to 1 decimal
}

async function saveMedia() {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { alert('El título es obligatorio'); return; }
  const type = document.getElementById('f-type').value;
  const entry = {
    id:           editingId || genId(),
    type,
    title,
    year:         document.getElementById('f-year').value,
    genre:        document.getElementById('f-genre').value.trim(),
    status:       document.getElementById('f-status').value,
    rating:       calcRating(type, document.getElementById('f-rating').value, type==='movie' ? [] : getSeasonData()),
    continuation: type==='movie' ? 'no' : document.getElementById('f-continuation').value,
    tmdbId:       document.getElementById('f-tmdb-id').value,
    tmdbType:     document.getElementById('f-tmdb-type').value,
    poster:       type==='movie' ? (document.getElementById('f-movie-poster').value.trim()||'') : '',
    isAnimeMovie: type==='movie' ? document.getElementById('f-is-anime-movie').checked : false,
    seasons:      type==='movie' ? [] : getSeasonData(),
    updatedAt:    Date.now(),
    addedAt:      editingId ? (mediaList.find(x=>x.id===editingId)?.addedAt || Date.now()) : Date.now(),
  };
  if (editingId) {
    const idx = mediaList.findIndex(x=>x.id===editingId);
    if (idx>=0) mediaList[idx]=entry; else mediaList.unshift(entry);
  } else {
    mediaList.unshift(entry);
  }
  saveData();
  closeModal();
  render();
  await saveToSupabase(entry);
}

// ── TMDB ───────────────────────────────────────────────────────────────────
async function searchTMDB() {
  const query = document.getElementById('tmdb-query').value.trim();
  if (!query) return;
  if (!settings.apiKey) { alert('Añade tu API Key de TMDB en Ajustes — gratis en themoviedb.org/settings/api'); return; }
  const btn = document.getElementById('tmdb-btn');
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Buscando...';
  document.getElementById('tmdb-results').innerHTML = '';
  try {
    // Use /search/multi to find everything regardless of type
    const res  = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${settings.apiKey}&query=${encodeURIComponent(query)}&language=${settings.lang}`);
    const data = await res.json();
    const results = (data.results||[]).filter(r => r.media_type === 'tv' || r.media_type === 'movie').slice(0, 12);
    if (results.length > 0) {
      document.getElementById('tmdb-results').innerHTML = results.map(r => {
        const title     = r.title||r.name||'';
        const year      = (r.release_date||r.first_air_date||'').slice(0,4);
        const mediaType = r.media_type; // 'tv' or 'movie'
        const typeIcon  = mediaType === 'movie' ? '🎬' : '📺';
        const img = r.poster_path
          ? `<img src="${TMDB_IMG}${r.poster_path}" alt="${title}" loading="lazy">`
          : `<div class="tmdb-result-no-img">${typeIcon}</div>`;
        const d = JSON.stringify({
          id: r.id, title, year,
          poster:   r.poster_path   ? `${TMDB_IMG}${r.poster_path}`  : '',
          backdrop: r.backdrop_path ? `${TMDB_BIG}${r.backdrop_path}` : '',
          mediaType
        }).replace(/"/g,'&quot;');
        return `<div class="tmdb-result" onclick="selectTMDB(${d}, this)">
          ${img}
          <div class="tmdb-result-title">${title} ${year?`(${year})`:''}</div>
          <div style="font-size:9px;text-align:center;color:var(--text-muted);padding:0 4px 3px">${mediaType==='movie'?'🎬 Película':'📺 Serie/Anime'}</div>
        </div>`;
      }).join('');

      // Auto-switch type selector based on first result
      const first = results[0];
      if (first.media_type === 'movie') {
        document.getElementById('f-type').value = 'movie';
      } else {
        // Keep current type (series or anime) — selectTMDB will auto-detect anime
      }
      updateModalFields();

    } else {
      document.getElementById('tmdb-results').innerHTML = '<p style="font-size:12px;color:var(--text-muted);padding:8px 0;">Sin resultados. Prueba con el título en inglés.</p>';
    }
  } catch(e) {
    document.getElementById('tmdb-results').innerHTML = '<p style="font-size:12px;color:var(--danger);padding:8px 0;">Error. Revisa tu API key.</p>';
  }
  btn.disabled=false; btn.innerHTML='<i class="ti ti-search"></i> Buscar';
}

async function selectTMDB(data, el) {
  document.querySelectorAll('.tmdb-result').forEach(e=>e.style.borderColor='transparent');
  el.style.borderColor='var(--accent)';
  document.getElementById('f-title').value   = data.title;
  document.getElementById('f-year').value    = data.year;
  document.getElementById('f-tmdb-id').value = data.id;
  document.getElementById('f-tmdb-type').value = data.mediaType;
  // Auto-switch type based on TMDB media_type
  if (data.mediaType === 'movie') {
    document.getElementById('f-type').value = 'movie';
    updateModalFields();
    if (data.poster) {
      document.getElementById('f-movie-poster').value = data.poster;
      updateMiniPoster('movie', data.poster);
    }
  } else {
    // If current type is movie, switch to series (anime detection happens later via genre)
    if (document.getElementById('f-type').value === 'movie') {
      document.getElementById('f-type').value = 'series';
      updateModalFields();
    }
  }
  if (!settings.apiKey) return;
  try {
    const res = await fetch(`https://api.themoviedb.org/3/${data.mediaType}/${data.id}?api_key=${settings.apiKey}&language=${settings.lang}`);
    const det = await res.json();
    if (det.genres?.length) {
      const genreNames = det.genres.map(g => g.name);
      document.getElementById("f-genre").value = genreNames.slice(0,2).join(", ");
      const isAnimation = genreNames.some(g => ["Animation","Animación","Anime"].includes(g));
      if (isAnimation && data.mediaType === "tv") {
        document.getElementById("f-type").value = "anime";
        updateModalFields();
      }
      if (isAnimation && data.mediaType === "movie") {
        document.getElementById("f-is-anime-movie").checked = true;
      }
    }
    if (data.mediaType === 'tv') {
      if (det.status === 'Ended' || det.status === 'Canceled') document.getElementById('f-continuation').value = 'no';
      else if (det.next_episode_to_air) document.getElementById('f-continuation').value = 'airing';
      else if (det.in_production) document.getElementById('f-continuation').value = 'confirmed';
      document.getElementById('seasons-list').innerHTML = '';
      seasonCount = 0;
      const nSeasons = det.number_of_seasons || 1;
      const seasonFetches = Array.from({length: nSeasons}, (_,i) =>
        fetch(`https://api.themoviedb.org/3/tv/${data.id}/season/${i+1}?api_key=${settings.apiKey}&language=${settings.lang}`).then(r=>r.json()).catch(()=>null)
      );
      const seasonDetails = await Promise.all(seasonFetches);
      seasonDetails.forEach((sd, i) => {
        addSeasonField({
          number:     i+1,
          poster:     sd?.poster_path ? `${TMDB_IMG}${sd.poster_path}` : (data.poster||''),
          epSeen:     0,
          epTotal:    sd?.episodes?.length || 0,
          note:       '',
          rating:     '',
          tmdbSeason: i+1,
        });
      });
    }
  } catch(e) {}
}

// ── DETAIL ─────────────────────────────────────────────────────────────────
function openDetail(id) {
  const m = mediaList.find(x=>x.id===id);
  if (!m) return;
  const emoji   = TYPE_EMOJI[m.type];
  const seasons = m.seasons || [];
  const activeSeason = seasons[activeSeasonTab[id] ?? 0];
  const activePoster = activeSeason?.poster || '';

  // Backdrop: franja difuminada solo decorativa
  const backdrop = document.getElementById('detail-backdrop');
  if (activePoster) {
    backdrop.style.backgroundImage = `url(${activePoster})`;
    backdrop.style.filter = 'blur(8px)';
    backdrop.style.transform = 'scale(1.05)'; // evitar bordes blancos del blur
    backdrop.style.opacity = '0.6';
  } else {
    backdrop.style.backgroundImage = 'none';
    backdrop.style.filter = 'none';
    backdrop.style.opacity = '1';
  }

  // Header: título e info (póster solo aparece en el panel de temporada)
  document.getElementById('detail-header').innerHTML = `
    <div class="detail-info">
      <h2>${m.title}</h2>
      <div class="meta">${[TYPE_LABEL[m.type], m.year, m.genre].filter(Boolean).join(' · ')}</div>
      <div class="card-tags" style="margin-top:6px">
        ${statusTag(m.status)}
        ${contTag(m.continuation)}
        ${m.rating ? `<span class="tag" style="background:var(--warning-bg);color:var(--warning-text)">★ ${m.rating}</span>` : ''}
      </div>
    </div>`;

  let bodyHTML = '';
  if (m.type !== 'movie' && seasons.length > 0) {
    const tabKey = activeSeasonTab[id] ?? 0;
    const tabs = seasons.map((s,i) =>
      `<button class="season-tab ${i===tabKey?'active':''}" onclick="switchSeasonTab('${id}',${i})" id="stab-${id}-${i}">T${s.number||i+1}</button>`
    ).join('');
    const panels = seasons.map((s,i) => {
      const epSeen  = parseInt(s.epSeen)  || 0;
      const epTotal = parseInt(s.epTotal) || 0;
      const pct     = epTotal>0 ? Math.round((epSeen/epTotal)*100) : 0;
      const fillCls = m.status==='completed' ? 'fill-completed' : (m.type==='anime'?'fill-anime':'fill-watching');
      return `<div class="season-panel ${i===tabKey?'active':''}" id="spanel-${id}-${i}">
        <div class="season-detail">
          <div class="season-detail-poster" id="sposter-${id}-${i}">
            ${s.poster ? `<img src="${s.poster}" alt="T${s.number||i+1}">` : `<div class="season-detail-placeholder">${emoji}</div>`}
          </div>
          <div class="season-detail-info">
            <div style="font-size:13px;font-weight:600;margin-bottom:6px">Temporada ${s.number||i+1}</div>
            <div class="ep-control">
              <button class="ep-btn" onclick="changeEp('${id}',${i},-1)">−</button>
              <span class="ep-count" id="ep-count-${id}-${i}">${epSeen}</span>
              <span class="ep-total">/ ${epTotal||'?'} ep</span>
              <button class="ep-btn" onclick="changeEp('${id}',${i},1)">+</button>
            </div>
            ${epTotal>0?`<div class="progress-bar" style="height:4px"><div class="progress-fill ${fillCls}" id="ep-bar-${id}-${i}" style="width:${pct}%"></div></div>`:''}
            ${s.rating?`<div style="font-size:13px;color:var(--warning-text);margin-top:8px">★ ${s.rating}/10</div>`:''}
          </div>
        </div>
        ${s.note?`<div class="season-note">${s.note}</div>`:''}
      </div>`;
    }).join('');
    bodyHTML = `<div class="season-tabs">${tabs}</div>${panels}`;
  }

  bodyHTML += `
    <div class="detail-actions">
      <button class="btn" onclick="closeDetail();openModal('${m.id}')"><i class="ti ti-edit"></i> Editar</button>
      <button class="btn btn-danger" onclick="deleteMedia('${m.id}')"><i class="ti ti-trash"></i> Eliminar</button>
    </div>`;

  document.getElementById('detail-body').innerHTML = bodyHTML;
  document.getElementById('detail-modal').classList.add('open');
}

function switchSeasonTab(id, idx) {
  activeSeasonTab[id] = idx;
  document.querySelectorAll(`[id^="stab-${id}-"]`).forEach((el,i) => el.classList.toggle('active', i===idx));
  document.querySelectorAll(`[id^="spanel-${id}-"]`).forEach((el,i) => el.classList.toggle('active', i===idx));
  const m = mediaList.find(x=>x.id===id);
  const poster = m?.seasons?.[idx]?.poster;
  const backdrop = document.getElementById('detail-backdrop');
  if (poster) {
    backdrop.style.backgroundImage = `url(${poster})`;
    backdrop.style.filter = 'blur(8px)';
    backdrop.style.transform = 'scale(1.05)';
    backdrop.style.opacity = '0.6';
  }
}

async function changeEp(id, seasonIdx, delta) {
  const m = mediaList.find(x=>x.id===id);
  if (!m || !m.seasons?.[seasonIdx]) return;
  const s = m.seasons[seasonIdx];
  const maxEp = parseInt(s.epTotal) || Infinity;
  const prevSeen = parseInt(s.epSeen)||0;
  s.epSeen = Math.min(maxEp, Math.max(0, prevSeen + delta));

  // Check if this season just finished
  if (delta > 0 && s.epSeen >= maxEp && maxEp > 0 && prevSeen < maxEp) {
    await handleSeasonComplete(m, seasonIdx);
    return;
  }

  const allDone = m.seasons.every(s => s.epTotal > 0 && s.epSeen >= s.epTotal);
  if (allDone) m.status = 'completed';
  m.rating = calcRating(m.type, m.rating, m.seasons);
  m.updatedAt = Date.now();
  saveData();
  render();
  const countEl = document.getElementById(`ep-count-${id}-${seasonIdx}`);
  const barEl   = document.getElementById(`ep-bar-${id}-${seasonIdx}`);
  if (countEl) countEl.textContent = s.epSeen;
  if (barEl && s.epTotal > 0) barEl.style.width = Math.round((s.epSeen/s.epTotal)*100)+'%';
  await saveToSupabase(m);
}

async function deleteMedia(id) {
  if (!confirm('¿Eliminar este título de tu biblioteca?')) return;
  mediaList = mediaList.filter(x=>x.id!==id);
  saveData();
  closeDetail();
  render();
  await deleteFromSupabase(id);
}

function closeDetail()    { document.getElementById('detail-modal').classList.remove('open'); }
function closeDetailBg(e) { if (e.target.id==='detail-modal') closeDetail(); }

// ── SETTINGS ──────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('s-apikey').value = settings.apiKey||'';
  document.getElementById('s-lang').value   = settings.lang||'es-ES';
  document.getElementById('settings-modal').classList.add('open');
}
function closeSettings()    { document.getElementById('settings-modal').classList.remove('open'); }
function closeSettingsBg(e) { if (e.target.id==='settings-modal') closeSettings(); }
function saveSettings() {
  settings.apiKey = document.getElementById('s-apikey').value.trim();
  settings.lang   = document.getElementById('s-lang').value;
  localStorage.setItem('medialog_settings', JSON.stringify(settings));
  closeSettings(); alert('Ajustes guardados ✓');
}

// ── EXPORT / IMPORT ────────────────────────────────────────────────────────
function exportData() {
  const blob = new Blob([JSON.stringify(mediaList,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `medialog_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}
function importData(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error();
      const merge = confirm(`${data.length} títulos encontrados.\nSí = Fusionar · No = Reemplazar todo`);
      if (merge) { const ids=new Set(mediaList.map(m=>m.id)); data.forEach(m=>{ if(!ids.has(m.id)) mediaList.push(m); }); }
      else mediaList = data;
      saveData(); render();
      // Sync all to Supabase
      for (const entry of mediaList) await saveToSupabase(entry);
      alert(`Importación completada. ${mediaList.length} títulos.`);
    } catch(e) { alert('Error: archivo no válido.'); }
  };
  reader.readAsText(file); event.target.value='';
}

// Spinner
const style = document.createElement('style');
style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(style);

// ── INIT ───────────────────────────────────────────────────────────────────
loadFromSupabase();
loadNotifHistory();

// ── GLOBAL TMDB REFRESH ────────────────────────────────────────────────────
let lastRefreshChanges = []; // store detected changes from last refresh

async function globalTMDBRefresh() {
  if (!settings.apiKey) {
    alert('Necesitas la API key de TMDB en Ajustes.');
    return;
  }

  // Animate refresh icon
  const icon = document.getElementById('global-refresh-icon');
  const btn  = document.getElementById('global-refresh-btn');
  if (icon) icon.style.animation = 'spin 1s linear infinite';
  if (btn)  btn.disabled = true;

  // Show panel immediately with loading state
  openUpdatesPanel(true);

  // Save snapshot of current state before refresh
  const snapshot = {};
  mediaList.forEach(m => {
    if (m.tmdbId) snapshot[m.tmdbId] = {
      continuation: m.continuation,
      lastSeason: tmdbCache[m.tmdbId]?.lastSeason || null,
      status: tmdbCache[m.tmdbId]?.status || null,
      nextEpId: tmdbCache[m.tmdbId]?.nextEp ? `${tmdbCache[m.tmdbId].nextEp.season_number}-${tmdbCache[m.tmdbId].nextEp.episode_number}` : null,
    };
  });

  // Force clear all cache to get fresh data
  tmdbCache = {};
  const watching = mediaList.filter(m => m.tmdbId && m.tmdbType === 'tv' && m.status !== 'dropped' && m.status !== 'pending');
  for (const m of watching) await fetchTMDBLive(m);

  // Detect changes vs snapshot
  lastRefreshChanges = [];
  const today = new Date().toISOString().slice(0,10);

  watching.forEach(m => {
    const prev = snapshot[m.tmdbId] || {};
    const curr = tmdbCache[m.tmdbId];
    if (!curr) return;

    const poster = getCardPoster(m);
    const currNextId = curr.nextEp ? `${curr.nextEp.season_number}-${curr.nextEp.episode_number}` : null;

    // Nueva temporada confirmada
    if (!prev.nextEpId && currNextId) {
      lastRefreshChanges.push({ type: 'new_ep_announced', icon: '📢', title: m.title, poster,
        desc: `T${curr.nextEp.season_number} anunciada — primer ep el ${formatDate(curr.nextEp.air_date)}`,
        mediaId: m.id, isNew: true });
    }
    // Más temporadas en TMDB que antes
    if (prev.lastSeason && curr.lastSeason && curr.lastSeason > prev.lastSeason) {
      lastRefreshChanges.push({ type: 'new_season', icon: '🆕', title: m.title, poster,
        desc: `Temporada ${curr.lastSeason} registrada en TMDB (antes: ${prev.lastSeason})`,
        mediaId: m.id, isNew: true });
    }
    // Cancelada
    if (curr.status === 'Canceled' && prev.status && prev.status !== 'Canceled') {
      lastRefreshChanges.push({ type: 'cancelled', icon: '❌', title: m.title, poster,
        desc: `Cancelada según TMDB`, mediaId: m.id, isNew: true });
    }
    // Finalizada
    if (curr.status === 'Ended' && prev.status && prev.status !== 'Ended') {
      lastRefreshChanges.push({ type: 'ended', icon: '🏁', title: m.title, poster,
        desc: `Serie finalizada según TMDB`, mediaId: m.id, isNew: true });
    }
    // Episodio hoy
    if (curr.nextEp?.air_date === today) {
      lastRefreshChanges.push({ type: 'today', icon: '📺', title: m.title, poster,
        desc: `Sale hoy T${curr.nextEp.season_number} Ep ${curr.nextEp.episode_number}`,
        mediaId: m.id, isNew: false });
    }
    // Sin cambios — still show it
    if (lastRefreshChanges.findIndex(c=>c.mediaId===m.id) === -1) {
      lastRefreshChanges.push({ type: 'ok', icon: '✓', title: m.title, poster,
        desc: curr.nextEp
          ? `Sin cambios · próx ep T${curr.nextEp.season_number}×${curr.nextEp.episode_number} el ${formatDate(curr.nextEp.air_date)}`
          : curr.status === 'Ended' ? 'Finalizada' : curr.status === 'Canceled' ? 'Cancelada' : 'Sin novedades',
        mediaId: m.id, isNew: false });
    }
  });

  // Sort: new changes first, then ok
  lastRefreshChanges.sort((a,b) => {
    const order = { today:0, new_season:1, new_ep_announced:2, cancelled:3, ended:4, ok:5 };
    return (order[a.type]||9) - (order[b.type]||9);
  });

  buildNotifications();
  buildCalendar();
  updateNotifDot();

  // Show green dot on refresh button if there are new things
  const dot = document.getElementById('refresh-dot');
  if (dot) dot.style.display = lastRefreshChanges.some(c=>c.isNew) ? 'block' : 'none';

  if (icon) icon.style.animation = '';
  if (btn)  btn.disabled = false;

  renderUpdatesPanel();
}

function openUpdatesPanel(loading) {
  // Close other panels
  document.getElementById('notif-panel').style.display = 'none';
  document.getElementById('calendar-panel').style.display = 'none';
  panelOpen = 'updates';
  document.getElementById('updates-panel').style.display = 'flex';
  if (loading) {
    document.getElementById('updates-list').innerHTML = '<div class="panel-loading"><i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Consultando TMDB...</div>';
  } else {
    renderUpdatesPanel();
  }
  // Hide refresh dot when panel opens
  const dot = document.getElementById('refresh-dot');
  if (dot) dot.style.display = 'none';
}

function closeUpdatesPanel() {
  document.getElementById('updates-panel').style.display = 'none';
  panelOpen = null;
}

function renderUpdatesPanel() {
  const el = document.getElementById('updates-list');
  if (!el) return;
  if (lastRefreshChanges.length === 0) {
    el.innerHTML = '<div class="notif-empty"><i class="ti ti-refresh"></i>Pulsa ↺ para comprobar actualizaciones de TMDB.</div>';
    return;
  }

  const newItems = lastRefreshChanges.filter(c => c.isNew);
  const okItems  = lastRefreshChanges.filter(c => !c.isNew);

  let html = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Última comprobación: ${new Date().toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}</div>`;

  if (newItems.length > 0) {
    html += `<div class="notif-section-label">🔔 Novedades (${newItems.length})</div>`;
    html += newItems.map(c => updateItemHTML(c)).join('');
  }

  html += `<div class="notif-section-label" style="margin-top:8px">✓ Sin cambios (${okItems.length})</div>`;
  html += okItems.map(c => updateItemHTML(c)).join('');

  el.innerHTML = html;
}

function updateItemHTML(c) {
  const poster = c.poster ? `<img src="${c.poster}" alt="">` : `<div class="notif-poster-ph">${c.icon}</div>`;
  const bgCls = c.isNew ? (c.type === 'today' ? 'notif-today' : c.type === 'cancelled' ? 'notif-cancelled' : c.type === 'ended' ? 'notif-ended' : 'notif-announced') : '';
  return `<div class="notif-item ${bgCls}" onclick="closeUpdatesPanel();openDetail('${c.mediaId}')">
    <div class="notif-poster">${poster}</div>
    <div class="notif-content">
      <div class="notif-title">${c.icon} ${c.title}</div>
      <div class="notif-desc">${c.desc}</div>
    </div>
  </div>`;
}

// ── MOBILE NAV ─────────────────────────────────────────────────────────────
function mobileNav(section, el) {
  document.querySelectorAll('.mobile-nav-item').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
  setSection(section);
}

// ── RECARGAR TEMPORADAS DESDE TMDB ─────────────────────────────────────────
async function reloadSeasonsFromTMDB() {
  const tmdbId   = document.getElementById('f-tmdb-id').value;
  const tmdbType = document.getElementById('f-tmdb-type').value || 'tv';
  if (!tmdbId) { alert('Primero busca el título en TMDB para poder recargar las temporadas.'); return; }
  if (!settings.apiKey) { alert('Añade tu API Key de TMDB en Ajustes.'); return; }
  if (tmdbType === 'movie') { alert('Las películas no tienen temporadas.'); return; }

  const btn = document.querySelector('[title="Recargar desde TMDB"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i>'; }

  try {
    // Guardar episodios ya vistos antes de recargar
    const existingSeasons = getSeasonData();

    const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${settings.apiKey}&language=${settings.lang}`);
    const det = await res.json();
    const nSeasons = det.number_of_seasons || 1;

    const seasonFetches = Array.from({length: nSeasons}, (_,i) =>
      fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${i+1}?api_key=${settings.apiKey}&language=${settings.lang}`)
        .then(r=>r.json()).catch(()=>null)
    );
    const seasonDetails = await Promise.all(seasonFetches);

    document.getElementById('seasons-list').innerHTML = '';
    seasonCount = 0;

    seasonDetails.forEach((sd, i) => {
      // Mantener progreso ya guardado si existía esa temporada
      const prev = existingSeasons[i];
      addSeasonField({
        number:     i + 1,
        poster:     sd?.poster_path ? `${TMDB_IMG}${sd.poster_path}` : (prev?.poster || ''),
        epSeen:     prev?.epSeen  || 0,
        epTotal:    sd?.episodes?.length || prev?.epTotal || 0,
        note:       prev?.note    || '',
        rating:     prev?.rating  || '',
        tmdbSeason: i + 1,
      });
    });

    // Auto-detectar anime
    if (det.genres?.length) {
      const genreNames = det.genres.map(g => g.name);
      const isAnim = genreNames.some(g => ['Animation','Animación','Anime'].includes(g));
      if (isAnim) { document.getElementById('f-type').value = 'anime'; updateModalFields(); }
    }

  } catch(e) {
    alert('Error al conectar con TMDB. Revisa tu API key.');
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> TMDB'; }
}

// ── BORRAR TODA LA BIBLIOTECA ─────────────────────────────────────────────
async function deleteAll() {
  if (mediaList.length === 0) { alert('Tu biblioteca ya está vacía.'); return; }
  if (!confirm(`¿Borrar los ${mediaList.length} títulos de tu biblioteca?\nEsta acción no se puede deshacer.`)) return;
  const all = [...mediaList];
  mediaList = [];
  saveData();
  render();
  for (const item of all) await deleteFromSupabase(item.id);
}

// ════════════════════════════════════════════════════════════════
// QUICK CONTROLS — episodios y rating desde la tarjeta
// ════════════════════════════════════════════════════════════════

// Reescribir renderCard para incluir controles rápidos
function renderCard(m) {
  const isAnime  = m.type === 'anime';
  const epSeen   = m.type === 'movie' ? 0 : totalEpSeen(m);
  const epTotal  = m.type === 'movie' ? 0 : totalEpTotal(m);
  const pct      = epTotal > 0 ? Math.round((epSeen/epTotal)*100) : 0;
  const fillCls  = m.status === 'completed' ? 'fill-completed' : (isAnime ? 'fill-anime' : 'fill-watching');
  const poster   = getCardPoster(m);
  const nSeasons = (m.seasons||[]).length;

  const posterHTML = poster
    ? `<img src="${poster}" alt="${m.title}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'card-poster-placeholder\\'><span>${TYPE_EMOJI[m.type]}</span></div>'">`
    : `<div class="card-poster-placeholder" style="background:${isAnime?'var(--anime-bg)':'var(--accent-bg)'}">
         <span>${TYPE_EMOJI[m.type]}</span><span>${m.title.slice(0,18)}</span>
       </div>`;

  const typeBadge = m.type === 'anime' || (m.type === 'movie' && m.isAnimeMovie)
    ? `<span class="card-corner" style="background:var(--anime-color);color:white">Anime</span>`
    : m.type === 'movie'
    ? `<span class="card-corner" style="background:var(--warning);color:#111">Película</span>`
    : '';
  const seasonsBadge = m.type !== 'movie' && nSeasons > 1
    ? `<span class="card-seasons-count">${nSeasons} temporadas</span>`
    : '';

  const progressHTML = (m.type !== 'movie' && epTotal > 0) ? `
    <div class="progress-wrap">
      <div class="progress-label"><span>${epSeen}/${epTotal} ep</span><span>${pct}%</span></div>
      <div class="progress-bar"><div class="progress-fill ${fillCls}" style="width:${pct}%"></div></div>
    </div>` : '';

  // Quick controls — current season (last active or first incomplete)
  const activeSeason = getActiveSeason(m);
  const qSeasonIdx   = activeSeason.idx;
  const qSeason      = activeSeason.season;
  const qEpSeen      = parseInt(qSeason?.epSeen)||0;
  const qEpTotal     = parseInt(qSeason?.epTotal)||0;
  const qRating      = parseFloat(m.rating)||0;

  const quickEp = m.type !== 'movie' && qSeason ? `
    <div class="card-quick-ep">
      <button class="qbtn" onclick="quickEp('${m.id}',${qSeasonIdx},-1,event)">−</button>
      <span class="qep-label">T${(qSeason.number||qSeasonIdx+1)} · ${qEpSeen}/${qEpTotal||'?'}</span>
      <button class="qbtn" onclick="quickEp('${m.id}',${qSeasonIdx},1,event)">+</button>
    </div>` : '';

  const quickRating = `
    <div class="qrating">
      <button class="qrating-btn" onclick="quickRating('${m.id}',-0.5,event)">−</button>
      <span class="qrating-val">${qRating||'—'}</span>
      <button class="qrating-btn" onclick="quickRating('${m.id}',0.5,event)">+</button>
    </div>`;

  return `<div class="card" onclick="openDetail('${m.id}')" role="button" tabindex="0" aria-label="${m.title}">
    <div class="card-poster">
      ${posterHTML}
      <div class="card-poster-overlay"></div>
      ${typeBadge}${seasonsBadge}
      ${m.rating ? `<span class="card-rating">★ ${m.rating}</span>` : ''}
      <div class="card-quick">
        ${quickEp}
        ${quickRating}
      </div>
    </div>
    <div class="card-body">
      <div class="card-title">${m.title}</div>
      <div class="card-meta">${[m.year, m.genre].filter(Boolean).join(' · ')}</div>
      <div class="card-tags">${statusTag(m.status)}${contTag(m.continuation)}</div>
      ${progressHTML}
    </div>
  </div>`;
}

// Get the active season (first incomplete, or last)
function getActiveSeason(m) {
  const seasons = m.seasons || [];
  if (seasons.length === 0) return { idx: 0, season: null };
  // Find first season not completed
  for (let i = 0; i < seasons.length; i++) {
    const s = seasons[i];
    const seen = parseInt(s.epSeen)||0;
    const total = parseInt(s.epTotal)||0;
    if (total === 0 || seen < total) return { idx: i, season: s };
  }
  // All complete — return last
  return { idx: seasons.length-1, season: seasons[seasons.length-1] };
}

async function quickEp(id, seasonIdx, delta, event) {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  const m = mediaList.find(x => x.id === id);
  if (!m || !m.seasons?.[seasonIdx]) return;
  const s = m.seasons[seasonIdx];
  const maxEp = parseInt(s.epTotal) || Infinity;
  const prevSeen = parseInt(s.epSeen)||0;
  s.epSeen = Math.min(maxEp, Math.max(0, prevSeen + delta));

  if (delta > 0 && s.epSeen >= maxEp && maxEp > 0 && prevSeen < maxEp) {
    await handleSeasonComplete(m, seasonIdx);
    return;
  }

  const allDone = m.seasons.every(s => s.epTotal > 0 && s.epSeen >= s.epTotal);
  if (allDone) m.status = 'completed';
  m.rating = calcRating(m.type, m.rating, m.seasons);
  m.updatedAt = Date.now();
  saveData();
  render();
  await saveToSupabase(m);
}

async function quickRating(id, delta, event) {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  const m = mediaList.find(x => x.id === id);
  if (!m) return;
  const current = parseFloat(m.rating) || 0;
  m.rating = Math.min(10, Math.max(0, Math.round((current + delta) * 10) / 10));
  m.updatedAt = Date.now();
  saveData();
  render();
  await saveToSupabase(m);
}

// ════════════════════════════════════════════════════════════════
// TMDB LIVE DATA — calendar & notifications
// ════════════════════════════════════════════════════════════════
let tmdbCache = {};     // { tmdbId: { nextEp, lastEp, status, updated } }
let notifications = JSON.parse(localStorage.getItem('ml_notifs') || '[]');
let calendarData  = [];
let panelOpen     = null; // 'notif' | 'calendar' | null

function toggleNotifications() {
  if (panelOpen === 'notif') { closePanel(); return; }
  closePanel();
  document.getElementById('updates-panel').style.display = 'none';
  panelOpen = 'notif';
  document.getElementById('notif-panel').style.display = 'flex';
  renderNotifications();
  refreshAll();
}

function toggleCalendar() {
  if (panelOpen === 'calendar') { closePanel(); return; }
  closePanel();
  document.getElementById('updates-panel').style.display = 'none';
  panelOpen = 'calendar';
  document.getElementById('calendar-panel').style.display = 'flex';
  renderCalendar();
  refreshAll();
}

function closePanel() {
  document.getElementById('notif-panel').style.display = 'none';
  document.getElementById('calendar-panel').style.display = 'none';
  document.getElementById('updates-panel').style.display = 'none';
  panelOpen = null;
}

async function refreshAll() {
  if (!settings.apiKey) return;
  const watching = mediaList.filter(m => m.tmdbId && m.tmdbType === 'tv' && m.status !== 'dropped' && m.status !== 'pending');
  for (const m of watching) {
    await fetchTMDBLive(m);
  }
  buildNotifications();
  buildCalendar();
  if (panelOpen === 'notif')    renderNotifications();
  if (panelOpen === 'calendar') renderCalendar();
  updateNotifDot();
}

async function fetchTMDBLive(m) {
  const cacheKey = m.tmdbId;
  const cached = tmdbCache[cacheKey];
  // Refresh every 6 hours
  if (cached && (Date.now() - cached.updated) < 6 * 60 * 60 * 1000) return;

  try {
    const res  = await fetch(`https://api.themoviedb.org/3/tv/${m.tmdbId}?api_key=${settings.apiKey}&language=${settings.lang}`);
    const det  = await res.json();
    tmdbCache[cacheKey] = {
      id:         m.tmdbId,
      mediaId:    m.id,
      title:      m.title,
      poster:     getCardPoster(m),
      status:     det.status,
      nextEp:     det.next_episode_to_air || null,
      lastEp:     det.last_episode_to_air || null,
      lastSeason: det.number_of_seasons || null,
      inProd:     det.in_production,
      updated:    Date.now(),
    };
    // Auto-update continuation status in library
    const entry = mediaList.find(x => x.id === m.id);
    if (entry) {
      let newCont = entry.continuation;
      if (det.status === 'Ended' || det.status === 'Canceled') newCont = 'no';
      else if (det.next_episode_to_air) newCont = 'airing';
      else if (det.in_production) newCont = 'confirmed';
      if (newCont !== entry.continuation) {
        entry.continuation = newCont;
        entry.updatedAt = Date.now();
        saveData();
        await saveToSupabase(entry);
      }
    }
  } catch(e) {}
}

// ── NOTIFICATION HISTORY (permanent, saved to Supabase) ──────────────────
let notifHistory = JSON.parse(localStorage.getItem('ml_notif_history') || '[]');

async function loadNotifHistory() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/notif_history?select=*&order=created_at.desc&limit=200`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        notifHistory = rows.map(r => r.data || r);
        localStorage.setItem('ml_notif_history', JSON.stringify(notifHistory));
      }
    }
  } catch(e) {}
}

async function saveNotifToHistory(notif) {
  // Avoid duplicates
  if (notifHistory.find(n => n.id === notif.id)) return;
  const entry = { ...notif, createdAt: Date.now(), seen: false };
  notifHistory.unshift(entry);
  // Keep max 500 in local
  if (notifHistory.length > 500) notifHistory = notifHistory.slice(0, 500);
  localStorage.setItem('ml_notif_history', JSON.stringify(notifHistory));
  // Save to Supabase
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/notif_history`, {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ id: notif.id, data: entry, created_at: new Date().toISOString() })
    });
  } catch(e) {}
}

function markHistorySeen() {
  notifHistory.forEach(n => n.seen = true);
  localStorage.setItem('ml_notif_history', JSON.stringify(notifHistory));
}

// Track previous TMDB states to detect changes
let prevTmdbStates = JSON.parse(localStorage.getItem('ml_tmdb_states') || '{}');

function buildNotifications() {
  const newNotifs = [];
  const today = new Date().toISOString().slice(0, 10);
  const seenIds = new Set(notifications.filter(n => n.seen).map(n => n.id));
  const newHistoryItems = [];

  Object.values(tmdbCache).forEach(data => {
    const prev = prevTmdbStates[data.id] || {};

    // ── Episode airing today ──
    if (data.nextEp) {
      const airDate = data.nextEp.air_date;
      const nid = `ep-${data.id}-${data.nextEp.season_number}-${data.nextEp.episode_number}`;
      if (airDate === today) {
        const n = { id: nid, type: 'today', mediaId: data.mediaId, poster: data.poster,
          title: data.title, icon: '📺',
          desc: `Sale hoy el episodio ${data.nextEp.episode_number} de T${data.nextEp.season_number}`,
          date: today, seen: seenIds.has(nid) };
        newNotifs.push(n);
        newHistoryItems.push(n);
      } else if (airDate > today) {
        newNotifs.push({ id: nid, type: 'upcoming', mediaId: data.mediaId, poster: data.poster,
          title: data.title, icon: '📅',
          desc: `Ep ${data.nextEp.episode_number} T${data.nextEp.season_number} — ${formatDate(airDate)}`,
          date: airDate, seen: true });
      }
    }

    // ── New season confirmed (TMDB change detected) ──
    if (data.inProd && prev.inProd === false) {
      const nid = `prod-start-${data.id}-${Date.now()}`;
      const n = { id: nid, type: 'announced', mediaId: data.mediaId, poster: data.poster,
        title: data.title, icon: '🎉',
        desc: `¡Nueva temporada confirmada! Ha entrado en producción`,
        date: today, seen: false };
      newNotifs.push(n); newHistoryItems.push(n);
    }

    // ── Next episode announced (didn't have one before) ──
    if (data.nextEp && !prev.nextEpId) {
      const nid = `next-ep-announced-${data.id}-${data.nextEp.season_number}`;
      const n = { id: nid, type: 'announced', mediaId: data.mediaId, poster: data.poster,
        title: data.title, icon: '📢',
        desc: `T${data.nextEp.season_number} anunciada — primer episodio el ${formatDate(data.nextEp.air_date)}`,
        date: today, seen: seenIds.has(nid) };
      newNotifs.push(n); newHistoryItems.push(n);
    }

    // ── Season number increased ──
    if (prev.lastSeason && data.lastSeason && data.lastSeason > prev.lastSeason) {
      const nid = `new-season-${data.id}-${data.lastSeason}`;
      const n = { id: nid, type: 'announced', mediaId: data.mediaId, poster: data.poster,
        title: data.title, icon: '🆕',
        desc: `Temporada ${data.lastSeason} disponible en TMDB`,
        date: today, seen: seenIds.has(nid) };
      newNotifs.push(n); newHistoryItems.push(n);
    }

    // ── Show cancelled ──
    if (data.status === 'Canceled' && prev.status && prev.status !== 'Canceled') {
      const nid = `cancelled-${data.id}`;
      const n = { id: nid, type: 'cancelled', mediaId: data.mediaId, poster: data.poster,
        title: data.title, icon: '❌',
        desc: `Cancelada según TMDB`,
        date: today, seen: seenIds.has(nid) };
      newNotifs.push(n); newHistoryItems.push(n);
    }

    // ── Show ended ──
    if (data.status === 'Ended' && prev.status && prev.status !== 'Ended') {
      const nid = `ended-${data.id}`;
      const n = { id: nid, type: 'ended', mediaId: data.mediaId, poster: data.poster,
        title: data.title, icon: '🏁',
        desc: `Serie finalizada según TMDB`,
        date: today, seen: seenIds.has(nid) };
      newNotifs.push(n); newHistoryItems.push(n);
    }

    // ── In production, no next ep = still announced ──
    if (data.inProd && !data.nextEp) {
      const nid = `s2-${data.id}`;
      newNotifs.push({ id: nid, type: 'announced', mediaId: data.mediaId, poster: data.poster,
        title: data.title, icon: '📢',
        desc: `Continuación confirmada · en producción`,
        date: '', seen: seenIds.has(nid) });
    }

    // Save current state for next comparison
    prevTmdbStates[data.id] = {
      inProd: data.inProd,
      status: data.status,
      nextEpId: data.nextEp ? `${data.nextEp.season_number}-${data.nextEp.episode_number}` : null,
      lastSeason: data.lastSeason,
    };
  });

  localStorage.setItem('ml_tmdb_states', JSON.stringify(prevTmdbStates));

  const prevTodayIds = new Set(notifications.filter(n=>n.type==='today').map(n=>n.id));
  notifications = newNotifs.sort((a,b) => {
    const order = { today: 0, cancelled: 1, ended: 1, announced: 2, upcoming: 3 };
    return (order[a.type]||9) - (order[b.type]||9) || (a.date||'').localeCompare(b.date||'');
  });
  localStorage.setItem('ml_notifs', JSON.stringify(notifications));

  // Save new items to history and send browser notifs
  newHistoryItems.forEach(async n => {
    await saveNotifToHistory(n);
    if (!prevTodayIds.has(n.id)) {
      sendBrowserNotif(n.icon + ' ' + n.title, n.desc, n.poster);
    }
  });
}

function buildCalendar() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const in30 = new Date(today.getTime() + 30*24*60*60*1000).toISOString().slice(0,10);
  calendarData = [];

  Object.values(tmdbCache).forEach(data => {
    if (data.nextEp && data.nextEp.air_date >= todayStr && data.nextEp.air_date <= in30) {
      // Check if user has a custom airDay for this season
      const entry = mediaList.find(x=>x.id===data.mediaId);
      const seasonObj = entry?.seasons?.find(s=>s.tmdbSeason===data.nextEp.season_number || s.number===data.nextEp.season_number);
      calendarData.push({
        date: data.nextEp.air_date,
        mediaId: data.mediaId,
        poster: data.poster,
        title: data.title,
        season: data.nextEp.season_number,
        episode: data.nextEp.episode_number,
        epName: data.nextEp.name || '',
        airDay: seasonObj?.airDay || '',
      });
    }
  });

  calendarData.sort((a,b) => a.date.localeCompare(b.date));
}

let notifTab = 'new'; // 'new' | 'history'

function renderNotifications() {
  const el = document.getElementById('notif-list');
  if (!el) return;

  // Tab bar
  const tabBar = `<div class="notif-tabs">
    <button class="notif-tab ${notifTab==='new'?'active':''}" onclick="setNotifTab('new')">Actuales</button>
    <button class="notif-tab ${notifTab==='history'?'active':''}" onclick="setNotifTab('history')">
      Historial <span class="notif-history-count">${notifHistory.length}</span>
    </button>
  </div>`;

  if (notifTab === 'history') {
    const hist = notifHistory.slice(0, 100);
    const histHTML = hist.length === 0
      ? `<div class="notif-empty"><i class="ti ti-history"></i>El historial está vacío.</div>`
      : hist.map(n => notifItemHTML(n, true)).join('');
    el.innerHTML = tabBar + histHTML;
    return;
  }

  // Current notifications
  const today   = notifications.filter(n => n.type === 'today');
  const changes = notifications.filter(n => ['announced','cancelled','ended'].includes(n.type));
  const upcoming= notifications.filter(n => n.type === 'upcoming');

  if (notifications.length === 0) {
    el.innerHTML = tabBar + `<div class="notif-empty"><i class="ti ti-bell-off"></i>Sin notificaciones activas.<br><small>Añade series con TMDB para ver actualizaciones.</small></div>`;
  } else {
    let html = tabBar;
    if (today.length) {
      html += `<div class="notif-section-label">🟢 Hoy</div>`;
      html += today.map(n => notifItemHTML(n)).join('');
    }
    if (changes.length) {
      html += `<div class="notif-section-label">📢 Novedades TMDB</div>`;
      html += changes.map(n => notifItemHTML(n)).join('');
    }
    if (upcoming.length) {
      html += `<div class="notif-section-label">📅 Próximamente</div>`;
      html += upcoming.map(n => notifItemHTML(n)).join('');
    }
    el.innerHTML = html;
  }

  // Mark all as seen
  notifications.forEach(n => n.seen = true);
  localStorage.setItem('ml_notifs', JSON.stringify(notifications));
  updateNotifDot();
}

function setNotifTab(tab) {
  notifTab = tab;
  if (tab === 'history') markHistorySeen();
  renderNotifications();
}

function notifItemHTML(n, showDate=false) {
  const clsMap = { today:'notif-today', announced:'notif-announced', cancelled:'notif-cancelled', ended:'notif-ended' };
  const cls = clsMap[n.type] || '';
  const poster = n.poster ? `<img src="${n.poster}" alt="">` : `<div class="notif-poster-ph">${n.icon||'📺'}</div>`;
  const dateStr = showDate && n.createdAt ? `<div class="notif-time">${new Date(n.createdAt).toLocaleDateString('es-ES',{day:'numeric',month:'short',year:'numeric'})}</div>` : '';
  return `<div class="notif-item ${cls}" onclick="closePanel();openDetail('${n.mediaId}')">
    <div class="notif-poster">${poster}</div>
    <div class="notif-content">
      <div class="notif-title">${n.icon ? n.icon+' ' : ''}${n.title}</div>
      <div class="notif-desc">${n.desc}</div>
      ${dateStr}
    </div>
  </div>`;
}

function renderCalendar() {
  const el = document.getElementById('calendar-list');
  if (!el) return;

  if (calendarData.length === 0) {
    el.innerHTML = `<div class="notif-empty"><i class="ti ti-calendar-off"></i>Sin episodios próximos.<br><small>Solo aparecen series en "Viendo" con TMDB conectado.</small></div>`;
    return;
  }

  const todayStr = new Date().toISOString().slice(0,10);

  // Group by date
  const grouped = {};
  calendarData.forEach(item => {
    if (!grouped[item.date]) grouped[item.date] = [];
    grouped[item.date].push(item);
  });

  // Build week columns like Steam — show next 7 days
  const days = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const ds = d.toISOString().slice(0,10);
    if (grouped[ds]) days.push({ date: ds, items: grouped[ds], d });
  }

  const DAY_NAMES = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const MONTH_NAMES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

  let html = '';
  days.forEach(({ date, items, d }) => {
    const isToday = date === todayStr;
    const dayLabel = isToday ? '🟢 HOY' : `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`.toUpperCase();
    html += `<div class="cal-day">
      <div class="cal-day-label ${isToday?'today':''}">${dayLabel}</div>
      ${items.map(item => {
        const poster = item.poster ? `<img src="${item.poster}" alt="">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px">📺</div>`;
        return `<div class="cal-item ${isToday?'today-ep':''}" onclick="closePanel();openDetail('${item.mediaId}')">
          <div class="cal-poster">${poster}</div>
          <div class="cal-info">
            <div class="cal-title">${item.title}</div>
            <div class="cal-ep">T${item.season} · Ep ${item.episode}${item.epName?' — <em>'+item.epName+'</em>':''}</div>
            ${item.airDay ? `<div class="cal-time">📅 ${item.airDay}</div>` : ''}
          </div>
          ${isToday ? '<span style="font-size:10px;background:var(--success);color:white;border-radius:4px;padding:2px 6px;flex-shrink:0">HOY</span>' : ''}
        </div>`;
      }).join('')}
    </div>`;
  });

  el.innerHTML = html;
}

function updateNotifDot() {
  const dot = document.getElementById('notif-dot');
  const unseen = [
    ...notifications.filter(n => !n.seen),
    ...notifHistory.filter(n => !n.seen)
  ];
  if (dot) dot.style.display = unseen.length > 0 ? 'block' : 'none';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('es-ES', { weekday:'short', day:'numeric', month:'short' });
}

// Auto-refresh TMDB data every 6h while page is open
setInterval(() => { if (settings.apiKey) refreshAll(); }, 6 * 60 * 60 * 1000);
// Initial refresh after 2s (let page load first)
setTimeout(() => { if (settings.apiKey) refreshAll(); }, 2000);

// ════════════════════════════════════════════════════════════════
// SMART SEASON COMPLETION
// ════════════════════════════════════════════════════════════════
async function handleSeasonComplete(m, seasonIdx) {
  const s = m.seasons[seasonIdx];
  const hasMore = seasonIdx < m.seasons.length - 1;
  const hasMoreConfirmed = m.continuation === 'confirmed' || m.continuation === 'airing';
  const isLastSeason = !hasMore;

  // Show completion dialog
  showSeasonCompleteDialog(m, seasonIdx, async (action) => {
    // action: 'complete_all' | 'next_season' | 'pause' | 'keep'
    if (action === 'complete_all') {
      m.status = 'completed';
    } else if (action === 'next_season') {
      // Move to next season, keep watching
      m.status = 'watching';
      if (hasMore) {
        // Switch active tab to next season
        activeSeasonTab[m.id] = seasonIdx + 1;
      }
    } else if (action === 'pause') {
      m.status = 'paused';
    }
    // 'keep' = do nothing to status

    m.rating = calcRating(m.type, m.rating, m.seasons);
    m.updatedAt = Date.now();
    saveData();
    render();
    // If detail is open, refresh it
    if (document.getElementById('detail-modal').classList.contains('open')) {
      openDetail(m.id);
    }
    await saveToSupabase(m);
  });
}

function showSeasonCompleteDialog(m, seasonIdx, callback) {
  const s = m.seasons[seasonIdx];
  const hasMore = seasonIdx < m.seasons.length - 1;
  const nextSeasonNum = (m.seasons[seasonIdx + 1]?.number) || (seasonIdx + 2);
  const contLabel = { confirmed: 'Continuación confirmada', airing: 'Ya en emisión', rumor: 'Rumor de continuación', no: 'Sin continuación', unknown: '' };

  // Remove existing dialog if any
  document.getElementById('season-complete-dialog')?.remove();

  const div = document.createElement('div');
  div.id = 'season-complete-dialog';
  div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:300;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(4px)';

  const poster = getCardPoster(m);
  const posterHTML = poster ? `<img src="${poster}" style="width:60px;height:90px;object-fit:cover;border-radius:8px;flex-shrink:0" alt="">` : `<div style="width:60px;height:90px;background:var(--surface-3);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">${TYPE_EMOJI[m.type]}</div>`;

  div.innerHTML = `<div style="background:var(--surface-2);border:1px solid var(--border-strong);border-radius:16px;padding:1.5rem;max-width:380px;width:100%">
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:1rem">
      ${posterHTML}
      <div>
        <div style="font-size:11px;color:var(--success);font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">✓ Temporada completada</div>
        <div style="font-size:16px;font-weight:700">${m.title}</div>
        <div style="font-size:12px;color:var(--text-muted)">Temporada ${s.number || seasonIdx+1} — ${s.epSeen} episodios</div>
        ${m.continuation && m.continuation !== 'unknown' ? `<div style="font-size:11px;color:var(--anime-text);margin-top:3px">${contLabel[m.continuation]||''}</div>` : ''}
      </div>
    </div>
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:1rem">¿Qué quieres hacer?</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${hasMore ? `<button class="scd-btn" onclick="scdAction('next_season')" style="background:var(--accent-bg);border-color:var(--accent);color:var(--accent-text)"><i class="ti ti-player-skip-forward"></i> Pasar a la Temporada ${nextSeasonNum}</button>` : ''}
      <button class="scd-btn" onclick="scdAction('complete_all')" style="background:var(--success-bg);border-color:var(--success);color:var(--success-text)"><i class="ti ti-circle-check"></i> Marcar ${hasMore ? 'todo' : 'como'} completada</button>
      <button class="scd-btn" onclick="scdAction('pause')" style="background:var(--warning-bg);border-color:var(--warning);color:var(--warning-text)"><i class="ti ti-player-pause"></i> Poner en pausa (esperando siguiente)</button>
      <button class="scd-btn" onclick="scdAction('keep')" style="background:var(--surface-3);border-color:var(--border);color:var(--text-secondary)"><i class="ti ti-x"></i> Cerrar</button>
    </div>
  </div>`;

  document.body.appendChild(div);
  div.addEventListener('click', e => { if (e.target === div) { div.remove(); callback('keep'); } });
  window._scdCallback = callback;
}

function scdAction(action) {
  document.getElementById('season-complete-dialog')?.remove();
  if (window._scdCallback) window._scdCallback(action);
}

// ════════════════════════════════════════════════════════════════
// BROWSER NOTIFICATIONS
// ════════════════════════════════════════════════════════════════
async function requestNotifPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
}

async function sendBrowserNotif(title, body, icon) {
  const ok = await requestNotifPermission();
  if (!ok) return;
  new Notification(title, { body, icon: icon || '/favicon.ico', badge: '/favicon.ico' });
}

// Browser notifs are sent inline in buildNotifications

// ════════════════════════════════════════════════════════════════
// STATISTICS PAGE
// ════════════════════════════════════════════════════════════════
function openStats() {
  document.getElementById('stats-modal').classList.add('open');
  renderStats_full();
}
function closeStats() { document.getElementById('stats-modal').classList.remove('open'); }
function closeStatsBg(e) { if (e.target.id === 'stats-modal') closeStats(); }

function renderStats_full() {
  const all = mediaList;
  if (all.length === 0) {
    document.getElementById('stats-content').innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem">Añade títulos para ver estadísticas.</p>';
    return;
  }

  // Total episodes & estimated hours (avg 23 min anime, 45 min series, 120 min movies)
  const totalEpAll = all.reduce((a,m) => a + totalEpSeen(m), 0);
  const estMinutes = all.reduce((a,m) => {
    const ep = totalEpSeen(m);
    const mins = m.type === 'movie' ? 120 : m.type === 'anime' ? 23 : 44;
    return a + ep * mins;
  }, 0);
  const hours = Math.floor(estMinutes / 60);
  const days  = Math.floor(hours / 24);

  // Genre breakdown
  const genreCount = {};
  all.forEach(m => {
    (m.genre||'').split(',').forEach(g => {
      const gt = g.trim();
      if (gt) genreCount[gt] = (genreCount[gt]||0) + 1;
    });
  });
  const topGenres = Object.entries(genreCount).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // Ratings
  const rated = all.filter(m => parseFloat(m.rating) > 0);
  const avgRating = rated.length ? (rated.reduce((a,m)=>a+(parseFloat(m.rating)||0),0)/rated.length).toFixed(1) : '—';
  const topRated  = [...all].filter(m=>m.rating).sort((a,b)=>(parseFloat(b.rating)||0)-(parseFloat(a.rating)||0)).slice(0,3);

  // By type
  const byType = { series: all.filter(m=>m.type==='series').length, anime: all.filter(m=>m.type==='anime').length, movie: all.filter(m=>m.type==='movie').length };

  // Completion rate
  const completed = all.filter(m=>m.status==='completed').length;
  const compRate  = all.length ? Math.round(completed/all.length*100) : 0;

  const statCard = (icon, label, value, color='var(--text-primary)') =>
    `<div class="stat-card"><i class="ti ${icon}" style="color:${color};font-size:22px;margin-bottom:6px"></i><div class="stat-card-val" style="color:${color}">${value}</div><div class="stat-card-label">${label}</div></div>`;

  const genreBar = topGenres.map(([g,n]) => {
    const pct = Math.round(n/all.length*100);
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${g}</span><span style="color:var(--text-muted)">${n}</span></div>
      <div class="progress-bar"><div class="progress-fill fill-watching" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');

  const topRatedHTML = topRated.map(m => {
    const poster = getCardPoster(m);
    return `<div style="display:flex;gap:10px;align-items:center;padding:8px;background:var(--surface-3);border-radius:var(--radius);margin-bottom:6px">
      ${poster ? `<img src="${poster}" style="width:36px;height:52px;object-fit:cover;border-radius:6px;flex-shrink:0" alt="">` : `<div style="width:36px;height:52px;background:var(--surface-2);border-radius:6px;display:flex;align-items:center;justify-content:center">${TYPE_EMOJI[m.type]}</div>`}
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${m.title}</div><div style="font-size:11px;color:var(--text-muted)">${TYPE_LABELS[m.type]}</div></div>
      <div style="font-size:16px;font-weight:700;color:var(--warning-text)">★ ${m.rating}</div>
    </div>`;
  }).join('');

  document.getElementById('stats-content').innerHTML = `
    <div class="stats-grid">
      ${statCard('ti-list-numbers', 'Episodios vistos', totalEpAll, 'var(--accent-text)')}
      ${statCard('ti-clock', 'Horas estimadas', hours + 'h', 'var(--anime-text)')}
      ${statCard('ti-calendar', 'Días de contenido', days + 'd', 'var(--success)')}
      ${statCard('ti-star', 'Nota media', avgRating, 'var(--warning-text)')}
      ${statCard('ti-circle-check', 'Completadas', compRate + '%', 'var(--success)')}
      ${statCard('ti-library', 'Total títulos', all.length, 'var(--text-primary)')}
    </div>

    <div class="stats-row">
      <div class="stats-section">
        <div class="stats-section-title">Por tipo</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <div class="type-pill" style="background:var(--accent-bg);color:var(--accent-text)">📺 ${byType.series} series</div>
          <div class="type-pill" style="background:var(--anime-bg);color:var(--anime-text)">⛩️ ${byType.anime} animes</div>
          <div class="type-pill" style="background:var(--warning-bg);color:var(--warning-text)">🎬 ${byType.movie} películas</div>
        </div>
      </div>
    </div>

    <div class="stats-row">
      <div class="stats-section" style="flex:1">
        <div class="stats-section-title">Géneros favoritos</div>
        ${genreBar || '<p style="font-size:12px;color:var(--text-muted)">Sin datos de género</p>'}
      </div>
      <div class="stats-section" style="flex:1">
        <div class="stats-section-title">Mejor valoradas</div>
        ${topRatedHTML || '<p style="font-size:12px;color:var(--text-muted)">Sin puntuaciones</p>'}
      </div>
    </div>
  `;
}
