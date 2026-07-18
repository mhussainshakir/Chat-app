// ============ iOS SAFARI VIEWPORT-HEIGHT FIX ============
// 100vh on iPhone Safari includes the address bar, which pushes content
// below the visible screen. This keeps a --vh CSS var in sync with the
// REAL visible height instead.
function setRealVh() {
  document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
}
setRealVh();
window.addEventListener('resize', setRealVh);
window.addEventListener('orientationchange', function () { setTimeout(setRealVh, 150); });

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
  openSidebarMobile();
}

// ============ MOBILE SIDEBAR ============
function isMobileView() {
  return window.innerWidth <= 768;
}

function openSidebarMobile() {
  if (!isMobileView()) return;
  var sidebar = document.querySelector('.sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.add('open');
  if (overlay) overlay.classList.add('open');
}

function closeSidebarMobile() {
  var sidebar = document.querySelector('.sidebar');
  var overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
}

function toggleSidebarMobile() {
  var sidebar = document.querySelector('.sidebar');
  if (sidebar && sidebar.classList.contains('open')) {
    closeSidebarMobile();
  } else {
    openSidebarMobile();
  }
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

function avatarHtml(name, photoUrl) {
  if (photoUrl) {
    return '<img src="' + cloudinaryTransform(photoUrl, 'f_auto,q_auto:good,w_200,h_200,c_fill') + '" alt="" />';
  }
  var initial = (name || '?').charAt(0).toUpperCase();
  return initial;
}

function isAboutValid(profile) {
  if (!profile || !profile.about) return false;
  if (!profile.aboutExpiresAt) return true;
  if (!profile.aboutExpiresAt.toDate) return true;
  return profile.aboutExpiresAt.toDate().getTime() > Date.now();
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
        section.dataset.hasRequests = '0';
        return;
      }
      section.dataset.hasRequests = '1';
      section.style.display = (currentSidebarTab === 'status') ? 'none' : 'block';

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

// ============ IMAGE / DOCUMENT UPLOAD (Cloudinary) ============
var onceModeArmed = false;
var btnOnce = document.getElementById('btn-once');
if (btnOnce) {
  btnOnce.addEventListener('click', function () {
    onceModeArmed = !onceModeArmed;
    btnOnce.classList.toggle('active', onceModeArmed);
    btnOnce.title = onceModeArmed
      ? 'One-time ON — agli photo sirf ek dafa dikhegi'
      : 'One-time photo (sirf ek dafa dikhegi)';
  });
}

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
    var wasOnce = onceModeArmed;
    onceModeArmed = false;
    if (btnOnce) btnOnce.classList.remove('active');

    uploadToCloudinaryFull(file, 'image').then(function (info) {
      var payload = {
        type: 'image',
        imageUrl: info.url,
        fileName: file.name,
        fileSize: info.bytes,
        publicId: info.publicId,
        resourceType: info.resourceType
      };
      if (wasOnce) {
        payload.viewOnce = true;
        payload.viewed = false;
      }
      return sendMessage(payload);
    }).catch(function (err) { alert('Photo bhejne mein error: ' + err.message); });
  });
}

// Send original photo as a document (full quality, no compression/preview conversion)
var btnDocument = document.getElementById('btn-document');
var documentInput = document.getElementById('document-input');
if (btnDocument && documentInput) {
  btnDocument.addEventListener('click', function () {
    if (!activeChatId) return;
    documentInput.click();
  });

  documentInput.addEventListener('change', function () {
    var file = documentInput.files[0];
    documentInput.value = '';
    if (!file || !activeChatId) return;
    uploadToCloudinaryFull(file, 'image').then(function (info) {
      return sendMessage({
        type: 'document',
        documentUrl: info.url,
        fileName: file.name || 'photo.jpg',
        fileSize: info.bytes || file.size || 0,
        publicId: info.publicId,
        resourceType: info.resourceType
      });
    }).catch(function (err) { alert('Document bhejne mein error: ' + err.message); });
  });
}

// Returns just the secure_url (kept for simple/backwards-compatible calls)
function uploadToCloudinary(file, resourceType) {
  return uploadToCloudinaryFull(file, resourceType).then(function (data) { return data.url; });
}

// Returns full upload info so we can later ask the server to delete the exact
// asset from Cloudinary (needed for the Storage Manager / one-time photos).
function uploadToCloudinaryFull(file, resourceType) {
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
      return {
        url: data.secure_url,
        publicId: data.public_id || null,
        resourceType: data.resource_type || resourceType,
        bytes: data.bytes || 0
      };
    });
}

// Inserts a Cloudinary transformation string right after "/upload/" in a secure_url.
// f_auto  -> auto picks a format every device/browser can actually display (fixes HEIC
//            photos from iPhone showing up as a black/broken box on Android & old browsers)
// q_auto  -> smart quality (use "best" for near-lossless / Full HD look)
// w_1920,c_limit -> never upscales, just caps very large camera photos for fast, crisp preview
function cloudinaryTransform(url, transformation) {
  if (!url || url.indexOf('/upload/') === -1) return url;
  return url.replace('/upload/', '/upload/' + transformation + '/');
}

function imagePreviewUrl(url) {
  return cloudinaryTransform(url, 'f_auto,q_auto:best,w_1920,c_limit');
}

