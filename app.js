// Initialize Firebase with config from config.js
if (window.CHATKARO_CONFIG && window.CHATKARO_CONFIG.firebaseConfig) {
  firebase.initializeApp(window.CHATKARO_CONFIG.firebaseConfig);
}
var auth = firebase.auth();
var db = firebase.firestore();

// ============ GLOBAL STATE ============
var currentUser = null;
var myProfile = null;
var activeChatType = null;   // 'dm' or 'group'
var activeChatId = null;     // contact uid OR group id
var activeChatName = null;

var unsubscribeMessages = null;
var unsubscribeChatDoc = null;
var contactsCache = {};      // uid -> contact data (for group member picker)
var heartbeatTimer = null;
var typingTimeout = null;
var lastTypingSentAt = 0;
var voiceSupported = !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
var mediaRecorder = null;
var recordedChunks = [];
var isRecording = false;

// ============ HELPERS ============
function showScreen(screenId) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) {
    screens[i].classList.remove('active');
  }
  var screen = document.getElementById('screen-' + screenId);
  if (screen) screen.classList.add('active');
}

function closeModal(modalId) {
  var modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('open');
}

function closeChat() {
  activeChatType = null;
  activeChatId = null;
  activeChatName = null;
  if (typeof unsubscribeMessages === 'function') { unsubscribeMessages(); unsubscribeMessages = null; }
  if (typeof unsubscribeChatDoc === 'function') { unsubscribeChatDoc(); unsubscribeChatDoc = null; }
  var chatWindow = document.getElementById('chat-window');
  if (chatWindow) chatWindow.classList.remove('active');
  var emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'flex';
}

function getChatId(uidA, uidB) {
  return uidA < uidB ? uidA + '_' + uidB : uidB + '_' + uidA;
}

function escapeHtml(text) {
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, function (m) { return map[m]; });
}

function timeAgo(dateObj) {
  if (!dateObj) return '';
  var diffMs = Date.now() - dateObj.getTime();
  var mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'abhi';
  if (mins < 60) return mins + ' minute pehle';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + ' ghante pehle';
  var days = Math.floor(hrs / 24);
  return days + ' din pehle';
}

