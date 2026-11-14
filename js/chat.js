// =====================================================================
// chat.js – logic for chat.html (Lounge)
//   1. Start up        5. Online roster (Presence)
//   2. Rooms           6. Mobile drawers, logout
//   3. Messages        7. Create rooms
//   4. Send / moderate 8. Profile photo   9. Admin tools
// =====================================================================

import { supabase } from './supabaseClient.js';
import {
  $, $$, escapeHtml, fmtTime, fmtFull, dayLabel, isSameDay,
  maskBadWords, initials, avatarColor, showToast
} from './utils.js';

const LOGIN_PAGE = 'index.html';
const MESSAGE_LIMIT = 100;
const LAST_ROOM_KEY = 'lounge:last-room';
const MESSAGE_COLUMNS = 'id, room_id, user_id, content, deleted, deleted_by, created_at';
const UNSEND_MS = 10 * 60 * 1000;          // users may delete their own message for 10 minutes
const PROFILE_COLUMNS = 'id, username, role, avatar_url';
const AVATAR_BUCKET = 'avatars';

const el = {
  roomList: $('#room-list'), feed: $('#feed'),
  roomTitle: $('#room-title'), roomDesc: $('#room-desc'),
  composer: $('#composer'), input: $('#message-input'), sendBtn: $('#send-btn'),
  rosterList: $('#roster-list'),
  meName: $('#me-name'), meRole: $('#me-role'), meAvatar: $('#me-avatar'),
  logoutBtn: $('#logout-btn'), menuBtn: $('#menu-btn'), peopleBtn: $('#people-btn'),
  scrim: $('#scrim'), adminBtn: $('#admin-btn')
};

/* ---------- State ---------- */
let me = null;                 // my profile
let rooms = [];
let currentRoom = null;
let messages = [];             // open room, oldest first
let messageChannel = null;
let presenceChannel = null;
let presenceReady = false;
let realtimeWasDown = false;
let loadToken = 0;             // ignores late answers after switching rooms
let sending = false;
const profiles = new Map();    // user id -> profile

const isMod = () => !!me && (me.role === 'moderator' || me.role === 'admin');
const nameOf = (id) => profiles.get(id)?.username || 'unknown';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* =====================================================================
   1. START UP
   ===================================================================== */
async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return location.replace(LOGIN_PAGE);

  const { data: profile, error } = await supabase
    .from('profiles').select(PROFILE_COLUMNS).eq('id', session.user.id).single();

  if (error || !profile) {
    showToast('Your profile was not found. Please register again.', 'error', 6000);
    await supabase.auth.signOut();
    setTimeout(() => location.replace(LOGIN_PAGE), 2500);
    return;
  }
  me = profile;
  profiles.set(me.id, me);
  renderMe();

  const { data: roomData, error: roomError } = await supabase
    .from('rooms').select('id, name, description, created_by, kind').order('id');
  if (roomError || !roomData?.length) {
    el.feed.innerHTML = '<p class="empty">No rooms found. Did you run schema.sql?</p>';
    return;
  }
  rooms = roomData;
  renderRooms();
  startPresence();
  startLiveFeeds();

  let savedId = null;
  try { savedId = Number(localStorage.getItem(LAST_ROOM_KEY)); } catch { /* storage blocked */ }
  await openRoom(rooms.find(r => r.id === savedId) || firstRoom());
}

function renderMe() {
  el.meName.textContent = me.username;
  el.meRole.textContent = cap(me.role);
  el.meAvatar.innerHTML = me.avatar_url
    ? `<img src="${escapeHtml(me.avatar_url)}" alt="">`
    : escapeHtml(initials(me.username));
  el.meAvatar.style.background = me.avatar_url ? '' : avatarColor(me.username);
  el.adminBtn.hidden = me.role !== 'admin';
  $('#new-room-btn').hidden = me.role !== 'admin';
}