function imageFullUrl(url) {
  return cloudinaryTransform(url, 'f_auto,q_100');
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
      uploadToCloudinaryFull(file, 'video').then(function (info) {
        return sendMessage({
          type: 'audio',
          audioUrl: info.url,
          fileSize: info.bytes,
          publicId: info.publicId,
          resourceType: info.resourceType
        });
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

// ============ WHATSAPP-STYLE BOTTOM NAV (Chats / Status tabs) ============
var currentSidebarTab = 'chats';

function wireBottomNav() {
  var nav = document.getElementById('sidebar-bottom-nav');
  if (!nav) return;
  var btns = nav.querySelectorAll('.bottom-nav-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function (e) {
      var btn = e.currentTarget;
      for (var j = 0; j < btns.length; j++) { btns[j].classList.remove('active'); }
      btn.classList.add('active');
      currentSidebarTab = btn.getAttribute('data-tab');
      applySidebarTab();
    });
  }
}

function applySidebarTab() {
  var statusStrip = document.getElementById('status-strip');
  var contactsList = document.getElementById('contacts-list');
  var statusListView = document.getElementById('status-list-view');
  var lockedRow = document.getElementById('locked-chats-row');
  var requestsSection = document.getElementById('requests-section');

  if (currentSidebarTab === 'status') {
    if (statusStrip) statusStrip.style.display = 'none';
    if (contactsList) contactsList.style.display = 'none';
    if (lockedRow) lockedRow.style.display = 'none';
    if (requestsSection) requestsSection.style.display = 'none';
    if (statusListView) statusListView.style.display = 'block';
    renderStatusListView();
  } else {
    if (statusStrip) statusStrip.style.display = 'flex';
    if (contactsList) contactsList.style.display = 'block';
    if (statusListView) statusListView.style.display = 'none';
    if (requestsSection) requestsSection.style.display = requestsSection.dataset.hasRequests === '1' ? 'block' : 'none';
    renderSidebarGroups();
  }
}

function renderStatusListView() {
  var container = document.getElementById('status-list-view');
  if (!container || !currentUser) return;
  container.innerHTML = '';

  var myStatuses = statusesByUser[currentUser.uid] || [];
  var addRow = document.createElement('div');
  addRow.className = 'status-list-row';
  addRow.innerHTML = '<div class="status-ring ' + (myStatuses.length ? 'has-status' : '') + '"><div class="avatar">' +
    (myStatuses.length ? avatarHtml(myProfile.name, myProfile.photoUrl) : '➕') + '</div></div>' +
    '<div><div class="status-list-name">Mera Status</div><div class="status-list-time">' +
    (myStatuses.length ? 'Tap karke dekhein' : 'Status lagane ke liye tap karein') + '</div></div>';
  addRow.addEventListener('click', function () {
    if (myStatuses.length) { openStatusViewer(currentUser.uid); } else { openAddStatusModal(); }
  });
  container.appendChild(addRow);

  var label = document.createElement('div');
  label.className = 'status-list-section-label';
  label.textContent = 'Recent Updates';
  container.appendChild(label);

  var others = Object.keys(statusesByUser).filter(function (uid) {
    return uid !== currentUser.uid && statusesByUser[uid].length > 0;
  });

  if (others.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'status-list-empty';
    empty.textContent = 'Abhi kisi contact ka status nahi hai.';
    container.appendChild(empty);
    return;
  }

  others.forEach(function (uid) {
    var list = statusesByUser[uid];
    var contact = contactsCache[uid];
    var name = contact ? contact.name : (list[0].name || 'User');
    var last = list[list.length - 1];
    var row = document.createElement('div');
    row.className = 'status-list-row';
    row.innerHTML = '<div class="status-ring has-status"><div class="avatar">' + avatarHtml(name, contact ? contact.photoUrl : null) + '</div></div>' +
      '<div><div class="status-list-name">' + escapeHtml(name) + '</div><div class="status-list-time">' + timeAgo(new Date(last.createdAtMs)) + '</div></div>';
    row.addEventListener('click', function () { openStatusViewer(uid); });
    container.appendChild(row);
  });
}

// ============ LOAD APP ============
function loadApp() {
  showScreen('app');

  var initials = myProfile.name.charAt(0).toUpperCase();
  var avatarEl = document.getElementById('my-avatar');
  if (avatarEl) avatarEl.innerHTML = avatarHtml(myProfile.name, myProfile.photoUrl);

  var nameEl = document.getElementById('my-name');
  if (nameEl) nameEl.textContent = myProfile.name;

  var emailEl = document.getElementById('my-email');
  if (emailEl) emailEl.textContent = myProfile.email;

  loadContacts();
  loadGroups();
  openSidebarMobile();
  watchIncomingRequests();
  watchMySentRequests();
  setupButtons();
  wireLockedChatsRow();
  wireBottomNav();
  setupStatusFeature();
  setupStorageManager();
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
var sessionUnlockedLock = false;
var pendingLockUid = null;

function renderSidebar(contactsSnapshot) {
  contactsSnapshotCache = contactsSnapshot;
  var contactsList = document.getElementById('contacts-list');
  if (!contactsList) return;
  contactsList.innerHTML = '';

  var allContacts = [];
  contactsSnapshot.forEach(function (doc) {
    var contact = doc.data();
    contactsCache[contact.uid] = contact;
    allContacts.push(contact);
  });

  var lockedUids = (myProfile && myProfile.lockedChats) || [];
  var visibleContacts = allContacts.filter(function (c) {
    return lockedUids.indexOf(c.uid) === -1 || sessionUnlockedLock;
  });
  var hiddenLockedCount = allContacts.filter(function (c) {
    return lockedUids.indexOf(c.uid) !== -1 && !sessionUnlockedLock;
  }).length;

  // Favorites first
  visibleContacts.sort(function (a, b) {
    var fa = isFavoriteContact(a.uid) ? 0 : 1;
    var fb = isFavoriteContact(b.uid) ? 0 : 1;
    return fa - fb;
  });

  // Locked chats row (only shows when there are hidden or unlocked locked chats)
  var lockedRow = document.getElementById('locked-chats-row');
  var lockedBadge = document.getElementById('locked-chats-badge');
  if (lockedRow) {
    if (lockedUids.length > 0) {
      lockedRow.style.display = 'flex';
      if (lockedBadge) lockedBadge.textContent = sessionUnlockedLock ? 'Unlocked' : String(hiddenLockedCount);
    } else {
      lockedRow.style.display = 'none';
    }
  }

  // Groups first
  groupsCache.forEach(function (g) {
    var item = buildGroupItem(g);
    contactsList.appendChild(item);
  });

  var hasFavorites = visibleContacts.some(function (c) { return isFavoriteContact(c.uid); });
  var favDone = false;
  visibleContacts.forEach(function (contact) {
    if (hasFavorites && isFavoriteContact(contact.uid) && !favDone) {
      var favLabel = document.createElement('div');
      favLabel.className = 'section-label';
      favLabel.textContent = '⭐ Favorites';
      contactsList.appendChild(favLabel);
      favDone = true;
    }
    if (hasFavorites && favDone && !isFavoriteContact(contact.uid)) {
      var allLabel = document.querySelector('.section-label.rest-label');
      if (!allLabel) {
        allLabel = document.createElement('div');
        allLabel.className = 'section-label rest-label';
        allLabel.textContent = 'Sab Chats';
        contactsList.appendChild(allLabel);
      }
      favDone = 'rendered-rest';
    }
    var item = buildContactItem(contact);
    if (lockedUids.indexOf(contact.uid) !== -1 && sessionUnlockedLock) {
      item.classList.add('is-locked-open');
    }
    contactsList.appendChild(item);
  });

  if (allContacts.length === 0 && groupsCache.length === 0) {
    var emptyMsg = document.createElement('p');
    emptyMsg.className = 'hint-text';
    emptyMsg.style.padding = '16px';
    emptyMsg.textContent = 'Abhi koi contact nahi hai. ➕ se add karein.';
    contactsList.appendChild(emptyMsg);
  }
}

function renderSidebarGroups() {
  if (contactsSnapshotCache) renderSidebar(contactsSnapshotCache);
}

function isFavoriteContact(uid) {
  return !!(myProfile && myProfile.favorites && myProfile.favorites.indexOf(uid) !== -1);
}

function isLockedContact(uid) {
  return !!(myProfile && myProfile.lockedChats && myProfile.lockedChats.indexOf(uid) !== -1);
}

function toggleFavorite(uid) {
  var ref = db.collection('users').doc(currentUser.uid);
  if (isFavoriteContact(uid)) {
    myProfile.favorites = (myProfile.favorites || []).filter(function (u) { return u !== uid; });
    ref.update({ favorites: firebase.firestore.FieldValue.arrayRemove(uid) }).catch(function () {});
  } else {
    myProfile.favorites = (myProfile.favorites || []).concat([uid]);
    ref.update({ favorites: firebase.firestore.FieldValue.arrayUnion(uid) }).catch(function () {});
  }
  renderSidebarGroups();
}

function toggleLockChat(uid) {
  if (isLockedContact(uid)) {
    myProfile.lockedChats = (myProfile.lockedChats || []).filter(function (u) { return u !== uid; });
    db.collection('users').doc(currentUser.uid).update({ lockedChats: firebase.firestore.FieldValue.arrayRemove(uid) }).catch(function () {});
    renderSidebarGroups();
    return;
  }
  if (!getStoredPin()) {
    pendingLockUid = uid;
    document.getElementById('set-pin-error').textContent = '';
    document.getElementById('modal-set-pin').classList.add('open');
    return;
  }
  myProfile.lockedChats = (myProfile.lockedChats || []).concat([uid]);
  db.collection('users').doc(currentUser.uid).update({ lockedChats: firebase.firestore.FieldValue.arrayUnion(uid) }).catch(function () {});
  renderSidebarGroups();
}

function buildContactItem(contact) {
  var item = document.createElement('div');
  item.className = 'contact-item';
  var favActive = isFavoriteContact(contact.uid);
  var lockedActive = isLockedContact(contact.uid);
  item.innerHTML =
    '<div class="avatar">' + avatarHtml(contact.name, contact.photoUrl) + '<span class="status-dot" id="dot-' + contact.uid + '"></span></div>' +
    '<div><div class="contact-name">' + escapeHtml(contact.name) + (lockedActive ? ' 🔒' : '') + '</div>' +
    '<div class="contact-status" id="status-' + contact.uid + '">...</div></div>' +
    '<div class="contact-item-actions">' +
      '<button type="button" class="contact-action-btn fav-btn ' + (favActive ? 'active' : '') + '" title="Favorite">' + (favActive ? '⭐' : '☆') + '</button>' +
      '<button type="button" class="contact-action-btn lock-btn ' + (lockedActive ? 'active' : '') + '" title="Lock chat">' + (lockedActive ? '🔒' : '🔓') + '</button>' +
    '</div>';

  item.addEventListener('click', function () {
    openDmChat(contact.uid, contact.name);
  });

  var favBtn = item.querySelector('.fav-btn');
  if (favBtn) {
    favBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleFavorite(contact.uid);
    });
  }
  var lockBtn = item.querySelector('.lock-btn');
  if (lockBtn) {
    lockBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleLockChat(contact.uid);
    });
  }

  db.collection('users').doc(contact.uid).onSnapshot(function (docSnap) {
    if (!docSnap.exists) return;
    var data = docSnap.data();
    var presence = renderPresence(data.lastActive);
    var statusEl = item.querySelector('#status-' + contact.uid) || document.getElementById('status-' + contact.uid);
    var dotEl = item.querySelector('#dot-' + contact.uid) || document.getElementById('dot-' + contact.uid);
    if (statusEl) statusEl.textContent = isAboutValid(data) ? data.about : presence.text;
    if (dotEl) dotEl.classList.toggle('online', presence.online);
    if (data.photoUrl) {
      var avatarDiv = item.querySelector('.avatar');
      if (avatarDiv && !avatarDiv.querySelector('img')) {
        avatarDiv.innerHTML = avatarHtml(contact.name, data.photoUrl) + '<span class="status-dot" id="dot-' + contact.uid + '"></span>';
      }
    }
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
  closeSidebarMobile();
  document.getElementById('chat-name').textContent = name;
  document.getElementById('chat-status').textContent = '';
  var chatAvatarEl = document.getElementById('chat-avatar');
  if (chatAvatarEl) chatAvatarEl.innerHTML = avatarHtml(name, (contactsCache[uid] || {}).photoUrl);

  var headerInfo = document.getElementById('chat-header-info');
  if (headerInfo) {
    headerInfo.onclick = function () { openViewProfile(uid); };
  }

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
        if (!u.exists) return;
        var ud = u.data();
        statusEl.textContent = isAboutValid(ud) ? ud.about : renderPresence(ud.lastActive).text;
        if (chatAvatarEl && ud.photoUrl) chatAvatarEl.innerHTML = avatarHtml(name, ud.photoUrl);
      });
    }
  });

  loadDmMessages(chatId);
}

