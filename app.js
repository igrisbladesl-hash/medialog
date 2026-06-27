// ── STATE ──────────────────────────────────────────────────────────────────
let mediaList = JSON.parse(localStorage.getItem('medialog_v3') || '[]');
let settings  = JSON.parse(localStorage.getItem('medialog_settings') || '{"apiKey":"","lang":"es-ES"}');
let editingId = null;
let currentSection = 'all';
let currentFilter  = null;
let currentSearch  = '';

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const STATUS_LABELS = {
  watching: 'Viendo', completed: 'Completada',
  pending: 'Pendiente', paused: 'En pausa', dropped: 'Abandonada'
};
const S2_LABELS = {
  unknown: '', no: 'Sin S2', leaked: 'S2 filtrada',
  confirmed: 'S2 confirmada', airing: 'Ya en emisión'
};
const TYPE_LABELS  = { series: 'Serie', anime: 'Anime', movie: 'Película' };
const TYPE_EMOJI   = { series: '📺', anime: '⛩️', movie: '🎬' };
const TMDB_IMAGE   = 'https://image.tmdb.org/t/p/w342';
const TMDB_BIG     = 'https://image.tmdb.org/t/p/w780';

// ── PERSISTENCE ────────────────────────────────────────────────────────────
function saveData()     { localStorage.setItem('medialog_v3', JSON.stringify(mediaList)); }
function saveSettings() { localStorage.setItem('medialog_settings', JSON.stringify(settings)); }
function genId()        { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

// ── NAVIGATION ─────────────────────────────────────────────────────────────
function setSection(s) {
  currentSection = s;
  currentFilter  = null;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + s)?.classList.add('active');
  const titles = { all: 'Mi biblioteca', series: 'Series', movie: 'Películas', anime: 'Anime' };
  document.getElementById('section-title').textContent = titles[s] ?? 'Mi biblioteca';
  render();
}

function setFilter(f) {
  if (currentFilter === f) { currentFilter = null; setSection(currentSection); return; }
  currentFilter  = f;
  currentSection = 'all';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + f)?.classList.add('active');
  render();
}

function onSearch(q) { currentSearch = q; render(); }

// ── FILTERING & SORTING ────────────────────────────────────────────────────
function getFiltered() {
  let list = [...mediaList];
  if (currentSection !== 'all') list = list.filter(m => m.type === currentSection);
  if (currentFilter)            list = list.filter(m => m.status === currentFilter);
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    list = list.filter(m =>
      m.title.toLowerCase().includes(q) ||
      (m.genre || '').toLowerCase().includes(q)
    );
  }
  const sort = document.getElementById('sort-select')?.value ?? 'recent';
  if (sort === 'title')    list.sort((a,b) => a.title.localeCompare(b.title));
  if (sort === 'rating')   list.sort((a,b) => (parseFloat(b.rating)||0) - (parseFloat(a.rating)||0));
  if (sort === 'progress') list.sort((a,b) => progress(b) - progress(a));
  return list;
}

function progress(m) {
  const seen = parseInt(m.epSeen) || 0;
  const tot  = parseInt(m.epTotal) || 0;
  return tot > 0 ? seen / tot : 0;
}

// ── TAGS ───────────────────────────────────────────────────────────────────
function statusTag(s) {
  const map = { watching:'tag-watching', completed:'tag-completed', pending:'tag-pending', paused:'tag-paused', dropped:'tag-dropped' };
  return `<span class="tag ${map[s]??'tag-pending'}">${STATUS_LABELS[s]??s}</span>`;
}

function s2Tag(s2) {
  if (!s2 || s2 === 'unknown') return '';
  const map = { no:'tag-s2-no', leaked:'tag-s2-leak', confirmed:'tag-s2-confirmed', airing:'tag-s2-airing' };
  return `<span class="tag ${map[s2]??''}">${S2_LABELS[s2]}</span>`;
}

function typeCorner(m) {
  if (m.type === 'anime')  return `<span class="card-corner" style="background:var(--anime-color);color:white">Anime</span>`;
  if (m.type === 'movie')  return `<span class="card-corner" style="background:var(--warning);color:#111">Película</span>`;
  if (m.season)            return `<span class="card-corner" style="background:rgba(0,0,0,0.6)">T${m.season}</span>`;
  return '';
}