/* =====================================================================
   2. ROOMS
   ===================================================================== */
// Public rooms: only admins create/delete. Private groups: only the Coordinator (creator) deletes.
const canDeleteRoom = (r) => !!me && (r.kind === 'private' ? r.created_by === me.id : me.role === 'admin');
const isCoordinator = (r) => !!me && !!r && r.kind === 'private' && r.created_by === me.id;
const firstRoom = () => rooms.find(r => r.kind === 'public') || rooms[0];

function roomItem(r) {
  const lock = r.kind === 'private' ? '<span class="room-lock" title="Private group">🔒</span>' : '';
  return `
    <li class="room-item">
      <button type="button" class="room-btn" data-room="${r.id}" aria-current="${currentRoom?.id === r.id}">
        <span class="room-hash">#</span>${escapeHtml(r.name)}${lock}
      </button>
      ${canDeleteRoom(r)
        ? `<button type="button" class="room-del" data-delroom="${r.id}" aria-label="Delete #${escapeHtml(r.name)}" title="Delete">✕</button>`
        : ''}
    </li>`;
}

function renderRooms() {
  const pub = rooms.filter(r => r.kind === 'public');
  const priv = rooms.filter(r => r.kind === 'private');
  el.roomList.innerHTML =
    pub.map(roomItem).join('') +
    `<li class="room-section"><span>Private groups</span>
       <button type="button" class="btn btn-ghost icon-btn" id="new-group-btn" aria-label="Create a private group" title="Create a private group">+</button></li>` +
    (priv.length ? priv.map(roomItem).join('') : '<li class="room-none">No private groups yet</li>');
}

el.roomList.addEventListener('click', (event) => {
  if (event.target.closest('#new-group-btn')) { openRoomDialog('private'); return; }
  const del = event.target.closest('[data-delroom]');
  if (del) { deleteRoom(Number(del.dataset.delroom)); return; }
  const btn = event.target.closest('[data-room]');
  if (!btn) return;
  const room = rooms.find(r => r.id === Number(btn.dataset.room));
  if (room && room.id !== currentRoom?.id) openRoom(room);
  else closeDrawers();
});

async function openRoom(room) {
  const token = ++loadToken;
  currentRoom = room;
  messages = [];
  try { localStorage.setItem(LAST_ROOM_KEY, String(room.id)); } catch { /* ignore */ }

  renderRooms();
  el.roomTitle.textContent = `# ${room.name}`;
  el.roomDesc.textContent = room.description || '';
  $('#members-btn').hidden = room.kind !== 'private';
  el.input.placeholder = `Message #${room.name}`;
  el.feed.innerHTML = '<p class="empty">Loading messages…</p>';
  closeDrawers();
  updatePresence();

  subscribeToRoom(room, token);          // subscribe first so no message is missed
  await loadMessages(room, token);

  if (window.matchMedia('(min-width: 901px)').matches) el.input.focus();
}

/* =====================================================================
   3. MESSAGES: load, live updates, render
   ===================================================================== */
async function ensureProfiles(ids) {
  const missing = [...new Set(ids)].filter(id => !profiles.has(id));
  if (!missing.length) return;
  const { data } = await supabase.from('profiles').select(PROFILE_COLUMNS).in('id', missing);
  (data || []).forEach(p => profiles.set(p.id, p));
}