function openViewProfile(uid) {
  db.collection('users').doc(uid).get().then(function (docSnap) {
    if (!docSnap.exists) return;
    var data = docSnap.data();

    document.getElementById('view-photo').innerHTML = avatarHtml(data.name, data.photoUrl);
    document.getElementById('view-name').textContent = data.name || '';
    var aboutEl = document.getElementById('view-about');
    if (isAboutValid(data)) {
      aboutEl.textContent = data.about;
      aboutEl.style.display = 'block';
    } else {
      aboutEl.style.display = 'none';
    }

    setInfoRow('view-address-row', 'view-address', data.address);
    setInfoRow('view-website-row', 'view-website', data.website);
    setInfoRow('view-hours-row', 'view-hours', data.openingHours);

    document.getElementById('modal-view-profile').classList.add('open');
  });
}

function setInfoRow(rowId, valueId, value) {
  var row = document.getElementById(rowId);
  var valEl = document.getElementById(valueId);
  if (!row || !valEl) return;
  if (value) {
    valEl.textContent = value;
    row.style.display = 'flex';
  } else {
    row.style.display = 'none';
  }
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
  closeSidebarMobile();
  document.getElementById('chat-name').textContent = name;
  var group = groupsCache.filter(function (g) { return g.id === groupId; })[0];
  document.getElementById('chat-status').textContent = group ? group.members.length + ' members' : '';
  var chatAvatarEl = document.getElementById('chat-avatar');
  if (chatAvatarEl) chatAvatarEl.innerHTML = '👥';
  var headerInfo = document.getElementById('chat-header-info');
  if (headerInfo) headerInfo.onclick = null;

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
    var isOnceMessage = msg.type === 'image' && msg.imageUrl && msg.viewOnce;
    if (isOnceMessage) {
      if (isOwn) {
        body = '<div class="message-content message-once ' + (msg.viewed ? '' : '') + '" data-once-self="1">' +
          '<span class="once-icon">👁️</span>' +
          '<span><span class="once-text">One-time photo</span><br/>' +
          '<span class="once-sub">' + (msg.viewed ? 'Dekh li gayi' : 'Abhi tak nahi dekhi gayi') + '</span></span></div>';
      } else if (msg.viewed) {
        body = '<div class="message-content message-once viewed">' +
          '<span class="once-icon">👁️</span>' +
          '<span><span class="once-text">Photo dekhi ja chuki hai</span></span></div>';
      } else {
        body = '<div class="message-content message-once" data-once="1">' +
          '<span class="once-icon">👁️</span>' +
          '<span><span class="once-text">Tap karke dekhein</span><br/>' +
          '<span class="once-sub">Sirf 1 dafa khulegi</span></span></div>';
      }
    } else if (msg.type === 'image' && msg.imageUrl) {
      body = '<div class="message-content message-image"><a href="' + imageFullUrl(msg.imageUrl) + '" target="_blank" rel="noopener"><img src="' + imagePreviewUrl(msg.imageUrl) + '" alt="photo" loading="lazy" /></a></div>';
    } else if (msg.type === 'document' && msg.documentUrl) {
      var docName = escapeHtml(msg.fileName || 'Photo');
      var docSize = formatFileSize(msg.fileSize);
      body = '<div class="message-content message-document">' +
        '<a href="' + msg.documentUrl + '" target="_blank" rel="noopener" download="' + docName + '">' +
        '<span class="doc-icon">📄</span>' +
        '<span class="doc-info"><span class="doc-name">' + docName + '</span>' +
        (docSize ? '<span class="doc-size">' + docSize + ' • Original quality</span>' : '<span class="doc-size">Original quality</span>') +
        '</span><span class="doc-download">⬇</span></a></div>';
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

    if (isOnceMessage && !isOwn && !msg.viewed) {
      var onceEl = msgEl.querySelector('[data-once="1"]');
      if (onceEl) {
        onceEl.addEventListener('click', function () {
          openOnceViewer(msg.imageUrl, doc.ref);
        });
      }
    }
  });

  messagesBox.scrollTop = messagesBox.scrollHeight;
}