// ── RENDER CARD ─────────────────────────────────────────────────────────────
function renderCard(m) {
  const epSeen  = parseInt(m.epSeen)  || 0;
  const epTotal = parseInt(m.epTotal) || 0;
  const pct     = epTotal > 0 ? Math.round((epSeen / epTotal) * 100) : 0;
  const isAnime = m.type === 'anime';
  const fillCls = m.status === 'completed' ? 'fill-completed' : (isAnime ? 'fill-anime' : 'fill-watching');

  const posterHTML = m.poster
    ? `<img src="${m.poster}" alt="${m.title}" loading="lazy" onerror="this.parentElement.innerHTML=fallbackPoster('${m.type}')">`
    : `<div class="card-poster-placeholder" style="background:${isAnime?'var(--anime-bg)':'var(--accent-bg)'}">
         <span>${TYPE_EMOJI[m.type]}</span>
         <span>${m.title.slice(0,18)}</span>
       </div>`;

  const progressHTML = (m.type !== 'movie' && epTotal > 0) ? `
    <div class="progress-wrap">
      <div class="progress-label"><span>${epSeen}/${epTotal} ep</span><span>${pct}%</span></div>
      <div class="progress-bar"><div class="progress-fill ${fillCls}" style="width:${pct}%"></div></div>
    </div>` : '';

  return `<div class="card" onclick="openDetail('${m.id}')" role="button" tabindex="0" aria-label="${m.title}">
    <div class="card-poster">
      ${posterHTML}
      <div class="card-poster-overlay"></div>
      ${typeCorner(m)}
      ${m.rating ? `<span class="card-rating">★ ${m.rating}</span>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title">${m.title}</div>
      <div class="card-meta">${[m.year, m.genre].filter(Boolean).join(' · ')}</div>
      <div class="card-tags">${statusTag(m.status)}${s2Tag(m.s2)}</div>
      ${progressHTML}
    </div>
  </div>`;
}

function fallbackPoster(type) {
  return `<div class="card-poster-placeholder"><span>${TYPE_EMOJI[type]}</span></div>`;
}

// ── RENDER BADGES & STATS ──────────────────────────────────────────────────
function renderStats() {
  const all  = mediaList;
  const cnt  = key => all.filter(m => m[key[0]] === key[1]).length;

  const badges = {
    all: all.length,
    series:    all.filter(m => m.type === 'series').length,
    movie:     all.filter(m => m.type === 'movie').length,
    anime:     all.filter(m => m.type === 'anime').length,
    watching:  all.filter(m => m.status === 'watching').length,
    completed: all.filter(m => m.status === 'completed').length,
    pending:   all.filter(m => m.status === 'pending').length,
    paused:    all.filter(m => m.status === 'paused').length,
  };
  Object.entries(badges).forEach(([k,v]) => {
    const el = document.getElementById('badge-' + k);
    if (el) el.textContent = v;
  });

  const totalEp  = all.reduce((a,m) => a + (parseInt(m.epSeen)||0), 0);
  const s2conf   = all.filter(m => m.s2 === 'confirmed' || m.s2 === 'airing').length;
  const s2leak   = all.filter(m => m.s2 === 'leaked').length;
  const dropped  = all.filter(m => m.status === 'dropped').length;

  document.getElementById('stats-bar').innerHTML = [
    `<div class="stat-pill"><i class="ti ti-player-play s-accent"></i><b>${badges.watching}</b> viendo</div>`,
    `<div class="stat-pill"><i class="ti ti-circle-check s-green"></i><b>${badges.completed}</b> completadas</div>`,
    `<div class="stat-pill"><i class="ti ti-list-numbers s-accent"></i><b>${totalEp}</b> episodios</div>`,
    s2conf  ? `<div class="stat-pill"><i class="ti ti-check s-green"></i><b>${s2conf}</b> S2 confirmada</div>` : '',
    s2leak  ? `<div class="stat-pill"><i class="ti ti-eye s-pro"></i><b>${s2leak}</b> S2 filtrada</div>` : '',
    dropped ? `<div class="stat-pill"><i class="ti ti-x s-danger"></i><b>${dropped}</b> abandonadas</div>` : '',
  ].join('');
}

// ── MAIN RENDER ────────────────────────────────────────────────────────────
function render() {
  const list  = getFiltered();
  const grid  = document.getElementById('media-grid');
  const empty = document.getElementById('empty-state');

  if (list.length === 0) {
    grid.innerHTML  = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = list.map(renderCard).join('');
  }
  renderStats();
}

// ── TMDB SEARCH ─────────────────────────────────────────────────────────────
async function searchTMDB() {
  const query = document.getElementById('tmdb-query').value.trim();
  if (!query) return;
  if (!settings.apiKey) {
    alert('Para buscar imágenes y datos necesitas una API Key de TMDB.\n\nVe a Ajustes (sidebar) para introducirla.\nEs gratis en themoviedb.org/settings/api');
    return;
  }
  const btn = document.getElementById('tmdb-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Buscando...';
  document.getElementById('tmdb-results').innerHTML = '';

  try {
    const type = document.getElementById('f-type').value;
    const mediaType = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/search/${mediaType}?api_key=${settings.apiKey}&query=${encodeURIComponent(query)}&language=${settings.lang}&page=1`;
    const res  = await fetch(url);
    const data = await res.json();

    if (data.results && data.results.length > 0) {
      const resultsEl = document.getElementById('tmdb-results');
      resultsEl.innerHTML = data.results.slice(0, 12).map(r => {
        const title = r.title || r.name || '';
        const year  = (r.release_date || r.first_air_date || '').slice(0,4);
        const img   = r.poster_path ? `<img src="${TMDB_IMAGE}${r.poster_path}" alt="${title}" loading="lazy">` : `<div class="tmdb-result-no-img">${TYPE_EMOJI[type]}</div>`;
        const backdropPath = r.backdrop_path ? `${TMDB_BIG}${r.backdrop_path}` : '';
        const posterPath   = r.poster_path   ? `${TMDB_IMAGE}${r.poster_path}` : '';
        const genres = (r.genre_ids || []).join(',');
        return `<div class="tmdb-result" onclick="selectTMDB(${JSON.stringify({
          id: r.id,
          title, year,
          poster: posterPath,
          backdrop: backdropPath,
          overview: r.overview || '',
          genres,
          mediaType,
        }).replace(/"/g,'&quot;')})">
          ${img}
          <div class="tmdb-result-title">${title} ${year ? `(${year})` : ''}</div>
        </div>`;
      }).join('');
    } else {
      document.getElementById('tmdb-results').innerHTML = '<p style="font-size:12px;color:var(--text-muted);padding:8px 0;">Sin resultados. Prueba con otro nombre.</p>';
    }
  } catch(e) {
    document.getElementById('tmdb-results').innerHTML = '<p style="font-size:12px;color:var(--danger);padding:8px 0;">Error al conectar con TMDB. Revisa tu API key.</p>';
  }

  btn.disabled = false;
  btn.innerHTML = '<i class="ti ti-search"></i> Buscar';
}