async function loadMessages(room, token) {
  const { data, error } = await supabase
    .from('messages').select(MESSAGE_COLUMNS)
    .eq('room_id', room.id)
    .order('created_at', { ascending: false })
    .limit(MESSAGE_LIMIT);

  if (token !== loadToken) return;
  if (error) {
    el.feed.innerHTML = `<p class="empty">Could not load messages: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const loaded = data.reverse();
  await ensureProfiles(loaded.map(m => m.user_id));
  if (token !== loadToken) return;

  const byId = new Map(loaded.map(m => [m.id, m]));       // merge with live arrivals
  messages.forEach(m => byId.set(m.id, m));
  messages = [...byId.values()].sort((a, b) => a.id - b.id);
  renderMessages('force');
}

function subscribeToRoom(room, token) {
  if (messageChannel) supabase.removeChannel(messageChannel);
  const filter = `room_id=eq.${room.id}`;

  messageChannel = supabase.channel(`room-${room.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter },
        (payload) => addIncoming(payload.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter },
        (payload) => addIncoming(payload.new))
    .subscribe((status) => {
      if (token !== loadToken) return;
      if (status === 'SUBSCRIBED') {
        if (realtimeWasDown) { realtimeWasDown = false; loadMessages(room, token); }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        realtimeWasDown = true;
        showToast('Live updates interrupted. Reconnecting…', 'error');
      }
    });
}

async function addIncoming(message) {
  if (!currentRoom || message.room_id !== currentRoom.id) return;
  await ensureProfiles([message.user_id]);
  if (message.room_id !== currentRoom.id) return;

  const index = messages.findIndex(m => m.id === message.id);
  if (index >= 0) messages[index] = { ...messages[index], ...message };
  else { messages.push(message); messages.sort((a, b) => a.id - b.id); }
  renderMessages(message.user_id === me.id ? 'force' : 'auto');
}

// Photo if the user has one, otherwise coloured initials
function avatarHtml(userId, extra = '') {
  const p = profiles.get(userId);
  const name = p?.username || '?';
  if (p?.avatar_url) {
    return `<span class="avatar ${extra}"><img src="${escapeHtml(p.avatar_url)}" alt="" loading="lazy"></span>`;
  }
  return `<span class="avatar ${extra}" style="background:${avatarColor(name)}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
}

function messageHtml(m) {
  const name = nameOf(m.user_id);
  const classes = ['msg'];
  if (m.user_id === me.id) classes.push('mine');
  if (m.deleted) classes.push('gone');

  const canUnsend = m.user_id === me.id && !m.deleted && Date.now() - new Date(m.created_at).getTime() < UNSEND_MS;
  const text = m.deleted
    ? (m.deleted_by && m.deleted_by === m.user_id ? 'This message was deleted' : 'Message removed by a moderator')
    : escapeHtml(m.content);
  const removeBtn = !m.deleted && (canUnsend || isMod())
    ? `<button type="button" class="msg-remove" data-remove="${m.id}">${canUnsend ? 'Delete' : 'Remove'}</button>` : '';

  return `
    <div class="${classes.join(' ')}" data-id="${m.id}">
      ${avatarHtml(m.user_id)}
      <div class="msg-body">
        <div class="msg-meta">
          <strong>${escapeHtml(name)}</strong>
          <time datetime="${escapeHtml(m.created_at)}" title="${escapeHtml(fmtFull(m.created_at))}">${escapeHtml(fmtTime(m.created_at))}</time>
          ${removeBtn}
        </div>
        <p class="msg-text">${text}</p>
      </div>
    </div>`;
}

// scroll: 'force' = jump to newest, 'auto' = only if already near the bottom
function renderMessages(scroll = 'auto') {
  const feed = el.feed;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;

  if (!messages.length) {
    feed.innerHTML = `<p class="empty">No messages in #${escapeHtml(currentRoom.name)} yet. Say hello.</p>`;
    return;
  }

  let html = '';
  let previous = null;
  for (const m of messages) {
    if (!previous || !isSameDay(previous.created_at, m.created_at)) {
      html += `<div class="day-divider">${escapeHtml(dayLabel(m.created_at))}</div>`;
    }
    html += messageHtml(m);
    previous = m;
  }
  feed.innerHTML = html;
  if (scroll === 'force' || nearBottom) feed.scrollTo({ top: feed.scrollHeight, behavior: 'auto' });
}

/* =====================================================================
   4. SENDING AND MODERATION
   ===================================================================== */