// ============ ONE-TIME PHOTO VIEWER ============
function openOnceViewer(imageUrl, msgRef) {
  var viewer = document.getElementById('once-viewer');
  var img = document.getElementById('once-viewer-img');
  if (!viewer || !img) return;
  img.src = imageFullUrl(imageUrl);
  viewer.classList.add('open');

  var closeAndMark = function () {
    viewer.classList.remove('open');
    img.src = '';
    viewer.removeEventListener('click', closeAndMark);
    msgRef.update({ viewed: true, viewedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(function () {});
  };
  viewer.addEventListener('click', closeAndMark);
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

// ============ LOCK CHAT PIN (stored on this device only) ============
function pinStorageKey() {
  return 'chatkaro_pin_' + (currentUser ? currentUser.uid : 'anon');
}

function getStoredPin() {
  try { return localStorage.getItem(pinStorageKey()); } catch (e) { return null; }
}

function setStoredPin(pin) {
  try { localStorage.setItem(pinStorageKey(), pin); } catch (e) {}
}

var formSetPin = document.getElementById('form-set-pin');
if (formSetPin) {
  formSetPin.addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = document.getElementById('set-pin-value').value.trim();
    var confirmPin = document.getElementById('set-pin-confirm').value.trim();
    var errorEl = document.getElementById('set-pin-error');
    errorEl.textContent = '';

    if (!/^\d{4}$/.test(pin)) { errorEl.textContent = 'PIN 4 digit ka hona chahiye'; return; }
    if (pin !== confirmPin) { errorEl.textContent = 'PIN match nahi hua'; return; }

    setStoredPin(pin);
    document.getElementById('set-pin-value').value = '';
    document.getElementById('set-pin-confirm').value = '';
    closeModal('modal-set-pin');

    if (pendingLockUid) {
      var uid = pendingLockUid;
      pendingLockUid = null;
      myProfile.lockedChats = (myProfile.lockedChats || []).concat([uid]);
      db.collection('users').doc(currentUser.uid).update({ lockedChats: firebase.firestore.FieldValue.arrayUnion(uid) }).catch(function () {});
      renderSidebarGroups();
    }
  });
}

var formUnlockPin = document.getElementById('form-unlock-pin');
if (formUnlockPin) {
  formUnlockPin.addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = document.getElementById('unlock-pin-value').value.trim();
    var errorEl = document.getElementById('unlock-pin-error');
    errorEl.textContent = '';

    if (pin === getStoredPin()) {
      sessionUnlockedLock = true;
      document.getElementById('unlock-pin-value').value = '';
      closeModal('modal-unlock-pin');
      renderSidebarGroups();
    } else {
      errorEl.textContent = 'Galat PIN';
    }
  });
}