async function selectTMDB(data) {
  document.getElementById('f-title').value   = data.title;
  document.getElementById('f-year').value    = data.year;
  document.getElementById('f-poster').value  = data.poster;
  document.getElementById('f-backdrop').value = data.backdrop;
  document.getElementById('f-tmdb-id').value = data.id;

  updatePosterPreview(data.poster);

  // Fetch details for genre names and episode count
  if (settings.apiKey) {
    try {
      const url = `https://api.themoviedb.org/3/${data.mediaType}/${data.id}?api_key=${settings.apiKey}&language=${settings.lang}`;
      const res  = await fetch(url);
      const det  = await res.json();

      // Genre
      if (det.genres && det.genres.length > 0) {
        document.getElementById('f-genre').value = det.genres.slice(0,2).map(g=>g.name).join(', ');
      }
      // Episode info
      if (data.mediaType === 'tv') {
        if (det.number_of_episodes) document.getElementById('f-ep-total').value   = det.number_of_episodes;
        if (det.number_of_seasons)  document.getElementById('f-seasons-total').value = det.number_of_seasons;
        if (det.in_production === false && det.status !== 'Returning Series') {
          document.getElementById('f-s2').value = 'no';
        } else if (det.next_episode_to_air) {
          document.getElementById('f-s2').value = 'airing';
        }
      }
      // Notes with overview
      if (det.overview && !document.getElementById('f-notes').value) {
        document.getElementById('f-notes').value = det.overview.slice(0, 200) + (det.overview.length > 200 ? '...' : '');
      }
    } catch(e) {}
  }

  // Highlight selected
  document.querySelectorAll('.tmdb-result').forEach(el => el.style.borderColor = 'transparent');
  event.currentTarget.style.borderColor = 'var(--accent)';
}

function updatePosterPreview(url) {
  const prev = document.getElementById('poster-preview');
  if (url) {
    prev.innerHTML = `<img src="${url}" alt="Póster" onerror="this.parentElement.innerHTML='<i class=\\'ti ti-photo\\'></i>'">`;
  } else {
    prev.innerHTML = `<i class="ti ti-photo"></i>`;
  }
}