el.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentRoom || sending) return;

  const raw = el.input.value.trim();
  if (!raw) return;
  const text = maskBadWords(raw);

  sending = true;
  el.sendBtn.disabled = true;
  const { data, error } = await supabase
    .from('messages')
    .insert({ room_id: currentRoom.id, user_id: me.id, content: text })
    .select(MESSAGE_COLUMNS).single();
  sending = false;
  el.sendBtn.disabled = false;

  if (error) { showToast(`Could not send: ${error.message}`, 'error'); return; }
  el.input.value = '';
  if (text !== raw) showToast('Some words were masked.', 'info');
  await addIncoming(data);
  el.input.focus();
});

el.feed.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-remove]');
  if (!btn) return;
  if (!confirm('Delete this message for everyone?')) return;

  btn.disabled = true;
  const { data, error } = await supabase
    .from('messages').update({ deleted: true, deleted_by: me.id })
    .eq('id', Number(btn.dataset.remove))
    .select(MESSAGE_COLUMNS);

  if (error || !data?.length) {
    showToast(error ? error.message : 'You can only delete your own messages for 10 minutes after sending.', 'error');
    btn.disabled = false;
    return;
  }
  await addIncoming(data[0]);
});

// Hide the Delete button on my messages once the 10 minutes are over
setInterval(() => {
  $$('.msg.mine .msg-remove').forEach(b => {
    const m = messages.find(x => x.id === Number(b.dataset.remove));
    if (m && !isMod() && Date.now() - new Date(m.created_at).getTime() >= UNSEND_MS) b.remove();
  });
}, 15000);

/* =====================================================================
   5. ONLINE ROSTER (Supabase Presence)
   ===================================================================== */
function startPresence() {
  presenceChannel = supabase.channel('lobby', { config: { presence: { key: me.id } } });
  presenceChannel
    .on('presence', { event: 'sync' }, async () => {
      await ensureProfiles(Object.keys(presenceChannel.presenceState()));
      renderRoster();
    })
    .subscribe(async (status) => {
      presenceReady = status === 'SUBSCRIBED';
      if (presenceReady) await updatePresence();
    });
}

async function updatePresence() {
  if (!presenceReady || !presenceChannel) return;
  await presenceChannel.track({ username: me.username, room: currentRoom && currentRoom.kind === 'public' ? currentRoom.name : '' });
}

function renderRoster() {
  if (!presenceChannel) return;
  const state = presenceChannel.presenceState();
  const users = Object.entries(state).map(([id, metas]) => {
    const meta = metas[metas.length - 1];          // newest announcement (user may have several tabs)
    return { id, username: profiles.get(id)?.username || meta.username || 'unknown', room: meta.room };
  }).sort((a, b) => a.username.localeCompare(b.username));

  $$('.online-count').forEach(node => { node.textContent = users.length; });
  el.rosterList.innerHTML = users.map(u => `
    <li class="roster-item">
      ${avatarHtml(u.id, 'avatar-sm')}
      <span class="roster-name">${escapeHtml(u.username)}${u.id === me.id ? ' (you)' : ''}</span>
      ${u.room ? `<span class="roster-room">#${escapeHtml(u.room)}</span>` : ''}
    </li>`).join('');
}

/* =====================================================================
   6. DRAWERS (phones), LOGOUT, SESSION CHANGES
   ===================================================================== */
function closeDrawers() {
  document.body.classList.remove('show-sidebar', 'show-roster');
}
function toggleDrawer(className) {
  const wasOpen = document.body.classList.contains(className);
  closeDrawers();
  if (!wasOpen) document.body.classList.add(className);
}

el.menuBtn.addEventListener('click', () => toggleDrawer('show-sidebar'));
el.peopleBtn.addEventListener('click', () => toggleDrawer('show-roster'));
el.scrim.addEventListener('click', closeDrawers);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawers(); });
window.matchMedia('(min-width: 901px)').addEventListener('change', closeDrawers);

el.logoutBtn.addEventListener('click', async () => {
  el.logoutBtn.disabled = true;
  if (presenceChannel) await supabase.removeChannel(presenceChannel);   // leave the online list at once
  await supabase.auth.signOut();
  location.replace(LOGIN_PAGE);
});

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') location.replace(LOGIN_PAGE);
});

/* =====================================================================
   7. CREATE ROOMS
   ===================================================================== */
const roomDialog = $('#room-dialog');
const roomForm   = $('#room-form');
const roomName   = $('#room-name');
const roomDesc   = $('#room-desc-input');
const roomError  = $('#room-error');
const roomSubmit = $('#room-submit');

function addRoom(room) {                           // my rooms and rooms others create
  if (rooms.some(r => r.id === room.id)) return;
  rooms.push(room);
  rooms.sort((a, b) => a.id - b.id);
  renderRooms();
}

// Remove a room from this screen (used for my deletes and other people's)
function removeRoom(id) {
  invites = invites.filter(i => i.room_id !== id);
  renderInvites();
  const room = rooms.find(r => r.id === id);
  if (!room) return;
  rooms = rooms.filter(r => r.id !== id);
  if (currentRoom?.id === id) {
    showToast(`#${room.name} was deleted`, 'info');
    openRoom(firstRoom());
  } else {
    renderRooms();
  }
}

