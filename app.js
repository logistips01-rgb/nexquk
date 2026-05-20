// ============================================================
// NEXQUK — Lógica principal
// PWA de control de vitrocerámica con recetas guiadas
// ============================================================

import { db, auth } from './firebase-config.js';
import {
  ref, set, onValue, remove, off
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import {
  signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// ============================================================
// CONSTANTES
// ============================================================

const ZONES = ['trasero', 'delantera_izq', 'delantera_der'];

const ZONE_LABELS = {
  trasero:       'Trasero',
  delantera_izq: 'Del. Izq.',
  delantera_der: 'Del. Der.'
};

// Color del fuego según nivel de potencia
function burnerColor(potencia, boost) {
  if (boost)         return { color: '#ff1a00', glow: 'rgba(255,26,0,.55)' };
  if (potencia >= 13) return { color: '#ff2200', glow: 'rgba(255,34,0,.45)' };
  if (potencia >= 8)  return { color: '#ff5500', glow: 'rgba(255,85,0,.4)'  };
  if (potencia >= 4)  return { color: '#ff8800', glow: 'rgba(255,136,0,.35)' };
  return                     { color: '#ffaa00', glow: 'rgba(255,170,0,.3)' };
}

// ============================================================
// ESTADO GLOBAL
// ============================================================

const state = {
  user:      null,
  deviceId:  null,
  isDemo:    false,

  burners: {
    trasero:       { activo: false, potencia: 0, boost: false },
    delantera_izq: { activo: false, potencia: 0, boost: false },
    delantera_der: { activo: false, potencia: 0, boost: false }
  },
  bloqueoInfantil: false,

  selectedZone: null,

  timerIntervals: { trasero: null, delantera_izq: null, delantera_der: null },
  timerSeconds:   { trasero: 0,    delantera_izq: 0,    delantera_der: 0    },

  cooking: {
    active:    false,
    recipe:    null,
    stepIndex: 0,
    paused:    false,
    timeLeft:  0,
    interval:  null
  },

  recipes:           [],
  editingRecipe:     null,
  editingSteps:      [],
  editingStepIndex:  null,   // null = nuevo paso
  timerModalZone:    null,
  currentView:       'control',
  fbUnsubscribers:   []
};

// ============================================================
// FIREBASE — SINCRONIZACIÓN
// ============================================================

function buildEstado() {
  return {
    fuegos: {
      trasero:       { ...state.burners.trasero },
      delantera_izq: { ...state.burners.delantera_izq },
      delantera_der: { ...state.burners.delantera_der }
    },
    bloqueo_infantil: state.bloqueoInfantil,
    ts: Date.now()
  };
}

function pushToFirebase() {
  if (state.isDemo || !state.deviceId) return;
  const path = `dispositivos/${state.deviceId}/estado`;
  set(ref(db, path), buildEstado()).catch(console.error);
}

function subscribeDevice() {
  if (state.isDemo || !state.deviceId) return;

  // Escuchar si el ESP32 cambia algo físicamente (ej. alguien toca la vitro)
  const estadoRef = ref(db, `dispositivos/${state.deviceId}/estado`);
  const unsub = onValue(estadoRef, snap => {
    const data = snap.val();
    if (!data || !data.fuegos) return;
    // Solo actualizamos UI si el cambio vino de fuera (ts más reciente que el nuestro)
    // Para v1 simplemente mantenemos la app como fuente de verdad
  });
  state.fbUnsubscribers.push(() => off(estadoRef, 'value', unsub));

  // Monitor de conexión
  const connRef = ref(db, '.info/connected');
  const connUnsub = onValue(connRef, snap => {
    setConnStatus(snap.val() === true ? 'online' : 'offline');
  });
  state.fbUnsubscribers.push(() => off(connRef, 'value', connUnsub));
}

function unsubscribeAll() {
  state.fbUnsubscribers.forEach(fn => fn());
  state.fbUnsubscribers = [];
}

function setConnStatus(status) {
  const dot = document.getElementById('conn-dot');
  if (dot) dot.className = 'conn-dot ' + status;
  const badge = document.getElementById('conn-badge');
  if (badge) {
    badge.textContent = { online: 'ONLINE', offline: 'OFFLINE', syncing: 'SYNC...' }[status] || status.toUpperCase();
    badge.className = 'conn-badge ' + status;
  }
}

// ============================================================
// FIREBASE — RECETAS CRUD
// ============================================================

function recipesPath() {
  return `recetas/${state.user.uid}`;
}

function subscribeRecipes() {
  if (state.isDemo) {
    state.recipes = sampleRecipes();
    renderRecipeList();
    return;
  }
  const rRef = ref(db, recipesPath());
  const unsub = onValue(rRef, snap => {
    const data = snap.val();
    state.recipes = data ? Object.values(data) : [];
    renderRecipeList();
  });
  state.fbUnsubscribers.push(() => off(rRef, 'value', unsub));
}

async function persistRecipe(recipe) {
  if (state.isDemo) {
    const idx = state.recipes.findIndex(r => r.id === recipe.id);
    if (idx >= 0) state.recipes[idx] = recipe;
    else state.recipes.push(recipe);
    renderRecipeList();
    return;
  }
  await set(ref(db, `${recipesPath()}/${recipe.id}`), recipe);
}

async function deleteRecipeById(id) {
  if (state.isDemo) {
    state.recipes = state.recipes.filter(r => r.id !== id);
    renderRecipeList();
    return;
  }
  await remove(ref(db, `${recipesPath()}/${id}`));
}

// ============================================================
// AUTH
// ============================================================

function initAuth() {
  onAuthStateChanged(auth, user => {
    if (user) {
      state.user    = user;
      state.isDemo  = false;
      loadDeviceId();
      showApp();
      subscribeDevice();
      subscribeRecipes();
    } else if (!state.isDemo) {
      showAuthScreen();
    }
  });
}

async function loginWithGoogle() {
  try {
    setAuthLoading(true);
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    showToast('Error al iniciar sesión');
    console.error(e);
  } finally {
    setAuthLoading(false);
  }
}

async function logout() {
  unsubscribeAll();
  state.user   = null;
  state.isDemo = false;
  closeModal('modal-user');
  await signOut(auth);
  showAuthScreen();
}

function enterDemoMode() {
  state.isDemo  = true;
  state.deviceId = 'demo';
  state.user    = { uid: 'demo', displayName: 'Demo', email: null };
  showApp();
  subscribeRecipes();
  showToast('Modo demo — los cambios no se guardan');
}

function setAuthLoading(loading) {
  const btn = document.getElementById('btn-google-login');
  btn.disabled = loading;
  btn.textContent = loading ? 'Conectando...' : 'Entrar con Google';
}

// ============================================================
// DEVICE ID
// ============================================================

function loadDeviceId() {
  const saved = localStorage.getItem('nexquk_device');
  if (saved) {
    state.deviceId = saved;
    document.getElementById('device-id-label').textContent = saved;
    document.getElementById('device-setup').style.display = 'none';
  } else {
    document.getElementById('device-setup').style.display = 'flex';
  }
}

function setDeviceId(id) {
  id = id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!id) return;
  state.deviceId = id;
  localStorage.setItem('nexquk_device', id);
  document.getElementById('device-id-label').textContent = id;
  document.getElementById('device-setup').style.display = 'none';
  unsubscribeAll();
  subscribeDevice();
  subscribeRecipes();
  showToast('Dispositivo: ' + id);
}

// ============================================================
// CONTROL DE FUEGOS
// ============================================================

function toggleBurner(zone) {
  if (state.bloqueoInfantil) return shakeZone(zone);
  const b = state.burners[zone];
  if (b.activo) {
    b.activo  = false;
    b.potencia = 0;
    b.boost   = false;
    clearBurnerTimer(zone);
  } else {
    b.activo  = true;
    b.potencia = b.potencia || 5;
  }
  updateBurnerUI(zone);
  pushToFirebase();
}

function setBurnerPower(zone, value) {
  if (state.bloqueoInfantil) return shakeZone(zone);
  value = parseInt(value, 10);
  const b = state.burners[zone];
  b.potencia = value;
  if (value === 0) { b.activo = false; b.boost = false; clearBurnerTimer(zone); }
  else               b.activo = true;
  updateBurnerUI(zone);
  pushToFirebase();
}

function toggleBoost(zone) {
  if (state.bloqueoInfantil) return shakeZone(zone);
  const b = state.burners[zone];
  b.boost = !b.boost;
  if (b.boost) { b.activo = true; b.potencia = 17; }
  updateBurnerUI(zone);
  pushToFirebase();
}

function allOff() {
  if (state.bloqueoInfantil) return showToast('Desactiva el bloqueo infantil primero');
  ZONES.forEach(z => {
    state.burners[z] = { activo: false, potencia: 0, boost: false };
    clearBurnerTimer(z);
  });
  state.selectedZone = null;
  ZONES.forEach(z => document.getElementById('z-' + z)?.classList.remove('selected'));
  document.getElementById('zcp-empty').style.display    = 'block';
  document.getElementById('zcp-controls').style.display = 'none';
  document.getElementById('zcp').classList.remove('has-selection');
  updateAllBurnersUI();
  pushToFirebase();
  showToast('Todo apagado');
}

function toggleChildLock() {
  state.bloqueoInfantil = !state.bloqueoInfantil;
  updateChildLockUI();
  pushToFirebase();
  showToast(state.bloqueoInfantil ? '🔒 Bloqueo infantil activado' : '🔓 Bloqueo desactivado');
}

function shakeZone(zone) {
  const el = document.getElementById('z-' + zone);
  if (!el) return;
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake .3s ease';
  setTimeout(() => el.style.animation = '', 350);
  showToast('🔒 Bloqueo infantil activo');
}

// ============================================================
// TIMERS POR ZONA
// ============================================================

function openTimerModal(zone) {
  state.timerModalZone = zone;
  const secs = state.timerSeconds[zone] || 0;
  document.getElementById('timer-modal-title').textContent = `Timer — ${ZONE_LABELS[zone]}`;
  document.getElementById('timer-min-input').value = Math.floor(secs / 60);
  document.getElementById('timer-sec-input').value = secs % 60;
  openModal('modal-timer');
}

function confirmTimer() {
  const m = parseInt(document.getElementById('timer-min-input').value, 10) || 0;
  const s = parseInt(document.getElementById('timer-sec-input').value, 10) || 0;
  setBurnerTimer(state.timerModalZone, m * 60 + s);
  closeModal('modal-timer');
}

function setBurnerTimer(zone, seconds) {
  clearBurnerTimer(zone);
  if (seconds <= 0) return;
  state.timerSeconds[zone] = seconds;
  updateTimerUI(zone);
  state.timerIntervals[zone] = setInterval(() => {
    state.timerSeconds[zone]--;
    updateTimerUI(zone);
    if (state.timerSeconds[zone] <= 0) {
      clearBurnerTimer(zone);
      state.burners[zone].activo  = false;
      state.burners[zone].potencia = 0;
      updateBurnerUI(zone);
      pushToFirebase();
      showToast(`⏱ Timer ${ZONE_LABELS[zone]}: apagado`);
    }
  }, 1000);
}

function clearBurnerTimer(zone) {
  clearInterval(state.timerIntervals[zone]);
  state.timerIntervals[zone] = null;
  state.timerSeconds[zone]   = 0;
  updateTimerUI(zone);
}

// ============================================================
// MOTOR DE COCCIÓN
// ============================================================

function startCooking(recipe) {
  if (!recipe.pasos?.length) return showToast('La receta no tiene pasos');
  state.cooking = {
    active:    true,
    recipe,
    stepIndex: 0,
    paused:    false,
    timeLeft:  recipe.pasos[0].duracion,
    interval:  null
  };
  applyStepBurners(recipe.pasos[0]);
  showView('cooking');
  updateCookingUI();
  tickCooking();
}

function applyStepBurners(step) {
  if (!step.fuegos) return;
  ZONES.forEach(z => {
    if (step.fuegos[z]) {
      state.burners[z] = { ...state.burners[z], ...step.fuegos[z] };
    }
  });
  updateAllBurnersUI();
  pushToFirebase();
}

function tickCooking() {
  if (state.cooking.interval) clearInterval(state.cooking.interval);
  state.cooking.interval = setInterval(() => {
    if (!state.cooking.active) return clearInterval(state.cooking.interval);
    if (state.cooking.paused)  return;
    state.cooking.timeLeft--;
    updateCookingCountdown();
    if (state.cooking.timeLeft <= 0) advanceStep();
  }, 1000);
}

function advanceStep() {
  const { recipe, stepIndex } = state.cooking;
  const next = stepIndex + 1;
  if (next >= recipe.pasos.length) {
    finishCooking();
    return;
  }
  state.cooking.stepIndex = next;
  state.cooking.timeLeft  = recipe.pasos[next].duracion;
  applyStepBurners(recipe.pasos[next]);
  updateCookingUI();
}

function togglePauseCooking() {
  state.cooking.paused = !state.cooking.paused;
  const btn = document.getElementById('btn-pause-cooking');
  const badge = document.getElementById('cooking-paused-badge');
  btn.textContent   = state.cooking.paused ? '▶ Reanudar' : '⏸ Pausar';
  badge.style.display = state.cooking.paused ? 'block' : 'none';
}

function skipStep() {
  advanceStep();
}

function cancelCooking() {
  if (!confirm('¿Cancelar la receta en curso?')) return;
  endCooking();
  allOff();
  showView('control');
}

function finishCooking() {
  clearInterval(state.cooking.interval);
  state.cooking.active = false;
  allOff();
  showToast('🎉 ¡Receta completada!');
  // Pequeño delay para que el usuario vea el mensaje
  setTimeout(() => showView('control'), 1500);
}

function endCooking() {
  clearInterval(state.cooking.interval);
  state.cooking.active = false;
}

// ============================================================
// RECETAS — EDITOR
// ============================================================

function openEditor(recipe = null) {
  if (state.isDemo) return showToast('Inicia sesión para crear recetas');
  if (recipe) {
    state.editingRecipe = JSON.parse(JSON.stringify(recipe));
    state.editingSteps  = [...state.editingRecipe.pasos];
  } else {
    state.editingRecipe = newRecipeTemplate();
    state.editingSteps  = [];
  }
  renderEditor();
  showView('editor');
}

function newRecipeTemplate() {
  return {
    id:          genId(),
    version:     1,
    nombre:      '',
    foto_url:    null,
    tiempo_total: 0,
    dificultad:  'media',
    personas:    2,
    categorias:  [],
    pasos:       [],
    metadatos: {
      creado_por:      state.user.uid,
      creado_en:       new Date().toISOString(),
      actualizado_en:  new Date().toISOString(),
      fuente:          'manual',
      fuente_url:      null
    }
  };
}

function renderEditor() {
  const recipe = state.editingRecipe;
  document.getElementById('editor-title').textContent      = recipe.nombre || 'Nueva receta';
  document.getElementById('recipe-name-input').value       = recipe.nombre;
  document.getElementById('recipe-dificultad').value       = recipe.dificultad || 'media';
  document.getElementById('recipe-personas').value         = recipe.personas || 2;
  renderStepsList();
}

function renderStepsList() {
  const list  = document.getElementById('steps-list');
  const empty = document.getElementById('editor-empty');
  list.innerHTML = '';

  if (!state.editingSteps.length) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  state.editingSteps.forEach((step, idx) => {
    const el = document.createElement('div');
    el.className        = 'step-item';
    el.draggable        = true;
    el.dataset.stepIdx  = idx;
    el.innerHTML = `
      <span class="step-drag-handle" title="Arrastrar">⠿</span>
      <div class="step-item-body">
        <div class="step-item-name">${escapeHtml(step.nombre || 'Sin nombre')}</div>
        <div class="step-item-meta">${formatTime(step.duracion)} · ${activeBurnersSummary(step.fuegos)}</div>
      </div>
      <div class="step-item-actions">
        <button class="btn-icon btn-sm" data-edit-step="${idx}" title="Editar">✏️</button>
        <button class="btn-icon btn-sm" data-del-step="${idx}" title="Borrar">🗑</button>
      </div>`;

    // Drag & drop
    el.addEventListener('dragstart', onStepDragStart);
    el.addEventListener('dragend',   onStepDragEnd);
    el.addEventListener('dragover',  onStepDragOver);
    el.addEventListener('drop',      onStepDrop);

    el.querySelector(`[data-edit-step]`).addEventListener('click', e => {
      e.stopPropagation();
      openStepModal(idx);
    });
    el.querySelector(`[data-del-step]`).addEventListener('click', e => {
      e.stopPropagation();
      state.editingSteps.splice(idx, 1);
      renderStepsList();
    });

    list.appendChild(el);
  });
}

// Drag & drop state
let dragSrcIdx = null;

function onStepDragStart(e) {
  dragSrcIdx = parseInt(this.dataset.stepIdx, 10);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onStepDragEnd()   { this.classList.remove('dragging'); }
function onStepDragOver(e) { e.preventDefault(); this.classList.add('drag-over'); }
function onStepDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const dropIdx = parseInt(this.dataset.stepIdx, 10);
  if (dragSrcIdx === null || dragSrcIdx === dropIdx) return;
  const moved = state.editingSteps.splice(dragSrcIdx, 1)[0];
  state.editingSteps.splice(dropIdx, 0, moved);
  dragSrcIdx = null;
  renderStepsList();
}

function saveEditingRecipe() {
  const name = document.getElementById('recipe-name-input').value.trim();
  if (!name) return showToast('Ponle un nombre a la receta');

  state.editingRecipe.nombre      = name;
  state.editingRecipe.dificultad  = document.getElementById('recipe-dificultad').value;
  state.editingRecipe.personas    = parseInt(document.getElementById('recipe-personas').value, 10) || 2;
  state.editingRecipe.pasos       = state.editingSteps.map((s, i) => ({ ...s, orden: i }));
  state.editingRecipe.tiempo_total = state.editingSteps.reduce((t, s) => t + (s.duracion || 0), 0);
  state.editingRecipe.metadatos.actualizado_en = new Date().toISOString();

  persistRecipe(state.editingRecipe);
  showToast('Receta guardada');
  showView('recetas');
}

// ============================================================
// MODAL DE PASO
// ============================================================

function openStepModal(idx = null) {
  state.editingStepIndex = idx;
  const isNew  = idx === null;
  const step   = isNew
    ? { nombre: '', duracion: 300, instruccion: '', fuegos: defaultStepFuegos() }
    : { ...state.editingSteps[idx] };

  document.getElementById('step-modal-title').textContent = isNew ? 'Nuevo paso' : 'Editar paso';
  document.getElementById('btn-delete-step').style.display = isNew ? 'none' : 'inline-flex';
  document.getElementById('step-name-input').value         = step.nombre;
  document.getElementById('step-min-input').value          = Math.floor(step.duracion / 60);
  document.getElementById('step-sec-input').value          = step.duracion % 60;
  document.getElementById('step-instruction-input').value  = step.instruccion || '';

  // Fuegos
  ZONES.forEach(z => {
    const fuego  = step.fuegos?.[z] || { activo: false, potencia: 5 };
    const track  = document.getElementById(`track-step-${z}`);
    const label  = document.getElementById(`label-step-${z}`);
    const slider = document.getElementById(`slider-step-${z}`);
    const disp   = document.getElementById(`disp-step-${z}`);
    const ctrls  = document.getElementById(`controls-step-${z}`);

    track.classList.toggle('on', fuego.activo);
    label.textContent       = fuego.activo ? 'Encendido' : 'Apagado';
    slider.value            = fuego.potencia;
    disp.textContent        = fuego.potencia;
    ctrls.style.display     = fuego.activo ? 'block' : 'none';
  });

  openModal('modal-step');
}

function saveStep() {
  const nombre = document.getElementById('step-name-input').value.trim();
  if (!nombre) return showToast('El paso necesita un nombre');

  const m = parseInt(document.getElementById('step-min-input').value, 10) || 0;
  const s = parseInt(document.getElementById('step-sec-input').value, 10) || 0;
  const duracion = m * 60 + s || 60;

  const fuegos = {};
  ZONES.forEach(z => {
    const activo  = document.getElementById(`track-step-${z}`).classList.contains('on');
    const potencia = parseInt(document.getElementById(`slider-step-${z}`).value, 10);
    fuegos[z] = { activo, potencia: activo ? potencia : 0, boost: false };
  });

  const step = {
    id:          state.editingStepIndex !== null
                   ? state.editingSteps[state.editingStepIndex].id
                   : genId(),
    orden:       state.editingStepIndex ?? state.editingSteps.length,
    nombre,
    duracion,
    instruccion: document.getElementById('step-instruction-input').value.trim(),
    fuegos
  };

  if (state.editingStepIndex !== null) {
    state.editingSteps[state.editingStepIndex] = step;
  } else {
    state.editingSteps.push(step);
  }

  renderStepsList();
  closeModal('modal-step');
}

function deleteEditingStep() {
  if (state.editingStepIndex === null) return;
  state.editingSteps.splice(state.editingStepIndex, 1);
  renderStepsList();
  closeModal('modal-step');
}

function defaultStepFuegos() {
  const f = {};
  ZONES.forEach(z => { f[z] = { activo: false, potencia: 5, boost: false }; });
  return f;
}

// ============================================================
// RENDERIZADO DE RECETAS
// ============================================================

function renderRecipeList() {
  const list = document.getElementById('recipes-list');
  list.innerHTML = '';

  if (!state.recipes.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📖</div>
        <p>${state.isDemo
          ? 'Este es el modo demo. Aquí aparecerán tus recetas.'
          : 'Sin recetas aún. ¡Crea la primera!'}</p>
        ${state.isDemo ? '<div class="demo-badge">ℹ️ Modo demo</div>' : ''}
      </div>`;
    return;
  }

  state.recipes
    .slice()
    .sort((a, b) => (b.metadatos?.actualizado_en || '') > (a.metadatos?.actualizado_en || '') ? 1 : -1)
    .forEach(recipe => {
      const total = recipe.tiempo_total || recipe.pasos?.reduce((t, s) => t + (s.duracion || 0), 0) || 0;
      const card = document.createElement('div');
      card.className = 'recipe-card';
      card.innerHTML = `
        <div class="recipe-thumb">${recipe.foto_url ? `<img src="${escapeHtml(recipe.foto_url)}" alt="">` : '🍳'}</div>
        <div class="recipe-info">
          <div class="recipe-title">${escapeHtml(recipe.nombre)}</div>
          <div class="recipe-meta">${formatTime(total)} · ${recipe.pasos?.length || 0} pasos · ${recipe.personas || 2} pers.</div>
        </div>
        <div class="recipe-actions">
          <button class="btn-icon" data-action="cook"   data-id="${recipe.id}" title="Cocinar">▶️</button>
          <button class="btn-icon" data-action="edit"   data-id="${recipe.id}" title="Editar">✏️</button>
          <button class="btn-icon" data-action="dup"    data-id="${recipe.id}" title="Duplicar">📋</button>
          <button class="btn-icon" data-action="delete" data-id="${recipe.id}" title="Borrar" style="color:var(--danger)">🗑</button>
        </div>`;
      list.appendChild(card);
    });

  // Delegación de eventos
  list.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id     = btn.dataset.id;
      const recipe = state.recipes.find(r => r.id === id);
      if (!recipe) return;
      switch (btn.dataset.action) {
        case 'cook':   startCooking(recipe); break;
        case 'edit':   openEditor(recipe);   break;
        case 'dup':    duplicateRecipe(recipe); break;
        case 'delete':
          if (confirm(`¿Borrar "${recipe.nombre}"?`)) deleteRecipeById(id);
          break;
      }
    });
  });
}

function duplicateRecipe(recipe) {
  const copy = JSON.parse(JSON.stringify(recipe));
  copy.id     = genId();
  copy.nombre = recipe.nombre + ' (copia)';
  copy.metadatos.creado_en     = new Date().toISOString();
  copy.metadatos.actualizado_en = new Date().toISOString();
  persistRecipe(copy);
  showToast('Receta duplicada');
}

// ============================================================
// UI — BURNER (HOB model)
// ============================================================

function updateBurnerUI(zone) {
  const b   = state.burners[zone];
  const el  = document.getElementById('z-' + zone);
  const num = document.getElementById('zn-' + zone);

  el.classList.toggle('on',    b.activo);
  el.classList.toggle('boost', b.boost);
  el.classList.toggle('selected', state.selectedZone === zone);

  if (b.activo) {
    const { color } = burnerColor(b.potencia, b.boost);
    el.style.setProperty('--zc', color);
    num.textContent = b.boost ? 'B' : (b.potencia || '');
  } else {
    el.style.removeProperty('--zc');
    num.textContent = '0';
  }

  const ledMap = { trasero: 'pled-trasero', delantera_der: 'pled-der', delantera_izq: 'pled-izq' };
  const led = document.getElementById(ledMap[zone]);
  if (led) led.classList.toggle('on', b.activo);

  if (state.selectedZone === zone) updateZCPanel();
  updatePanelDisplay();
}

function updateAllBurnersUI() {
  ZONES.forEach(updateBurnerUI);
}

function updateChildLockUI() {
  const btn = document.getElementById('btn-child-lock');
  btn.classList.toggle('locked', state.bloqueoInfantil);
  btn.textContent = state.bloqueoInfantil ? '🔓' : '🔒';
}

function updateTimerUI(zone) {
  if (state.selectedZone !== zone) return;
  const secs = state.timerSeconds[zone] || 0;
  const val  = document.getElementById('timer-val-sel');
  const btn  = document.getElementById('btn-timer-sel');
  if (val) val.textContent = secs > 0 ? formatTime(secs) : '';
  if (btn) btn.classList.toggle('active', secs > 0);
}

// ── Zone selection & ZCP ──

function selectZone(zone) {
  if (state.bloqueoInfantil) return shakeZone(zone);
  if (state.selectedZone === zone) {
    toggleBurner(zone);
    return;
  }
  state.selectedZone = zone;
  ZONES.forEach(z => {
    document.getElementById('z-' + z).classList.toggle('selected', z === zone);
  });
  showZoneControls(zone);
}

function showZoneControls(zone) {
  const b = state.burners[zone];
  document.getElementById('zcp-empty').style.display    = 'none';
  document.getElementById('zcp-controls').style.display = 'block';

  const color = b.activo ? burnerColor(b.potencia, b.boost).color : '#444';
  const panel = document.getElementById('zcp');
  panel.classList.add('has-selection');
  panel.style.setProperty('--sel-color', color);

  const ZLBLS = { trasero: 'TRASERO', delantera_izq: 'DEL. IZQ.', delantera_der: 'DEL. DER.' };
  document.getElementById('zcp-name').textContent = ZLBLS[zone];
  document.getElementById('zcp-pwr').textContent  = b.activo ? (b.boost ? 'B' : b.potencia) : '0';
  document.getElementById('pwr-slider').value     = b.potencia;
  document.getElementById('pwr-btn').classList.toggle('on', b.activo);
  document.getElementById('btn-boost-sel').classList.toggle('boost-active', b.boost);
  updateTimerUI(zone);
}

function updateZCPanel() {
  if (state.selectedZone) showZoneControls(state.selectedZone);
}

function updatePanelDisplay() {
  const el = document.getElementById('panel-disp');
  if (!el) return;
  el.textContent = ZONES.map(z => {
    const b = state.burners[z];
    return b.activo ? (b.boost ? 'B' : b.potencia) : '—';
  }).join(' ');
}

function buildTicks() {
  const el = document.getElementById('slider-ticks');
  if (!el) return;
  for (let i = 0; i <= 17; i++) {
    const d = document.createElement('div');
    d.className = 'tick' + (i % 3 === 0 ? ' major' : '');
    el.appendChild(d);
  }
}

// ============================================================
// UI — COOKING
// ============================================================

function updateCookingUI() {
  const { recipe, stepIndex } = state.cooking;
  const step = recipe.pasos[stepIndex];
  const total = recipe.pasos.length;

  document.getElementById('cooking-recipe-name').textContent = recipe.nombre;
  document.getElementById('cooking-step-cur').textContent    = stepIndex + 1;
  document.getElementById('cooking-step-tot').textContent    = total;
  document.getElementById('cooking-step-name').textContent   = step.nombre;
  document.getElementById('cooking-instruction').textContent = step.instruccion || '';

  // Progreso
  const pct = Math.round(stepIndex / total * 100);
  document.getElementById('cooking-progress-fill').style.width = pct + '%';

  // Mini burners
  ZONES.forEach(z => {
    const fuego = step.fuegos?.[z];
    const el    = document.getElementById('mini-' + z);
    const pEl   = document.getElementById('mini-p-' + z);
    if (fuego?.activo) {
      const { color } = burnerColor(fuego.potencia, fuego.boost);
      el.classList.add('active');
      el.style.setProperty('--burner-color', color);
      pEl.textContent  = fuego.boost ? 'B' : fuego.potencia;
      pEl.style.color  = color;
    } else {
      el.classList.remove('active');
      el.style.removeProperty('--burner-color');
      pEl.textContent = '—';
      pEl.style.color = '';
    }
  });

  // Siguiente paso
  const nextStep = recipe.pasos[stepIndex + 1];
  const nextBox  = document.getElementById('next-step-box');
  if (nextStep) {
    document.getElementById('cooking-next-step').textContent = nextStep.nombre;
    nextBox.style.display = 'flex';
  } else {
    nextBox.style.display = 'none';
  }

  updateCookingCountdown();
}

function updateCookingCountdown() {
  const el  = document.getElementById('cooking-countdown');
  const sec = state.cooking.timeLeft;
  el.textContent = formatTime(sec);
  el.classList.toggle('urgent', sec <= 10 && sec > 0);
}

// ============================================================
// NAVEGACIÓN
// ============================================================

function showView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + view);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
  if (navBtn) navBtn.classList.add('active');

  state.currentView = view;

  const hiddenViews = ['cooking', 'editor'];
  document.getElementById('bottom-nav').style.display = hiddenViews.includes(view) ? 'none' : 'flex';
}

function showApp() {
  document.getElementById('screen-auth').style.display = 'none';
  document.getElementById('app').style.display         = 'flex';
  document.getElementById('app-header').style.display  = 'flex';

  // Avatar
  const avatar = document.getElementById('btn-avatar');
  avatar.textContent = state.user?.displayName?.[0]?.toUpperCase() || '?';

  document.getElementById('user-name-label').textContent  = state.user?.displayName || 'Demo';
  document.getElementById('user-email-label').textContent = state.user?.email || 'Modo demo';

  if (!state.deviceId || state.isDemo) {
    document.getElementById('device-setup').style.display = state.isDemo ? 'none' : 'flex';
  }
}

function showAuthScreen() {
  document.getElementById('screen-auth').style.display = 'flex';
  document.getElementById('app').style.display         = 'none';
  document.getElementById('app-header').style.display  = 'none';
}

// ============================================================
// MODALS
// ============================================================

function openModal(id) {
  const el = document.getElementById(id);
  el.style.display = 'flex';
  el.addEventListener('click', outsideModalClose);
}

function closeModal(id) {
  const el = document.getElementById(id);
  el.style.display = 'none';
  el.removeEventListener('click', outsideModalClose);
}

function outsideModalClose(e) {
  if (e.target === e.currentTarget) closeModal(e.currentTarget.id);
}

// ============================================================
// TOAST
// ============================================================

let toastTimeout = null;

function showToast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('in-cooking', state.cooking.active);
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.add('hidden'), duration);
}

// ============================================================
// UTILS
// ============================================================

function formatTime(seconds) {
  if (!seconds || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function genId() {
  return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function activeBurnersSummary(fuegos) {
  if (!fuegos) return 'Sin fuegos';
  const active = ZONES.filter(z => fuegos[z]?.activo);
  if (!active.length) return 'Todo apagado';
  return active.map(z => `${ZONE_LABELS[z].split('.')[0]} (${fuegos[z].potencia})`).join(', ');
}

// ============================================================
// RECETAS DE EJEMPLO
// ============================================================

function sampleRecipes() {
  return [
    {
      id: 'demo_1', version: 1,
      nombre: 'Sofrito base',
      foto_url: null,
      tiempo_total: 600, dificultad: 'facil', personas: 4,
      categorias: ['base'],
      pasos: [
        { id: 'sp1', orden: 0, nombre: 'Calentar aceite', duracion: 120,
          instruccion: 'Añade aceite de oliva a la sartén',
          fuegos: { trasero: { activo: true, potencia: 5, boost: false }, delantera_izq: { activo: false, potencia: 0, boost: false }, delantera_der: { activo: false, potencia: 0, boost: false } } },
        { id: 'sp2', orden: 1, nombre: 'Pochar cebolla', duracion: 300,
          instruccion: 'Añade la cebolla picada y sofríe a fuego medio hasta que esté transparente',
          fuegos: { trasero: { activo: true, potencia: 6, boost: false }, delantera_izq: { activo: false, potencia: 0, boost: false }, delantera_der: { activo: false, potencia: 0, boost: false } } },
        { id: 'sp3', orden: 2, nombre: 'Añadir tomate', duracion: 180,
          instruccion: 'Incorpora el tomate triturado y remueve bien. Sazona al gusto.',
          fuegos: { trasero: { activo: true, potencia: 7, boost: false }, delantera_izq: { activo: false, potencia: 0, boost: false }, delantera_der: { activo: false, potencia: 0, boost: false } } }
      ],
      metadatos: { creado_por: 'demo', creado_en: '2024-01-01T00:00:00Z', actualizado_en: '2024-01-01T00:00:00Z', fuente: 'manual', fuente_url: null }
    },
    {
      id: 'demo_2', version: 1,
      nombre: 'Pasta al dente',
      foto_url: null,
      tiempo_total: 900, dificultad: 'facil', personas: 2,
      categorias: ['pasta', 'italiana'],
      pasos: [
        { id: 'pp1', orden: 0, nombre: 'Hervir agua', duracion: 480,
          instruccion: 'Llena una olla con agua abundante y sal. Espera a que hierva a borbotones.',
          fuegos: { trasero: { activo: true, potencia: 15, boost: false }, delantera_izq: { activo: false, potencia: 0, boost: false }, delantera_der: { activo: false, potencia: 0, boost: false } } },
        { id: 'pp2', orden: 1, nombre: 'Cocer pasta', duracion: 420,
          instruccion: 'Añade la pasta y remueve. Mantén el hervor. Sigue el tiempo del paquete.',
          fuegos: { trasero: { activo: true, potencia: 10, boost: false }, delantera_izq: { activo: false, potencia: 0, boost: false }, delantera_der: { activo: false, potencia: 0, boost: false } } }
      ],
      metadatos: { creado_por: 'demo', creado_en: '2024-01-02T00:00:00Z', actualizado_en: '2024-01-02T00:00:00Z', fuente: 'manual', fuente_url: null }
    }
  ];
}

// ============================================================
// SERVICE WORKER
// ============================================================

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// ============================================================
// EVENT LISTENERS
// ============================================================

function initEvents() {

  // --- AUTH ---
  document.getElementById('btn-google-login').addEventListener('click', loginWithGoogle);
  document.getElementById('btn-demo').addEventListener('click', enterDemoMode);

  // --- DEVICE SETUP ---
  document.getElementById('btn-set-device').addEventListener('click', () => {
    setDeviceId(document.getElementById('input-device-id').value);
  });
  document.getElementById('input-device-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') setDeviceId(e.target.value);
  });

  // --- NAVIGATION ---
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // --- ZONE SELECTION (HOB) ---
  ZONES.forEach(z => {
    document.getElementById('z-' + z).addEventListener('click', () => selectZone(z));
  });

  // --- ZONE CONTROL PANEL ---
  document.getElementById('pwr-btn').addEventListener('click', () => {
    if (state.selectedZone) toggleBurner(state.selectedZone);
  });
  document.getElementById('pwr-slider').addEventListener('input', e => {
    if (state.selectedZone) setBurnerPower(state.selectedZone, e.target.value);
  });
  document.getElementById('btn-boost-sel').addEventListener('click', () => {
    if (state.selectedZone) toggleBoost(state.selectedZone);
  });
  document.getElementById('btn-timer-sel').addEventListener('click', () => {
    if (state.selectedZone) openTimerModal(state.selectedZone);
  });

  // --- GLOBAL CONTROLS ---
  document.getElementById('btn-all-off').addEventListener('click', allOff);
  document.getElementById('btn-child-lock').addEventListener('click', toggleChildLock);

  // --- HEADER ---
  document.getElementById('btn-avatar').addEventListener('click', () => openModal('modal-user'));
  document.getElementById('btn-change-device').addEventListener('click', () => {
    closeModal('modal-user');
    document.getElementById('device-setup').style.display = 'flex';
    showView('control');
  });
  document.getElementById('btn-logout').addEventListener('click', logout);

  // --- RECIPES ---
  document.getElementById('btn-new-recipe').addEventListener('click', () => openEditor());

  // --- EDITOR ---
  document.getElementById('btn-back-editor').addEventListener('click', () => showView('recetas'));
  document.getElementById('btn-save-recipe').addEventListener('click', saveEditingRecipe);
  document.getElementById('btn-add-step').addEventListener('click', () => openStepModal(null));

  // --- COOKING ---
  document.getElementById('btn-pause-cooking').addEventListener('click', togglePauseCooking);
  document.getElementById('btn-skip-step').addEventListener('click', skipStep);
  document.getElementById('btn-cancel-cooking').addEventListener('click', cancelCooking);

  // --- MODAL TIMER ---
  document.getElementById('btn-close-timer').addEventListener('click', () => closeModal('modal-timer'));
  document.getElementById('btn-timer-confirm').addEventListener('click', confirmTimer);
  document.getElementById('btn-timer-clear').addEventListener('click', () => {
    clearBurnerTimer(state.timerModalZone);
    closeModal('modal-timer');
  });

  // --- MODAL STEP ---
  document.getElementById('btn-close-step').addEventListener('click', () => closeModal('modal-step'));
  document.getElementById('btn-save-step').addEventListener('click', saveStep);
  document.getElementById('btn-delete-step').addEventListener('click', deleteEditingStep);

  // Toggles de fuego en el modal de paso
  ZONES.forEach(z => {
    document.getElementById(`toggle-step-${z}`).addEventListener('click', () => {
      const track  = document.getElementById(`track-step-${z}`);
      const label  = document.getElementById(`label-step-${z}`);
      const ctrls  = document.getElementById(`controls-step-${z}`);
      const isOn   = !track.classList.contains('on');
      track.classList.toggle('on', isOn);
      label.textContent     = isOn ? 'Encendido' : 'Apagado';
      ctrls.style.display   = isOn ? 'block' : 'none';
    });
    document.getElementById(`slider-step-${z}`).addEventListener('input', e => {
      document.getElementById(`disp-step-${z}`).textContent = e.target.value;
    });
  });

  // Cerrar modales con Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ['modal-timer', 'modal-step', 'modal-user'].forEach(closeModal);
    }
  });
}

// ============================================================
// CSS ANIMATION — shake (para bloqueo)
// ============================================================

function injectShakeKeyframes() {
  if (document.getElementById('shake-style')) return;
  const style = document.createElement('style');
  style.id = 'shake-style';
  style.textContent = `
    @keyframes shake {
      0%,100% { transform: translateX(0); }
      20%      { transform: translateX(-5px); }
      40%      { transform: translateX(5px); }
      60%      { transform: translateX(-4px); }
      80%      { transform: translateX(4px); }
    }`;
  document.head.appendChild(style);
}

// ============================================================
// INIT
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  injectShakeKeyframes();
  buildTicks();
  initEvents();
  initAuth();
  registerSW();
  updateAllBurnersUI();
  setConnStatus('offline');
});