function wireLockedChatsRow() {
  var row = document.getElementById('locked-chats-row');
  if (!row) return;
  row.addEventListener('click', function () {
    if (sessionUnlockedLock) {
      sessionUnlockedLock = false;
      renderSidebarGroups();
    } else {
      document.getElementById('unlock-pin-error').textContent = '';
      document.getElementById('modal-unlock-pin').classList.add('open');
    }
  });
}

// ============ BUTTONS ============
function setupButtons() {
  var profileCard = document.getElementById('my-profile-card');
  if (profileCard) {
    profileCard.addEventListener('click', openEditProfile);
  }

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

  var btnMenu = document.getElementById('btn-menu');
  if (btnMenu) {
    btnMenu.addEventListener('click', toggleSidebarMobile);
  }

  var sidebarOverlay = document.getElementById('sidebar-overlay');
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebarMobile);
  }

  var btnStorage = document.getElementById('btn-storage');
  if (btnStorage) {
    btnStorage.addEventListener('click', openStorageManager);
  }
}

// ============ STORAGE MANAGER ============
var storageItemsCache = [];
var storageSelectedKeys = {};

function setupStorageManager() {
  var selectAll = document.getElementById('storage-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', function () {
      storageSelectedKeys = {};
      if (selectAll.checked) {
        storageItemsCache.forEach(function (it, idx) { storageSelectedKeys[idx] = true; });
      }
      renderStorageGrid();
    });
  }

  var btnDeleteSelected = document.getElementById('btn-delete-selected');
  if (btnDeleteSelected) {
    btnDeleteSelected.addEventListener('click', deleteSelectedStorageItems);
  }
}

function openStorageManager() {
  document.getElementById('modal-storage').classList.add('open');
  var summary = document.getElementById('storage-summary');
  var grid = document.getElementById('storage-grid');
  if (summary) summary.textContent = 'Load ho raha hai...';
  if (grid) grid.innerHTML = '';
  storageSelectedKeys = {};
  var selectAll = document.getElementById('storage-select-all');
  if (selectAll) selectAll.checked = false;

  scanAllMedia().then(function (items) {
    storageItemsCache = items;
    renderStorageGrid();
    updateStorageSummary();
  }).catch(function (err) {
    if (summary) summary.textContent = 'Error: ' + err.message;
  });
}

// Gathers every image/document/audio message across all of this user's DMs and groups
function scanAllMedia() {
  var results = [];
  var refs = [];

  Object.keys(contactsCache).forEach(function (uid) {
    var chatId = getChatId(currentUser.uid, uid);
    refs.push(db.collection('chats').doc(chatId).collection('messages').where('type', 'in', ['image', 'document', 'audio']));
  });
  groupsCache.forEach(function (g) {
    refs.push(db.collection('groups').doc(g.id).collection('messages').where('type', 'in', ['image', 'document', 'audio']));
  });

  var promises = refs.map(function (ref) {
    return ref.get().then(function (snap) {
      snap.forEach(function (doc) {
        var msg = doc.data();
        if (!msg.publicId) return; // older messages uploaded before Storage Manager can't be safely deleted from Cloudinary
        results.push({
          docRef: doc.ref,
          type: msg.type,
          previewUrl: msg.imageUrl || msg.documentUrl || msg.audioUrl,
          fileName: msg.fileName || (msg.type === 'audio' ? 'Voice message' : 'Photo'),
          fileSize: msg.fileSize || 0,
          publicId: msg.publicId,
          resourceType: msg.resourceType || (msg.type === 'audio' ? 'video' : 'image')
        });
      });
    });
  });

  return Promise.all(promises).then(function () { return results; });
}