async function deleteRoom(id) {
  const room = rooms.find(r => r.id === id);
  if (!room || !canDeleteRoom(room)) return;
  if (room.kind === 'public' && rooms.filter(r => r.kind === 'public').length <= 1) { showToast('Keep at least one public room.', 'error'); return; }
  if (!confirm(`Delete #${room.name} and all its messages? This cannot be undone.`)) return;

  const { data, error } = await supabase.from('rooms').delete().eq('id', id).select('id');
  if (error || !data?.length) {
    showToast(error ? error.message : 'You do not have permission to delete this room.', 'error');
    return;
  }
  removeRoom(id);
  showToast(`Deleted #${room.name}`, 'success');
}

let newKind = 'public';
function openRoomDialog(kind) {
  newKind = kind;
  $('#room-dialog-title').textContent = kind === 'private' ? 'Create a private group' : 'Create a public room';
  $('#room-dialog-hint').textContent = kind === 'private'
    ? 'Only people you invite, and who accept, can see it. You will be the Coordinator.'
    : 'Everyone in Lounge can see and join it.';
  roomForm.reset();
  roomError.textContent = '';
  roomDialog.showModal();
  roomName.focus();
}
$('#new-room-btn').addEventListener('click', () => openRoomDialog('public'));
$('#room-cancel').addEventListener('click', () => roomDialog.close());
roomDialog.addEventListener('click', (e) => { if (e.target === roomDialog) roomDialog.close(); });

// "Study Group!" becomes "study-group" while typing
roomName.addEventListener('input', () => {
  roomName.value = roomName.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  roomError.textContent = '';
});

roomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = roomName.value.replace(/^-+|-+$/g, '');
  if (name.length < 2) { roomError.textContent = 'Use 2–24 letters, numbers or hyphens.'; return; }

  roomSubmit.disabled = true;
  const { data, error } = await supabase
    .from('rooms')
    .insert({ name, kind: newKind, description: roomDesc.value.trim() || null })
    .select('id, name, description, created_by, kind').single();
  roomSubmit.disabled = false;

  if (error) {
    roomError.textContent = error.code === '23505' ? 'A room with that name already exists.' : error.message;
    return;
  }
  roomDialog.close();
  addRoom(data);
  openRoom(data);
  showToast(`Created #${data.name}`, 'success');
});

/* =====================================================================
   8. PROFILE PHOTO
   ===================================================================== */