// ── MODAL ─────────────────────────────────────────────────────────────────
function openModal(id) {
  editingId = id || null;
  const m = id ? mediaList.find(x => x.id === id) : null;
  document.getElementById('modal-title').textContent = m ? 'Editar título' : 'Añadir título';
  document.getElementById('f-type').value         = m ? m.type  : 'series';
  document.getElementById('f-title').value        = m ? m.title : '';
  document.getElementById('f-year').value         = m ? (m.year  || '') : '';
  document.getElementById('f-genre').value        = m ? (m.genre || '') : '';
  document.getElementById('f-poster').value       = m ? (m.poster  || '') : '';
  document.getElementById('f-backdrop').value     = m ? (m.backdrop || '') : '';
  document.getElementById('f-tmdb-id').value      = m ? (m.tmdbId  || '') : '';
  document.getElementById('f-status').value       = m ? m.status : 'watching';
  document.getElementById('f-rating').value       = m ? (m.rating   || '') : '';
  document.getElementById('f-ep-seen').value      = m ? (m.epSeen   || '') : '';
  document.getElementById('f-ep-total').value     = m ? (m.epTotal  || '') : '';
  document.getElementById('f-season').value       = m ? (m.season   || '') : '';
  document.getElementById('f-seasons-total').value = m ? (m.seasonsTotal || '') : '';
  document.getElementById('f-s2').value           = m ? (m.s2 || 'unknown') : 'unknown';
  document.getElementById('f-notes').value        = m ? (m.notes    || '') : '';
  document.getElementById('tmdb-query').value     = '';
  document.getElementById('tmdb-results').innerHTML = '';
  updatePosterPreview(m?.poster || '');
  updateModalFields();
  document.getElementById('add-modal').classList.add('open');
}

function updateModalFields() {
  const type = document.getElementById('f-type').value;
  document.getElementById('ep-fields').style.display = type === 'movie' ? 'none' : 'block';
}

function closeModal()      { document.getElementById('add-modal').classList.remove('open'); }
function closeModalBg(e)   { if (e.target.id === 'add-modal') closeModal(); }

function saveMedia() {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { alert('El título es obligatorio'); return; }
  const type    = document.getElementById('f-type').value;
  const isMovie = type === 'movie';
  const entry = {
    id:           editingId || genId(),
    type,
    title,
    year:         document.getElementById('f-year').value,
    genre:        document.getElementById('f-genre').value.trim(),
    poster:       document.getElementById('f-poster').value.trim(),
    backdrop:     document.getElementById('f-backdrop').value.trim(),
    tmdbId:       document.getElementById('f-tmdb-id').value,
    status:       document.getElementById('f-status').value,
    rating:       document.getElementById('f-rating').value,
    epSeen:       isMovie ? 0 : (parseInt(document.getElementById('f-ep-seen').value)  || 0),
    epTotal:      isMovie ? 0 : (parseInt(document.getElementById('f-ep-total').value) || 0),
    season:       isMovie ? 0 : (parseInt(document.getElementById('f-season').value)   || 1),
    seasonsTotal: isMovie ? 0 : (parseInt(document.getElementById('f-seasons-total').value) || 1),
    s2:           isMovie ? 'no' : document.getElementById('f-s2').value,
    notes:        document.getElementById('f-notes').value.trim(),
    updatedAt:    Date.now(),
  };

  if (editingId) {
    const idx = mediaList.findIndex(x => x.id === editingId);
    if (idx >= 0) mediaList[idx] = entry; else mediaList.unshift(entry);
  } else {
    mediaList.unshift(entry);
  }
  saveData();
  closeModal();
  render();
}