function renderStorageGrid() {
  var grid = document.getElementById('storage-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (storageItemsCache.length === 0) {
    grid.innerHTML = '<div class="storage-empty">Koi photo/video/document nahi mila (sirf naye uploads yahan dikhte hain).</div>';
  }

  storageItemsCache.forEach(function (item, idx) {
    var cell = document.createElement('div');
    cell.className = 'storage-item' + (storageSelectedKeys[idx] ? ' selected' : '');

    if (item.type === 'image') {
      cell.innerHTML = '<img src="' + imagePreviewUrl(item.previewUrl) + '" alt="" /><span class="storage-item-check"></span>';
    } else if (item.type === 'audio') {
      cell.innerHTML = '<div class="storage-item-icon">🎤<span class="fname">Voice</span></div><span class="storage-item-check"></span>';
    } else {
      cell.innerHTML = '<div class="storage-item-icon">📄<span class="fname">' + escapeHtml(item.fileName) + '</span></div><span class="storage-item-check"></span>';
    }

    cell.addEventListener('click', function () {
      if (storageSelectedKeys[idx]) { delete storageSelectedKeys[idx]; } else { storageSelectedKeys[idx] = true; }
      renderStorageGrid();
    });

    grid.appendChild(cell);
  });

  updateStorageSummary();
}

function updateStorageSummary() {
  var summary = document.getElementById('storage-summary');
  var btnDeleteSelected = document.getElementById('btn-delete-selected');
  var totalBytes = storageItemsCache.reduce(function (sum, it) { return sum + (it.fileSize || 0); }, 0);
  var selectedCount = Object.keys(storageSelectedKeys).length;
  if (summary) {
    summary.textContent = storageItemsCache.length + ' files • ' + formatFileSize(totalBytes) +
      (selectedCount > 0 ? ' • ' + selectedCount + ' selected' : '');
  }
  if (btnDeleteSelected) btnDeleteSelected.disabled = selectedCount === 0;
}

function deleteSelectedStorageItems() {
  var idxList = Object.keys(storageSelectedKeys);
  if (idxList.length === 0) return;
  if (!confirm(idxList.length + ' files delete karein? Ye Cloudinary storage se bhi hamesha ke liye hat jayenge.')) return;

  var summary = document.getElementById('storage-summary');
  if (summary) summary.textContent = 'Delete ho raha hai...';

  currentUser.getIdToken().then(function (idToken) {
    var deletions = idxList.map(function (idx) {
      var item = storageItemsCache[idx];
      return fetch('/api/delete-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: idToken, publicId: item.publicId, resourceType: item.resourceType })
      }).then(function (res) { return res.json(); }).then(function (result) {
        if (result && result.ok) {
          return item.docRef.delete();
        }
        throw new Error((result && result.error) || 'delete failed');
      });
    });

    return Promise.all(deletions.map(function (p) { return p.catch(function (e) { return e; }); }));
  }).then(function () {
    openStorageManager();
  }).catch(function (err) {
    if (summary) summary.textContent = 'Error: ' + err.message;
  });
}

// ============ STATUS / STORIES ============
var statusesByUser = {};
var statusPendingPhotoUrl = null;
var statusPendingColor = '#00D084';
var statusActiveTab = 'photo';
var STATUS_COLORS = ['#00D084', '#FF3B30', '#0A84FF', '#FF9F0A', '#BF5AF2', '#12151A'];

function statusSeenKey() {
  return 'chatkaro_seen_status_' + (currentUser ? currentUser.uid : 'anon');
}

