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
  if (sort === 'title')  list.sort((a,b) => a.title.localeCompare(b.title));
  if (sort === 'rating') list.sort((a,b) => (parseFloat(b.rating)||0) - (parseFloat(a.rating)||0));
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
    <div class="field"><label>Puntuación (0–10)</label><input type="number" id="s${idx}-rating" min="0" max="10" step="0.5" value="${s.rating||''}"></div>
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
  const type = document.getElementById('f-type').value;
  const mediaType = type === 'movie' ? 'movie' : 'tv';
  try {
    const res  = await fetch(`https://api.themoviedb.org/3/search/${mediaType}?api_key=${settings.apiKey}&query=${encodeURIComponent(query)}&language=${settings.lang}`);
    const data = await res.json();
    if (data.results?.length > 0) {
      document.getElementById('tmdb-results').innerHTML = data.results.slice(0,12).map(r => {
        const title = r.title||r.name||'';
        const year  = (r.release_date||r.first_air_date||'').slice(0,4);
        const img   = r.poster_path ? `<img src="${TMDB_IMG}${r.poster_path}" alt="${title}" loading="lazy">` : `<div class="tmdb-result-no-img">${TYPE_EMOJI[type]}</div>`;
        const d = JSON.stringify({id:r.id, title, year, poster:r.poster_path?`${TMDB_IMG}${r.poster_path}`:'', backdrop:r.backdrop_path?`${TMDB_BIG}${r.backdrop_path}`:'', mediaType}).replace(/"/g,'&quot;');
        return `<div class="tmdb-result" onclick="selectTMDB(${d}, this)">${img}<div class="tmdb-result-title">${title} ${year?`(${year})`:''}</div></div>`;
      }).join('');
    } else {
      document.getElementById('tmdb-results').innerHTML = '<p style="font-size:12px;color:var(--text-muted);padding:8px 0;">Sin resultados.</p>';
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
  // For movies, set poster immediately from search result
  if (data.mediaType === 'movie' && data.poster) {
    document.getElementById('f-movie-poster').value = data.poster;
    updateMiniPoster('movie', data.poster);
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
  s.epSeen = Math.min(maxEp, Math.max(0, (parseInt(s.epSeen)||0) + delta));
  const allDone = m.seasons.every(s => s.epTotal > 0 && s.epSeen >= s.epTotal);
  if (allDone) m.status = 'completed';
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
      <button class="qbtn" onclick="event.stopPropagation();quickEp('${m.id}',${qSeasonIdx},-1)">−</button>
      <span class="qep-label">T${(qSeason.number||qSeasonIdx+1)} · ${qEpSeen}/${qEpTotal||'?'}</span>
      <button class="qbtn" onclick="event.stopPropagation();quickEp('${m.id}',${qSeasonIdx},1)">+</button>
    </div>` : '';

  const quickRating = `
    <div class="qrating">
      <button class="qrating-btn" onclick="event.stopPropagation();quickRating('${m.id}',-0.5)">−</button>
      <span class="qrating-val">${qRating||'—'}</span>
      <button class="qrating-btn" onclick="event.stopPropagation();quickRating('${m.id}',0.5)">+</button>
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

async function quickEp(id, seasonIdx, delta) {
  const m = mediaList.find(x => x.id === id);
  if (!m || !m.seasons?.[seasonIdx]) return;
  const s = m.seasons[seasonIdx];
  const maxEp = parseInt(s.epTotal) || Infinity;
  s.epSeen = Math.min(maxEp, Math.max(0, (parseInt(s.epSeen)||0) + delta));
  const allDone = m.seasons.every(s => s.epTotal > 0 && s.epSeen >= s.epTotal);
  if (allDone) m.status = 'completed';
  m.rating = calcRating(m.type, m.rating, m.seasons);
  m.updatedAt = Date.now();
  saveData();
  render();
  await saveToSupabase(m);
}

async function quickRating(id, delta) {
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
  panelOpen = 'notif';
  document.getElementById('notif-panel').style.display = 'flex';
  renderNotifications();
  refreshAll();
}

function toggleCalendar() {
  if (panelOpen === 'calendar') { closePanel(); return; }
  closePanel();
  panelOpen = 'calendar';
  document.getElementById('calendar-panel').style.display = 'flex';
  renderCalendar();
  refreshAll();
}

function closePanel() {
  document.getElementById('notif-panel').style.display = 'none';
  document.getElementById('calendar-panel').style.display = 'none';
  panelOpen = null;
}

async function refreshAll() {
  if (!settings.apiKey) return;
  const watching = mediaList.filter(m => m.tmdbId && m.tmdbType === 'tv' && m.status !== 'dropped');
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
      id:       m.tmdbId,
      mediaId:  m.id,
      title:    m.title,
      poster:   getCardPoster(m),
      status:   det.status,
      nextEp:   det.next_episode_to_air || null,
      lastEp:   det.last_episode_to_air || null,
      inProd:   det.in_production,
      updated:  Date.now(),
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

function buildNotifications() {
  const newNotifs = [];
  const today = new Date().toISOString().slice(0, 10);
  const seenIds = new Set(notifications.filter(n => n.seen).map(n => n.id));

  Object.values(tmdbCache).forEach(data => {
    // Episode airing today
    if (data.nextEp) {
      const airDate = data.nextEp.air_date;
      const nid = `ep-${data.id}-${data.nextEp.season_number}-${data.nextEp.episode_number}`;
      if (airDate === today) {
        newNotifs.push({
          id: nid, type: 'today', mediaId: data.mediaId, poster: data.poster,
          title: data.title,
          desc: `Episodio ${data.nextEp.episode_number} de T${data.nextEp.season_number} — hoy`,
          date: today, seen: seenIds.has(nid),
        });
      } else if (airDate > today) {
        newNotifs.push({
          id: nid, type: 'upcoming', mediaId: data.mediaId, poster: data.poster,
          title: data.title,
          desc: `Próximo ep ${data.nextEp.episode_number} T${data.nextEp.season_number} — ${formatDate(airDate)}`,
          date: airDate, seen: true,
        });
      }
    }
    // New season announced
    if (data.inProd && data.status !== 'Ended') {
      const nid = `s2-${data.id}`;
      newNotifs.push({
        id: nid, type: 'announced', mediaId: data.mediaId, poster: data.poster,
        title: data.title,
        desc: data.nextEp ? `Nueva temporada en producción` : `Continuación confirmada`,
        date: '', seen: seenIds.has(nid),
      });
    }
  });

  notifications = newNotifs.sort((a,b) => {
    const order = { today: 0, announced: 1, upcoming: 2 };
    return (order[a.type]||9) - (order[b.type]||9) || a.date.localeCompare(b.date);
  });
  localStorage.setItem('ml_notifs', JSON.stringify(notifications));
}

function buildCalendar() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const in30 = new Date(today.getTime() + 30*24*60*60*1000).toISOString().slice(0,10);
  calendarData = [];

  Object.values(tmdbCache).forEach(data => {
    if (data.nextEp && data.nextEp.air_date >= todayStr && data.nextEp.air_date <= in30) {
      calendarData.push({
        date: data.nextEp.air_date,
        mediaId: data.mediaId,
        poster: data.poster,
        title: data.title,
        season: data.nextEp.season_number,
        episode: data.nextEp.episode_number,
        epName: data.nextEp.name || '',
      });
    }
  });

  calendarData.sort((a,b) => a.date.localeCompare(b.date));
}

function renderNotifications() {
  const el = document.getElementById('notif-list');
  if (!el) return;

  const today   = notifications.filter(n => n.type === 'today');
  const announ  = notifications.filter(n => n.type === 'announced');
  const upcoming= notifications.filter(n => n.type === 'upcoming');

  if (notifications.length === 0) {
    el.innerHTML = `<div class="notif-empty"><i class="ti ti-bell-off"></i>Sin notificaciones.<br><small>Añade series con TMDB para ver actualizaciones.</small></div>`;
    return;
  }

  let html = '';
  if (today.length) {
    html += `<div class="notif-section-label">🟢 Hoy</div>`;
    html += today.map(n => notifItemHTML(n)).join('');
  }
  if (announ.length) {
    html += `<div class="notif-section-label">📢 Anunciadas</div>`;
    html += announ.map(n => notifItemHTML(n)).join('');
  }
  if (upcoming.length) {
    html += `<div class="notif-section-label">📅 Próximamente</div>`;
    html += upcoming.map(n => notifItemHTML(n)).join('');
  }
  el.innerHTML = html;

  // Mark all as seen
  notifications.forEach(n => n.seen = true);
  localStorage.setItem('ml_notifs', JSON.stringify(notifications));
  updateNotifDot();
}

function notifItemHTML(n) {
  const cls = n.type === 'today' ? 'notif-today' : n.type === 'announced' ? 'notif-announced' : '';
  const poster = n.poster ? `<img src="${n.poster}" alt="">` : `<div class="notif-poster-ph">📺</div>`;
  return `<div class="notif-item ${cls}" onclick="closePanel();openDetail('${n.mediaId}')">
    <div class="notif-poster">${poster}</div>
    <div class="notif-content">
      <div class="notif-title">${n.title}</div>
      <div class="notif-desc">${n.desc}</div>
    </div>
  </div>`;
}

function renderCalendar() {
  const el = document.getElementById('calendar-list');
  if (!el) return;

  if (calendarData.length === 0) {
    el.innerHTML = `<div class="notif-empty"><i class="ti ti-calendar-off"></i>Sin episodios próximos.<br><small>Solo aparecen series marcadas como "Viendo" con TMDB conectado.</small></div>`;
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const grouped  = {};
  calendarData.forEach(item => {
    if (!grouped[item.date]) grouped[item.date] = [];
    grouped[item.date].push(item);
  });

  let html = '';
  Object.entries(grouped).forEach(([date, items]) => {
    const isToday = date === todayStr;
    const label   = isToday ? '🟢 Hoy' : formatDate(date);
    html += `<div class="cal-day">
      <div class="cal-day-label ${isToday?'today':''}">${label}</div>
      ${items.map(item => {
        const poster = item.poster ? `<img src="${item.poster}" alt="">` : '';
        return `<div class="cal-item ${isToday?'today-ep':''}" onclick="closePanel();openDetail('${item.mediaId}')">
          <div class="cal-poster">${poster}</div>
          <div class="cal-info">
            <div class="cal-title">${item.title}</div>
            <div class="cal-ep">T${item.season} · Ep ${item.episode}${item.epName?' — '+item.epName:''}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  });
  el.innerHTML = html;
}

function updateNotifDot() {
  const dot  = document.getElementById('notif-dot');
  const unseen = notifications.filter(n => !n.seen && n.type === 'today');
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