const profileDialog = $('#profile-dialog');
const avatarFile    = $('#avatar-file');
const profileError  = $('#profile-error');
const changeBtn     = $('#avatar-change');
const removeBtn     = $('#avatar-remove');

function applyProfile(p) {                         // one place that refreshes every avatar on screen
  profiles.set(p.id, { ...profiles.get(p.id), ...p });
  if (me && p.id === me.id) { me = profiles.get(me.id); renderMe(); }
  if (currentRoom && messages.length) renderMessages('auto');
  renderRoster();
}

function renderProfileDialog() {
  const box = $('#profile-avatar');
  box.innerHTML = me.avatar_url ? `<img src="${escapeHtml(me.avatar_url)}" alt="">` : escapeHtml(initials(me.username));
  box.style.background = me.avatar_url ? '' : avatarColor(me.username);
  $('#profile-name').textContent = me.username;
  $('#profile-role').textContent = cap(me.role);
  removeBtn.hidden = !me.avatar_url;
}

// Crop to a centred square and shrink to a 256px JPEG (about 20 KB)
async function resizeImage(file, size = 256) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(
    bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not process that image.'))), 'image/jpeg', 0.88));
}

async function saveAvatarUrl(url) {
  const { data, error } = await supabase.from('profiles')
    .update({ avatar_url: url }).eq('id', me.id).select(PROFILE_COLUMNS).single();
  if (error) throw error;
  applyProfile(data);
  renderProfileDialog();
}

function setProfileBusy(state) {
  changeBtn.disabled = removeBtn.disabled = state;
  changeBtn.textContent = state ? 'Uploading…' : 'Upload photo';
}

el.meAvatar.addEventListener('click', () => {
  profileError.textContent = '';
  renderProfileDialog();
  profileDialog.showModal();
});
$('#profile-close').addEventListener('click', () => profileDialog.close());
profileDialog.addEventListener('click', (e) => { if (e.target === profileDialog) profileDialog.close(); });
changeBtn.addEventListener('click', () => avatarFile.click());

avatarFile.addEventListener('change', async () => {
  const file = avatarFile.files[0];
  avatarFile.value = '';
  if (!file) return;
  profileError.textContent = '';
  if (!file.type.startsWith('image/')) { profileError.textContent = 'Choose an image file.'; return; }
  if (file.size > 10 * 1024 * 1024) { profileError.textContent = 'That image is too large (max 10 MB).'; return; }

  setProfileBusy(true);
  try {
    const blob = await resizeImage(file);
    const path = `${me.id}/avatar.jpg`;
    const { error } = await supabase.storage.from(AVATAR_BUCKET)
      .upload(path, blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '3600' });
    if (error) throw error;
    const { data: { publicUrl } } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    await saveAvatarUrl(`${publicUrl}?v=${Date.now()}`);   // ?v= forces browsers to fetch the new image
    showToast('Profile photo updated', 'success');
  } catch (err) {
    profileError.textContent = err.name === 'InvalidStateError'
      ? 'That image format is not supported. Try a JPG or PNG.'
      : (err.message || 'Upload failed.');
  } finally {
    setProfileBusy(false);
  }
});

removeBtn.addEventListener('click', async () => {
  setProfileBusy(true);
  profileError.textContent = '';
  try {
    await supabase.storage.from(AVATAR_BUCKET).remove([`${me.id}/avatar.jpg`]);
    await saveAvatarUrl(null);
    showToast('Profile photo removed', 'success');
  } catch (err) {
    profileError.textContent = err.message || 'Could not remove the photo.';
  } finally {
    setProfileBusy(false);
  }
});

/* =====================================================================
   9. ADMIN TOOLS (clear a room / reset everything)
   ===================================================================== */
const adminDialog = $('#admin-dialog');
const adminError  = $('#admin-error');
const resetInput  = $('#reset-confirm');
const resetBtn    = $('#reset-btn');
const clearBtn    = $('#clear-room-btn');
let adminChannel = null;