function getSeenStatusIds() {
  try {
    var raw = localStorage.getItem(statusSeenKey());
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function markStatusSeen(id) {
  var seen = getSeenStatusIds();
  if (seen.indexOf(id) === -1) {
    seen.push(id);
    if (seen.length > 500) seen = seen.slice(seen.length - 500);
    try { localStorage.setItem(statusSeenKey(), JSON.stringify(seen)); } catch (e) {}
  }
}

function setupStatusFeature() {
  wireStatusModal();
  wireStatusViewer();

  db.collection('statuses').orderBy('createdAt', 'desc').limit(200)
    .onSnapshot(function (snapshot) {
      var now = Date.now();
      var byUser = {};
      snapshot.forEach(function (doc) {
        var d = doc.data();
        if (!d.createdAt || !d.createdAt.toDate) return;
        var createdMs = d.createdAt.toDate().getTime();
        if (now - createdMs > 24 * 3600 * 1000) return;
        var isMine = d.uid === currentUser.uid;
        if (!isMine && !contactsCache[d.uid]) return;
        d.id = doc.id;
        d.createdAtMs = createdMs;
        if (!byUser[d.uid]) byUser[d.uid] = [];
        byUser[d.uid].push(d);
      });
      Object.keys(byUser).forEach(function (uid) {
        byUser[uid].sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
      });
      statusesByUser = byUser;
      renderStatusStrip();
      if (currentSidebarTab === 'status') renderStatusListView();
    }, function (err) { console.error('status error', err.message); });
}

function renderStatusStrip() {
  var strip = document.getElementById('status-strip');
  if (!strip) return;
  strip.innerHTML = '';

  var addBubble = document.createElement('div');
  addBubble.className = 'status-bubble';
  addBubble.innerHTML = '<div class="status-ring"><div class="avatar">➕</div></div><div class="status-bubble-label">Add</div>';
  addBubble.addEventListener('click', openAddStatusModal);
  strip.appendChild(addBubble);

  var seen = getSeenStatusIds();
  var myStatuses = statusesByUser[currentUser.uid] || [];
  if (myStatuses.length > 0) {
    var allSeenMine = myStatuses.every(function (s) { return seen.indexOf(s.id) !== -1; });
    var mine = document.createElement('div');
    mine.className = 'status-bubble';
    mine.innerHTML = '<div class="status-ring has-status ' + (allSeenMine ? 'seen' : '') + '"><div class="avatar">' +
      avatarHtml(myProfile.name, myProfile.photoUrl) + '</div></div><div class="status-bubble-label">Mera Status</div>';
    mine.addEventListener('click', function () { openStatusViewer(currentUser.uid); });
    strip.appendChild(mine);
  }

  Object.keys(statusesByUser).forEach(function (uid) {
    if (uid === currentUser.uid) return;
    var list = statusesByUser[uid];
    if (!list || list.length === 0) return;
    var contact = contactsCache[uid];
    var name = contact ? contact.name : (list[0].name || 'User');
    var allSeen = list.every(function (s) { return seen.indexOf(s.id) !== -1; });
    var b = document.createElement('div');
    b.className = 'status-bubble';
    b.innerHTML = '<div class="status-ring has-status ' + (allSeen ? 'seen' : '') + '"><div class="avatar">' +
      avatarHtml(name, contact ? contact.photoUrl : null) + '</div></div><div class="status-bubble-label">' + escapeHtml(name) + '</div>';
    b.addEventListener('click', function () { openStatusViewer(uid); });
    strip.appendChild(b);
  });
}

// ---- Add status modal ----
function wireStatusModal() {
  var tabPhoto = document.getElementById('tab-photo-status');
  var tabText = document.getElementById('tab-text-status');
  var photoPanel = document.getElementById('status-photo-panel');
  var textPanel = document.getElementById('status-text-panel');

  if (tabPhoto && tabText) {
    tabPhoto.addEventListener('click', function () {
      statusActiveTab = 'photo';
      tabPhoto.classList.add('active');
      tabText.classList.remove('active');
      photoPanel.style.display = 'block';
      textPanel.style.display = 'none';
    });
    tabText.addEventListener('click', function () {
      statusActiveTab = 'text';
      tabText.classList.add('active');
      tabPhoto.classList.remove('active');
      textPanel.style.display = 'block';
      photoPanel.style.display = 'none';
    });
  }

  var colorPicker = document.getElementById('status-color-picker');
  if (colorPicker) {
    colorPicker.innerHTML = '';
    STATUS_COLORS.forEach(function (color, i) {
      var sw = document.createElement('div');
      sw.className = 'status-color-swatch' + (i === 0 ? ' selected' : '');
      sw.style.background = color;
      sw.addEventListener('click', function () {
        statusPendingColor = color;
        colorPicker.querySelectorAll('.status-color-swatch').forEach(function (s) { s.classList.remove('selected'); });
        sw.classList.add('selected');
      });
      colorPicker.appendChild(sw);
    });
  }

  var btnPick = document.getElementById('btn-pick-status-photo');
  var photoInput = document.getElementById('status-photo-input');
  if (btnPick && photoInput) {
    btnPick.addEventListener('click', function () { photoInput.click(); });
    photoInput.addEventListener('change', function () {
      var file = photoInput.files[0];
      photoInput.value = '';
      if (!file) return;
      var errorEl = document.getElementById('add-status-error');
      errorEl.textContent = 'Upload ho raha hai...';
      uploadToCloudinary(file, 'image').then(function (url) {
        statusPendingPhotoUrl = url;
        document.getElementById('status-photo-preview').innerHTML = '<img src="' + imagePreviewUrl(url) + '" alt="" />';
        errorEl.textContent = '';
      }).catch(function (err) { errorEl.textContent = 'Error: ' + err.message; });
    });
  }

  var btnPost = document.getElementById('btn-post-status');
  if (btnPost) {
    btnPost.addEventListener('click', function () {
      var errorEl = document.getElementById('add-status-error');
      errorEl.textContent = '';
      var payload = {
        uid: currentUser.uid,
        name: myProfile.name,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      if (statusActiveTab === 'photo') {
        if (!statusPendingPhotoUrl) { errorEl.textContent = 'Pehle photo chunein'; return; }
        payload.photoUrl = statusPendingPhotoUrl;
      } else {
        var text = document.getElementById('status-text-value').value.trim();
        if (!text) { errorEl.textContent = 'Kuch likhein'; return; }
        payload.text = text;
        payload.bgColor = statusPendingColor;
      }
      db.collection('statuses').add(payload).then(function () {
        statusPendingPhotoUrl = null;
        document.getElementById('status-photo-preview').innerHTML = '';
        document.getElementById('status-text-value').value = '';
        closeModal('modal-add-status');
      }).catch(function (err) { errorEl.textContent = 'Error: ' + err.message; });
    });
  }
}

function openAddStatusModal() {
  document.getElementById('add-status-error').textContent = '';
  document.getElementById('modal-add-status').classList.add('open');
}

// ---- Full-screen status viewer ----
var currentViewerList = [];
var currentViewerIndex = 0;
var viewerTimer = null;

function openStatusViewer(uid) {
  var list = statusesByUser[uid];
  if (!list || list.length === 0) return;
  currentViewerList = list;
  currentViewerIndex = 0;
  document.getElementById('status-viewer').classList.add('open');
  buildViewerProgress();
  showViewerSlide();
}

function buildViewerProgress() {
  var progress = document.getElementById('status-viewer-progress');
  if (!progress) return;
  progress.innerHTML = '';
  currentViewerList.forEach(function () {
    var seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = '<div class="fill"></div>';
    progress.appendChild(seg);
  });
}

function showViewerSlide() {
  var slide = currentViewerList[currentViewerIndex];
  if (!slide) { closeStatusViewer(); return; }
  markStatusSeen(slide.id);

  var body = document.getElementById('status-viewer-body');
  body.innerHTML = '';
  if (slide.photoUrl) {
    var img = document.createElement('img');
    img.src = imageFullUrl(slide.photoUrl);
    body.appendChild(img);
  } else {
    var div = document.createElement('div');
    div.className = 'status-viewer-text-slide';
    div.style.background = slide.bgColor || '#00D084';
    div.textContent = slide.text || '';
    body.appendChild(div);
  }

  var contact = contactsCache[slide.uid];
  var isMine = slide.uid === currentUser.uid;
  var name = isMine ? 'Aap' : (contact ? contact.name : (slide.name || 'User'));
  document.getElementById('status-viewer-name').textContent = name;
  document.getElementById('status-viewer-time').textContent = timeAgo(new Date(slide.createdAtMs));
  document.getElementById('status-viewer-avatar').innerHTML =
    avatarHtml(name, isMine ? myProfile.photoUrl : (contact ? contact.photoUrl : null));

  var segs = document.querySelectorAll('#status-viewer-progress .seg');
  for (var i = 0; i < segs.length; i++) {
    segs[i].classList.toggle('done', i <= currentViewerIndex);
  }

  if (viewerTimer) clearTimeout(viewerTimer);
  viewerTimer = setTimeout(nextViewerSlide, slide.photoUrl ? 5000 : 4000);
}

function nextViewerSlide() {
  currentViewerIndex++;
  if (currentViewerIndex >= currentViewerList.length) { closeStatusViewer(); return; }
  showViewerSlide();
}

function closeStatusViewer() {
  if (viewerTimer) clearTimeout(viewerTimer);
  var viewer = document.getElementById('status-viewer');
  if (viewer) viewer.classList.remove('open');
  renderStatusStrip();
  if (currentSidebarTab === 'status') renderStatusListView();
}

function wireStatusViewer() {
  var body = document.getElementById('status-viewer-body');
  if (body) body.addEventListener('click', nextViewerSlide);
  var closeBtn = document.getElementById('status-viewer-close');
  if (closeBtn) closeBtn.addEventListener('click', closeStatusViewer);
}

// ============ EDIT PROFILE ============
var pendingPhotoUrl = null;

function openEditProfile() {
  pendingPhotoUrl = myProfile.photoUrl || null;
  document.getElementById('edit-photo-preview').innerHTML = avatarHtml(myProfile.name, myProfile.photoUrl);
  document.getElementById('edit-name').value = myProfile.name || '';
  document.getElementById('edit-about').value = myProfile.about || '';
  document.getElementById('edit-address').value = myProfile.address || '';
  document.getElementById('edit-website').value = myProfile.website || '';
  document.getElementById('edit-hours').value = myProfile.openingHours || '';
  document.getElementById('edit-profile-error').textContent = '';
  document.getElementById('modal-edit-profile').classList.add('open');
}

var btnChangePhoto = document.getElementById('btn-change-photo');
var editPhotoInput = document.getElementById('edit-photo-input');
if (btnChangePhoto && editPhotoInput) {
  btnChangePhoto.addEventListener('click', function () { editPhotoInput.click(); });
  editPhotoInput.addEventListener('change', function () {
    var file = editPhotoInput.files[0];
    editPhotoInput.value = '';
    if (!file) return;
    var errorEl = document.getElementById('edit-profile-error');
    errorEl.textContent = 'Photo upload ho rahi hai...';
    uploadToCloudinary(file, 'image').then(function (url) {
      pendingPhotoUrl = url;
      document.getElementById('edit-photo-preview').innerHTML = avatarHtml(myProfile.name, url);
      errorEl.textContent = '';
    }).catch(function (err) {
      errorEl.textContent = 'Photo error: ' + err.message;
    });
  });
}

var formEditProfile = document.getElementById('form-edit-profile');
if (formEditProfile) {
  formEditProfile.addEventListener('submit', function (e) {
    e.preventDefault();
    var errorEl = document.getElementById('edit-profile-error');
    errorEl.textContent = '';

    var name = document.getElementById('edit-name').value.trim();
    var about = document.getElementById('edit-about').value.trim();
    var durationHrs = parseInt(document.getElementById('edit-about-duration').value, 10);
    var address = document.getElementById('edit-address').value.trim();
    var website = document.getElementById('edit-website').value.trim();
    var hours = document.getElementById('edit-hours').value.trim();

    if (!name) { errorEl.textContent = 'Naam zaroori hai'; return; }

    var updateData = {
      name: name,
      about: about,
      address: address,
      website: website,
      openingHours: hours,
      photoUrl: pendingPhotoUrl || null
    };

    if (about && durationHrs > 0) {
      updateData.aboutExpiresAt = firebase.firestore.Timestamp.fromMillis(Date.now() + durationHrs * 3600000);
    } else {
      updateData.aboutExpiresAt = null;
    }

    db.collection('users').doc(currentUser.uid).set(updateData, { merge: true }).then(function () {
      myProfile = Object.assign ? Object.assign({}, myProfile, updateData) : mergeObj(myProfile, updateData);
      var nameEl = document.getElementById('my-name');
      if (nameEl) nameEl.textContent = myProfile.name;
      var avatarEl = document.getElementById('my-avatar');
      if (avatarEl) avatarEl.innerHTML = avatarHtml(myProfile.name, myProfile.photoUrl);
      closeModal('modal-edit-profile');
    }).catch(function (err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

function mergeObj(base, extra) {
  var out = {};
  for (var k in base) { if (base.hasOwnProperty(k)) out[k] = base[k]; }
  for (var k2 in extra) { if (extra.hasOwnProperty(k2)) out[k2] = extra[k2]; }
  return out;
}
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