// ── DETAIL ────────────────────────────────────────────────────────────────
function openDetail(id) {
  const m = mediaList.find(x => x.id === id);
  if (!m) return;

  const epSeen  = parseInt(m.epSeen)  || 0;
  const epTotal = parseInt(m.epTotal) || 0;
  const pct     = epTotal > 0 ? Math.round((epSeen / epTotal) * 100) : 0;
  const isAnime = m.type === 'anime';
  const fillCls = m.status === 'completed' ? 'fill-completed' : (isAnime ? 'fill-anime' : 'fill-watching');
  const emoji   = TYPE_EMOJI[m.type];

  // Backdrop
  const backdropEl = document.getElementById('detail-backdrop');
  if (m.backdrop) {
    backdropEl.style.backgroundImage = `url(${m.backdrop})`;
    backdropEl.style.opacity = '1';
  } else {
    backdropEl.style.backgroundImage = 'none';
  }

  // Poster
  const posterHTML = m.poster
    ? `<img src="${m.poster}" alt="${m.title}">`
    : `<div class="detail-poster-placeholder">${emoji}</div>`;

  document.getElementById('detail-header').innerHTML = `
    <div class="detail-poster">${posterHTML}</div>
    <div class="detail-info">
      <h2>${m.title}</h2>
      <div class="meta">${[TYPE_LABELS[m.type], m.year, m.genre].filter(Boolean).join(' · ')}</div>
      <div class="card-tags">
        ${statusTag(m.status)}
        ${s2Tag(m.s2)}
        ${m.rating ? `<span class="tag" style="background:var(--warning-bg);color:var(--warning-text)">★ ${m.rating}</span>` : ''}
      </div>
    </div>`;

  let epSection = '';
  if (m.type !== 'movie') {
    epSection = `
      <div class="ep-control">
        <button class="ep-btn" onclick="changeEp('${m.id}',-1)" aria-label="Menos episodio">−</button>
        <span class="ep-count">${epSeen}</span>
        <span class="ep-total">/ ${epTotal||'?'} ep</span>
        <button class="ep-btn" onclick="changeEp('${m.id}',1)" aria-label="Más episodio">+</button>
      </div>
      ${epTotal > 0 ? `<div class="progress-bar" style="height:5px;margin-bottom:12px"><div class="progress-fill ${fillCls}" style="width:${pct}%"></div></div>` : ''}
      <div class="detail-stats">
        <div class="detail-stat"><div class="dl">Temporada</div><div class="dv">T${m.season||1} / ${m.seasonsTotal||'?'}</div></div>
        <div class="detail-stat"><div class="dl">Progreso</div><div class="dv">${pct}%</div></div>
        <div class="detail-stat"><div class="dl">Episodios</div><div class="dv">${epSeen}/${epTotal||'?'}</div></div>
      </div>`;
  }

  document.getElementById('detail-body').innerHTML = `
    ${epSection}
    ${m.notes ? `<div class="detail-notes">${m.notes}</div>` : ''}
    <div class="detail-actions">
      <button class="btn" onclick="closeDetail();openModal('${m.id}')"><i class="ti ti-edit"></i> Editar</button>
      <button class="btn btn-danger" onclick="deleteMedia('${m.id}')"><i class="ti ti-trash"></i> Eliminar</button>
    </div>`;

  document.getElementById('detail-modal').classList.add('open');
}

function changeEp(id, delta) {
  const m = mediaList.find(x => x.id === id);
  if (!m) return;
  m.epSeen = Math.max(0, (parseInt(m.epSeen)||0) + delta);
  if (m.epTotal > 0 && m.epSeen >= m.epTotal) m.status = 'completed';
  m.updatedAt = Date.now();
  saveData();
  render();
  openDetail(id);
}

function deleteMedia(id) {
  if (!confirm('¿Eliminar este título de tu biblioteca?')) return;
  mediaList = mediaList.filter(x => x.id !== id);
  saveData();
  closeDetail();
  render();
}

function closeDetail()    { document.getElementById('detail-modal').classList.remove('open'); }
function closeDetailBg(e) { if (e.target.id === 'detail-modal') closeDetail(); }

// ── SETTINGS ──────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('s-apikey').value = settings.apiKey || '';
  document.getElementById('s-lang').value   = settings.lang   || 'es-ES';
  document.getElementById('settings-modal').classList.add('open');
}
function closeSettings() { document.getElementById('settings-modal').classList.remove('open'); }
function closeSettingsBg(e) { if (e.target.id === 'settings-modal') closeSettings(); }
function saveSettings() {
  settings.apiKey = document.getElementById('s-apikey').value.trim();
  settings.lang   = document.getElementById('s-lang').value;
  localStorage.setItem('medialog_settings', JSON.stringify(settings));
  closeSettings();
  alert('Ajustes guardados ✓');
}

// Update poster preview on URL input
document.getElementById('f-poster')?.addEventListener('input', e => updatePosterPreview(e.target.value));

// ── EXPORT / IMPORT ────────────────────────────────────────────────────────
function exportData() {
  const blob = new Blob([JSON.stringify(mediaList, null, 2)], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `medialog_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}

function importData(event) {
  const file   = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error('Formato inválido');
      const merge = confirm(`Se encontraron ${data.length} títulos.\n¿Fusionar con tu biblioteca actual?\n\nSí = Fusionar\nNo = Reemplazar todo`);
      if (merge) {
        const ids = new Set(mediaList.map(m => m.id));
        data.forEach(m => { if (!ids.has(m.id)) mediaList.push(m); });
      } else {
        mediaList = data;
      }
      saveData();
      render();
      alert(`Importación completada. ${mediaList.length} títulos en tu biblioteca.`);
    } catch(err) {
      alert('Error al importar: el archivo no es válido.');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// CSS animation for spinner
const style = document.createElement('style');
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);

// ── INIT ───────────────────────────────────────────────────────────────────
render();