function reloadCurrentRoom() {
  if (!currentRoom) return;
  messages = [];
  renderMessages('force');
  loadMessages(currentRoom, loadToken);
}

el.adminBtn.addEventListener('click', () => {
  if (me?.role !== 'admin') return;
  adminError.textContent = '';
  resetInput.value = '';
  resetBtn.disabled = true;
  $('#clear-room-name').textContent = `#${currentRoom?.name ?? ''}`;
  clearBtn.closest('.danger-box').hidden = currentRoom?.kind === 'private';
  adminDialog.showModal();
});
$('#admin-close').addEventListener('click', () => adminDialog.close());
adminDialog.addEventListener('click', (e) => { if (e.target === adminDialog) adminDialog.close(); });
resetInput.addEventListener('input', () => { resetBtn.disabled = resetInput.value.trim() !== 'RESET'; });

async function wipeMessages(roomId) {              // roomId = null wipes every room
  adminError.textContent = '';
  clearBtn.disabled = resetBtn.disabled = true;
  let query = supabase.from('messages').delete({ count: 'exact' });
  query = roomId ? query.eq('room_id', roomId) : query.gt('id', 0);
  const { error, count } = await query;
  clearBtn.disabled = false;
  resetBtn.disabled = resetInput.value.trim() !== 'RESET';

  if (error) { adminError.textContent = error.message; return; }
  adminChannel?.send({ type: 'broadcast', event: 'chat-cleared', payload: {} });
  reloadCurrentRoom();
  adminDialog.close();
  showToast(`Deleted ${count ?? 0} message${count === 1 ? '' : 's'}`, 'success');
}

clearBtn.addEventListener('click', () => {
  if (currentRoom && confirm(`Delete ALL messages in #${currentRoom.name}? This cannot be undone.`)) {
    wipeMessages(currentRoom.id);
  }
});
resetBtn.addEventListener('click', () => {
  if (resetInput.value.trim() === 'RESET') wipeMessages(null);
});

/* =====================================================================
   10. PRIVATE GROUPS: members and invitations
   ===================================================================== */
const membersDialog = $('#members-dialog');
const inviteForm    = $('#invite-form');
const inviteInput   = $('#invite-username');
const inviteError   = $('#invite-error');
const inviteList    = $('#invite-list');
let invites = [];                                  // pending invitations sent TO me

async function loadInvites() {
  const { data } = await supabase.from('room_invites')
    .select('id, room_id, invited_by, rooms(name)')
    .eq('invited_user', me.id).eq('status', 'pending').order('id');
  invites = data || [];
  await ensureProfiles(invites.map(i => i.invited_by));
  renderInvites();
}

function renderInvites() {
  $('#invite-section').hidden = !invites.length;
  inviteList.innerHTML = invites.map(i => `
    <li class="invite">
      <p><strong>${escapeHtml(nameOf(i.invited_by))}</strong> invited you to <strong>#${escapeHtml(i.rooms?.name || 'a group')}</strong></p>
      <div class="invite-actions">
        <button type="button" class="btn btn-primary btn-sm" data-accept="${i.id}">Accept</button>
        <button type="button" class="btn btn-ghost btn-sm" data-decline="${i.id}">Decline</button>
      </div>
    </li>`).join('');
}

inviteList.addEventListener('click', async (event) => {
  const accept = event.target.closest('[data-accept]');
  const decline = event.target.closest('[data-decline]');
  if (!accept && !decline) return;
  const id = Number(accept ? accept.dataset.accept : decline.dataset.decline);
  const invite = invites.find(i => i.id === id);
  if (!invite) return;

  if (decline) {
    const { error } = await supabase.from('room_invites').update({ status: 'declined' }).eq('id', id);
    if (error) { showToast(error.message, 'error'); return; }
  } else {
    const { error } = await supabase.rpc('accept_invite', { invite_id: id });
    if (error) { showToast(error.message, 'error'); return; }
    const { data: room } = await supabase.from('rooms')
      .select('id, name, description, created_by, kind').eq('id', invite.room_id).single();
    if (room) { addRoom(room); openRoom(room); showToast(`Joined #${room.name}`, 'success'); }
  }
  invites = invites.filter(i => i.id !== id);
  renderInvites();
});