// ============ AUTH FORMS ============
var formLogin = document.getElementById('form-login');
if (formLogin) {
  formLogin.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('login-email').value.trim();
    var password = document.getElementById('login-password').value;
    var errorEl = document.getElementById('login-error');
    errorEl.textContent = '';

    if (!email || !password) {
      errorEl.textContent = 'Email aur password zaroori hain';
      return;
    }

    auth.signInWithEmailAndPassword(email, password).then(function () {
      document.getElementById('login-email').value = '';
      document.getElementById('login-password').value = '';
    }).catch(function (err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

var formSignup = document.getElementById('form-signup');
if (formSignup) {
  formSignup.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('signup-email').value.trim();
    var password = document.getElementById('signup-password').value;
    var confirm = document.getElementById('signup-confirm').value;
    var errorEl = document.getElementById('signup-error');
    errorEl.textContent = '';

    if (!email || !password || !confirm) {
      errorEl.textContent = 'Sab fields zaroori hain';
      return;
    }
    if (password.length < 6) {
      errorEl.textContent = 'Password 6 characters ka hona chahiye';
      return;
    }
    if (password !== confirm) {
      errorEl.textContent = 'Passwords match nahi kar rahe';
      return;
    }

    auth.createUserWithEmailAndPassword(email, password).then(function () {
      document.getElementById('signup-email').value = '';
      document.getElementById('signup-password').value = '';
      document.getElementById('signup-confirm').value = '';
      showScreen('login');
    }).catch(function (err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

var formProfile = document.getElementById('form-profile');
if (formProfile) {
  formProfile.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('profile-name').value.trim();
    var errorEl = document.getElementById('profile-error');
    errorEl.textContent = '';

    if (!name) {
      errorEl.textContent = 'Naam zaroori hai';
      return;
    }

    var userRef = db.collection('users').doc(currentUser.uid);
    userRef.set({
      uid: currentUser.uid,
      email: currentUser.email.toLowerCase(),
      name: name,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastActive: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      myProfile = { uid: currentUser.uid, email: currentUser.email.toLowerCase(), name: name };
      document.getElementById('profile-name').value = '';
      loadApp();
    }).catch(function (err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

// ============ ADD CONTACT (sends a request) ============
var formAddContact = document.getElementById('form-add-contact');
if (formAddContact) {
  formAddContact.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('add-contact-email').value.trim().toLowerCase();
    var customName = document.getElementById('add-contact-name').value.trim();
    var errorEl = document.getElementById('add-contact-error');
    errorEl.textContent = '';

    if (!email || !customName) {
      errorEl.textContent = 'Sab fields zaroori hain';
      return;
    }
    if (email === currentUser.email.toLowerCase()) {
      errorEl.textContent = 'Apna hi email add nahi kar sakte';
      return;
    }

    db.collection('users').where('email', '==', email).limit(1).get().then(function (querySnapshot) {
      if (querySnapshot.empty) {
        errorEl.textContent = 'Ye user ChatKaro par nahi hai';
        return;
      }

      var target = querySnapshot.docs[0].data();
      var reqId = getChatId(currentUser.uid, target.uid);
      var reqRef = db.collection('contactRequests').doc(reqId);

      reqRef.set({
        fromUid: currentUser.uid,
        fromEmail: myProfile.email,
        fromName: myProfile.name,
        toUid: target.uid,
        toEmail: target.email,
        toName: target.name,
        customName: customName,
        status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        document.getElementById('add-contact-email').value = '';
        document.getElementById('add-contact-name').value = '';
        closeModal('modal-add-contact');
        alert('Request bhej di gayi. Jab wo accept karenge to contact ban jayega.');
      }).catch(function (err) {
        errorEl.textContent = 'Error: ' + err.message;
      });
    }).catch(function (err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

// Watch requests I SENT — auto-save contact on my side once accepted
function watchMySentRequests() {
  db.collection('contactRequests').where('fromUid', '==', currentUser.uid)
    .onSnapshot(function (snapshot) {
      snapshot.forEach(function (change) {
        var reqDoc = change;
        var data = reqDoc.data();
        if (data.status === 'accepted') {
          var contactRef = db.collection('users').doc(currentUser.uid).collection('contacts').doc(data.toUid);
          contactRef.get().then(function (existing) {
            if (!existing.exists) {
              contactRef.set({
                uid: data.toUid,
                email: data.toEmail,
                name: data.customName || data.toName,
                addedAt: firebase.firestore.FieldValue.serverTimestamp()
              });
            }
          });
        }
      });
    }, function (err) { console.error('sent-req error', err.message); });
}

// Watch requests I RECEIVED — show accept/reject UI
function watchIncomingRequests() {
  db.collection('contactRequests').where('toUid', '==', currentUser.uid).where('status', '==', 'pending')
    .onSnapshot(function (snapshot) {
      var section = document.getElementById('requests-section');
      var list = document.getElementById('requests-list');
      if (!section || !list) return;
      list.innerHTML = '';

      if (snapshot.empty) {
        section.style.display = 'none';
        return;
      }
      section.style.display = 'block';

      snapshot.forEach(function (doc) {
        var data = doc.data();
        var item = document.createElement('div');
        item.className = 'request-item';
        item.innerHTML =
          '<div class="request-info">' +
            '<div class="request-name">' + escapeHtml(data.fromName) + '</div>' +
            '<div class="request-email">' + escapeHtml(data.fromEmail) + '</div>' +
          '</div>' +
          '<div class="request-actions">' +
            '<button class="btn-accept">✓</button>' +
            '<button class="btn-reject">✕</button>' +
          '</div>';

        item.querySelector('.btn-accept').addEventListener('click', function () {
          db.collection('users').doc(currentUser.uid).collection('contacts').doc(data.fromUid).set({
            uid: data.fromUid,
            email: data.fromEmail,
            name: data.fromName,
            addedAt: firebase.firestore.FieldValue.serverTimestamp()
          }).then(function () {
            return doc.ref.update({ status: 'accepted', respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
          }).catch(function (err) { alert('Error: ' + err.message); });
        });

        item.querySelector('.btn-reject').addEventListener('click', function () {
          doc.ref.update({ status: 'rejected', respondedAt: firebase.firestore.FieldValue.serverTimestamp() })
            .catch(function (err) { alert('Error: ' + err.message); });
        });

        list.appendChild(item);
      });
    }, function (err) { console.error('incoming-req error', err.message); });
}

// ============ MESSAGE FORM (1-1 and group) ============
var formMessage = document.getElementById('message-form');
if (formMessage) {
  formMessage.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!activeChatId) return;

    var input = document.getElementById('message-input');
    var text = input.value.trim();
    if (!text) return;

    sendMessage({ type: 'text', text: text }).then(function () {
      input.value = '';
      clearTypingSoon();
    }).catch(function (err) { alert('Error: ' + err.message); });
  });

  var msgInput = document.getElementById('message-input');
  if (msgInput) {
    msgInput.addEventListener('input', function () {
      sendTypingSignal();
    });
  }
}

function sendMessage(payload) {
  payload.uid = currentUser.uid;
  payload.timestamp = firebase.firestore.FieldValue.serverTimestamp();
  payload.seen = false;

  if (activeChatType === 'group') {
    payload.senderName = myProfile.name;
    return db.collection('groups').doc(activeChatId).collection('messages').add(payload);
  }
  var chatId = getChatId(currentUser.uid, activeChatId);
  return db.collection('chats').doc(chatId).collection('messages').add(payload);
}

// ============ TYPING INDICATOR ============
function sendTypingSignal() {
  if (activeChatType !== 'dm' || !activeChatId) return;
  var now = Date.now();
  if (now - lastTypingSentAt < 1500) return;
  lastTypingSentAt = now;

  var chatId = getChatId(currentUser.uid, activeChatId);
  db.collection('chats').doc(chatId).set({
    typingUid: currentUser.uid,
    typingAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(clearTypingSoon, 3000);
}

function clearTypingSoon() {
  if (activeChatType !== 'dm' || !activeChatId) return;
  var chatId = getChatId(currentUser.uid, activeChatId);
  db.collection('chats').doc(chatId).set({ typingUid: null }, { merge: true });
}

// ============ IMAGE UPLOAD (Cloudinary) ============
var btnAttach = document.getElementById('btn-attach');
var fileInput = document.getElementById('file-input');
if (btnAttach && fileInput) {
  btnAttach.addEventListener('click', function () {
    if (!activeChatId) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    fileInput.value = '';
    if (!file || !activeChatId) return;
    uploadToCloudinary(file, 'image').then(function (url) {
      return sendMessage({ type: 'image', imageUrl: url });
    }).catch(function (err) { alert('Photo bhejne mein error: ' + err.message); });
  });
}

function uploadToCloudinary(file, resourceType) {
  var cfg = window.CHATKARO_CONFIG;
  if (!cfg || !cfg.CLOUDINARY_CLOUD_NAME || !cfg.CLOUDINARY_UPLOAD_PRESET) {
    return Promise.reject(new Error('Cloudinary configure nahi hai'));
  }
  var formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', cfg.CLOUDINARY_UPLOAD_PRESET);

  var uploadUrl = 'https://api.cloudinary.com/v1_1/' + cfg.CLOUDINARY_CLOUD_NAME + '/' + resourceType + '/upload';

  return fetch(uploadUrl, { method: 'POST', body: formData })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.secure_url) {
        throw new Error(data.error && data.error.message ? data.error.message : 'Upload fail hua');
      }
      return data.secure_url;
    });
}

// ============ VOICE MESSAGES (only where MediaRecorder is supported) ============
var btnMic = document.getElementById('btn-mic');
if (btnMic) {
  if (voiceSupported) {
    btnMic.style.display = 'inline-flex';
    btnMic.addEventListener('click', function () {
      if (!activeChatId) return;
      if (!isRecording) startRecording(); else stopRecording();
    });
  } else {
    btnMic.style.display = 'none';
  }
}

function startRecording() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(stream);
    } catch (err) {
      alert('Voice record support nahi hai is browser mein');
      return;
    }
    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      var blob = new Blob(recordedChunks, { type: 'audio/webm' });
      var file = new File([blob], 'voice-' + Date.now() + '.webm', { type: 'audio/webm' });
      uploadToCloudinary(file, 'video').then(function (url) {
        return sendMessage({ type: 'audio', audioUrl: url });
      }).catch(function (err) { alert('Voice message bhejne mein error: ' + err.message); });
    };
    mediaRecorder.start();
    isRecording = true;
    if (btnMic) { btnMic.classList.add('recording'); btnMic.textContent = '⏹'; }
  }).catch(function () {
    alert('Microphone access nahi mila');
  });
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    if (btnMic) { btnMic.classList.remove('recording'); btnMic.textContent = '🎤'; }
  }
}

// ============ LOAD APP ============
function loadApp() {
  showScreen('app');

  var initials = myProfile.name.charAt(0).toUpperCase();
  var avatarEl = document.getElementById('my-avatar');
  if (avatarEl) avatarEl.textContent = initials;

  var nameEl = document.getElementById('my-name');
  if (nameEl) nameEl.textContent = myProfile.name;

  var emailEl = document.getElementById('my-email');
  if (emailEl) emailEl.textContent = myProfile.email;

  loadContacts();
  loadGroups();
  watchIncomingRequests();
  watchMySentRequests();
  setupButtons();
  startHeartbeat();
}

// ============ PRESENCE (online / last seen) ============
function startHeartbeat() {
  updateLastActive();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(updateLastActive, 20000);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') updateLastActive();
  });
}

function updateLastActive() {
  if (!currentUser) return;
  db.collection('users').doc(currentUser.uid).set({
    lastActive: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

function renderPresence(lastActiveTimestamp) {
  if (!lastActiveTimestamp || !lastActiveTimestamp.toDate) return { text: 'Offline', online: false };
  var d = lastActiveTimestamp.toDate();
  var diffSec = (Date.now() - d.getTime()) / 1000;
  if (diffSec < 30) return { text: 'Online', online: true };
  return { text: 'Last seen ' + timeAgo(d), online: false };
}

// ============ CONTACTS ============
function loadContacts() {
  var contactsList = document.getElementById('contacts-list');
  if (!contactsList) return;

  db.collection('users').doc(currentUser.uid).collection('contacts').onSnapshot(function (snapshot) {
    contactsCache = {};
    renderSidebar(snapshot);
  });
}

var groupsCache = [];
function loadGroups() {
  db.collection('groups').where('members', 'array-contains', currentUser.uid)
    .onSnapshot(function (snapshot) {
      groupsCache = [];
      snapshot.forEach(function (doc) {
        var g = doc.data();
        g.id = doc.id;
        groupsCache.push(g);
      });
      renderSidebarGroups();
    });
}

var contactsSnapshotCache = null;
function renderSidebar(contactsSnapshot) {
  contactsSnapshotCache = contactsSnapshot;
  var contactsList = document.getElementById('contacts-list');
  if (!contactsList) return;
  contactsList.innerHTML = '';

  // Groups first
  groupsCache.forEach(function (g) {
    var item = buildGroupItem(g);
    contactsList.appendChild(item);
  });

  contactsSnapshot.forEach(function (doc) {
    var contact = doc.data();
    contactsCache[contact.uid] = contact;
    var item = buildContactItem(contact);
    contactsList.appendChild(item);
  });
}

function renderSidebarGroups() {
  if (contactsSnapshotCache) renderSidebar(contactsSnapshotCache);
}

function buildContactItem(contact) {
  var item = document.createElement('div');
  item.className = 'contact-item';
  item.innerHTML =
    '<div class="avatar">' + contact.name.charAt(0).toUpperCase() + '<span class="status-dot" id="dot-' + contact.uid + '"></span></div>' +
    '<div><div class="contact-name">' + escapeHtml(contact.name) + '</div>' +
    '<div class="contact-status" id="status-' + contact.uid + '">...</div></div>';

  item.addEventListener('click', function () {
    openDmChat(contact.uid, contact.name);
  });
  db.collection('users').doc(contact.uid).onSnapshot(function (docSnap) {
    if (!docSnap.exists) return;
    var presence = renderPresence(docSnap.data().lastActive);
    var statusEl = item.querySelector('#status-' + contact.uid) || document.getElementById('status-' + contact.uid);
    var dotEl = item.querySelector('#dot-' + contact.uid) || document.getElementById('dot-' + contact.uid);
    if (statusEl) statusEl.textContent = presence.text;
    if (dotEl) dotEl.classList.toggle('online', presence.online);
  });
  return item;
}

function buildGroupItem(group) {
  var item = document.createElement('div');
  item.className = 'contact-item';
  item.innerHTML =
    '<div class="avatar group-avatar">👥</div>' +
    '<div><div class="contact-name">' + escapeHtml(group.name) + '</div>' +
    '<div class="contact-status">' + group.members.length + ' members</div></div>';
  item.addEventListener('click', function () {
    openGroupChat(group.id, group.name);
  });
  return item;
}

// ============ OPEN CHAT (DM) ============
function openDmChat(uid, name) {
  activeChatType = 'dm';
  activeChatId = uid;
  activeChatName = name;

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-window').classList.add('active');
  document.getElementById('chat-name').textContent = name;
  document.getElementById('chat-status').textContent = '';

  var chatId = getChatId(currentUser.uid, uid);

  if (typeof unsubscribeChatDoc === 'function') unsubscribeChatDoc();
  unsubscribeChatDoc = db.collection('chats').doc(chatId).onSnapshot(function (docSnap) {
    var statusEl = document.getElementById('chat-status');
    if (!statusEl) return;
    var data = docSnap.exists ? docSnap.data() : {};
    var isTyping = data.typingUid && data.typingUid !== currentUser.uid && data.typingAt &&
      (Date.now() - data.typingAt.toDate().getTime() < 4000);
    if (isTyping) {
      statusEl.textContent = 'Type kar raha/rahi hai...';
    } else {
      db.collection('users').doc(uid).get().then(function (u) {
        if (u.exists) statusEl.textContent = renderPresence(u.data().lastActive).text;
      });
    }
  });

  loadDmMessages(chatId);
}

function loadDmMessages(chatId) {
  var messagesBox = document.getElementById('messages-box');
  if (!messagesBox) return;

  if (typeof unsubscribeMessages === 'function') { unsubscribeMessages(); unsubscribeMessages = null; }

  unsubscribeMessages = db.collection('chats').doc(chatId).collection('messages')
    .orderBy('timestamp', 'asc')
    .onSnapshot(function (snapshot) {
      renderMessages(snapshot, messagesBox, false);
      markMessagesSeen(snapshot, chatId);
    }, function (err) { console.error('Messages error:', err.message); });
}

function markMessagesSeen(snapshot, chatId) {
  snapshot.forEach(function (doc) {
    var msg = doc.data();
    if (msg.uid !== currentUser.uid && msg.seen === false) {
      doc.ref.update({ seen: true }).catch(function () {});
    }
  });
}

// ============ OPEN CHAT (GROUP) ============
function openGroupChat(groupId, name) {
  activeChatType = 'group';
  activeChatId = groupId;
  activeChatName = name;

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-window').classList.add('active');
  document.getElementById('chat-name').textContent = name;
  var group = groupsCache.filter(function (g) { return g.id === groupId; })[0];
  document.getElementById('chat-status').textContent = group ? group.members.length + ' members' : '';

  if (typeof unsubscribeChatDoc === 'function') { unsubscribeChatDoc(); unsubscribeChatDoc = null; }

  var messagesBox = document.getElementById('messages-box');
  if (typeof unsubscribeMessages === 'function') { unsubscribeMessages(); unsubscribeMessages = null; }

  unsubscribeMessages = db.collection('groups').doc(groupId).collection('messages')
    .orderBy('timestamp', 'asc')
    .onSnapshot(function (snapshot) {
      renderMessages(snapshot, messagesBox, true);
    }, function (err) { console.error('Group messages error:', err.message); });
}

// ============ RENDER MESSAGES (shared by DM + group) ============
function renderMessages(snapshot, messagesBox, isGroup) {
  messagesBox.innerHTML = '';

  snapshot.forEach(function (doc) {
    var msg = doc.data();
    var isOwn = msg.uid === currentUser.uid;
    var msgEl = document.createElement('div');
    msgEl.className = 'message ' + (isOwn ? 'own' : 'other');

    var senderLabel = (isGroup && !isOwn) ? '<div class="sender-name">' + escapeHtml(msg.senderName || '') + '</div>' : '';
    var body = '';
    if (msg.type === 'image' && msg.imageUrl) {
      body = '<div class="message-content message-image"><img src="' + msg.imageUrl + '" alt="photo" loading="lazy" /></div>';
    } else if (msg.type === 'audio' && msg.audioUrl) {
      body = '<div class="message-content message-audio"><audio controls src="' + msg.audioUrl + '"></audio></div>';
    } else {
      body = '<div class="message-content">' + escapeHtml(msg.text || '') + '</div>';
    }

    var tick = '';
    if (isOwn && !isGroup) {
      tick = '<span class="tick ' + (msg.seen ? 'seen' : '') + '">' + (msg.seen ? '✓✓' : '✓') + '</span>';
    }

    msgEl.innerHTML = senderLabel + body + tick;
    messagesBox.appendChild(msgEl);
  });

  messagesBox.scrollTop = messagesBox.scrollHeight;
}

// ============ NEW GROUP MODAL ============
var formNewGroup = document.getElementById('form-new-group');
if (formNewGroup) {
  formNewGroup.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('group-name').value.trim();
    var errorEl = document.getElementById('group-error');
    errorEl.textContent = '';

    if (!name) { errorEl.textContent = 'Group ka naam zaroori hai'; return; }

    var checked = document.querySelectorAll('#group-members-list input[type=checkbox]:checked');
    var members = [currentUser.uid];
    checked.forEach(function (cb) { members.push(cb.value); });

    if (members.length < 2) { errorEl.textContent = 'Kam se kam 1 member chunein'; return; }

    db.collection('groups').add({
      name: name,
      createdBy: currentUser.uid,
      members: members,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      document.getElementById('group-name').value = '';
      closeModal('modal-new-group');
    }).catch(function (err) { errorEl.textContent = 'Error: ' + err.message; });
  });
}

function openNewGroupModal() {
  var list = document.getElementById('group-members-list');
  if (!list) return;
  list.innerHTML = '';
  var uids = Object.keys(contactsCache);
  if (uids.length === 0) {
    list.innerHTML = '<p class="hint-text">Pehle kuch contacts add karein</p>';
  }
  uids.forEach(function (uid) {
    var contact = contactsCache[uid];
    var row = document.createElement('label');
    row.className = 'member-row';
    row.innerHTML = '<input type="checkbox" value="' + uid + '" /> ' + escapeHtml(contact.name);
    list.appendChild(row);
  });
  document.getElementById('modal-new-group').classList.add('open');
}

// ============ BUTTONS ============
function setupButtons() {
  var btnAdd = document.getElementById('btn-add');
  if (btnAdd) {
    btnAdd.addEventListener('click', function () {
      document.getElementById('modal-add-contact').classList.add('open');
    });
  }

  var btnNewGroup = document.getElementById('btn-new-group');
  if (btnNewGroup) {
    btnNewGroup.addEventListener('click', openNewGroupModal);
  }

  var btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', function () {
      if (confirm('Logout karein?')) {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        auth.signOut();
      }
    });
  }

  var btnTheme = document.getElementById('btn-theme');
  if (btnTheme) {
    btnTheme.addEventListener('click', function () {
      var isDark = document.documentElement.style.filter === 'invert(1)';
      document.documentElement.style.filter = isDark ? 'invert(0)' : 'invert(1)';
    });
  }
}

// ============ AUTH STATE LISTENER ============
auth.onAuthStateChanged(function (user) {
  if (user) {
    currentUser = user;
    db.collection('users').doc(user.uid).get().then(function (doc) {
      if (doc.exists) {
        myProfile = doc.data();
        loadApp();
      } else {
        showScreen('profile');
      }
    }).catch(function (err) {
      console.error('Error:', err.message);
    });
  } else {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    currentUser = null;
    myProfile = null;
    activeChatType = null;
    activeChatId = null;
    showScreen('login');
  }
});