async function refreshMembers() {
  const room = currentRoom;
  const coordinator = isCoordinator(room);
  const [members, pending] = await Promise.all([
    supabase.from('room_members').select('user_id').eq('room_id', room.id),
    coordinator
      ? supabase.from('room_invites').select('invited_user').eq('room_id', room.id).eq('status', 'pending')
      : Promise.resolve({ data: [] })
  ]);
  const memberIds = (members.data || []).map(x => x.user_id);
  const pendingIds = (pending.data || []).map(x => x.invited_user);
  await ensureProfiles([...memberIds, ...pendingIds]);
  const row = (id, tag) => `<li class="roster-item">${avatarHtml(id, 'avatar-sm')}<span class="roster-name">${escapeHtml(nameOf(id))}</span><span class="roster-room">${tag}</span></li>`;
  $('#member-list').innerHTML =
    memberIds.map(id => row(id, id === room.created_by ? 'Coordinator' : 'Member')).join('') +
    pendingIds.map(id => row(id, 'Invited')).join('');
}

$('#members-btn').addEventListener('click', async () => {
  if (currentRoom?.kind !== 'private') return;
  inviteError.textContent = '';
  inviteForm.reset();
  inviteForm.hidden = !isCoordinator(currentRoom);     // only the Coordinator can invite
  $('#members-title').textContent = `#${currentRoom.name}`;
  membersDialog.showModal();
  await refreshMembers();
});
$('#members-close').addEventListener('click', () => membersDialog.close());
membersDialog.addEventListener('click', (e) => { if (e.target === membersDialog) membersDialog.close(); });

inviteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  inviteError.textContent = '';
  const username = inviteInput.value.trim();
  if (!username || !isCoordinator(currentRoom)) return;

  const { data: target } = await supabase.from('profiles')
    .select(PROFILE_COLUMNS).eq('username', username).maybeSingle();
  if (!target) { inviteError.textContent = 'No user with that exact username.'; return; }
  if (target.id === me.id) { inviteError.textContent = 'You are already in this group.'; return; }
  profiles.set(target.id, target);

  const { error } = await supabase.from('room_invites')
    .insert({ room_id: currentRoom.id, invited_user: target.id });
  if (error) {
    inviteError.textContent = error.code === '23505'
      ? `${target.username} already has a pending invitation.`
      : error.code === '42501' ? `${target.username} is already a member.` : error.message;
    return;
  }
  inviteForm.reset();
  showToast(`Invitation sent to ${target.username}`, 'success');
  refreshMembers();
});

/* =====================================================================
   LIVE FEEDS: new rooms, photo changes, "chat cleared" signal
   (started once from init(), after everything above is defined)
   ===================================================================== */
function startLiveFeeds() {
  supabase.channel('rooms-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rooms' },
        (payload) => addRoom(payload.new))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'rooms' },
        (payload) => removeRoom(payload.old.id))
    .subscribe();

  supabase.channel('profiles-feed')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => applyProfile(payload.new))
    .subscribe();

  supabase.channel('invites-feed')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_invites', filter: `invited_user=eq.${me.id}` },
        () => { loadInvites(); showToast('You have a new group invitation', 'info'); })
    .subscribe();
  loadInvites();

  // A tiny "something was deleted" signal. Receivers re-read from the
  // database, so a fake signal can never show fake content.
  adminChannel = supabase.channel('admin-events')
    .on('broadcast', { event: 'chat-cleared' }, () => reloadCurrentRoom())
    .subscribe();
}

init();
