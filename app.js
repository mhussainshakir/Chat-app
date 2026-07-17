// Initialize Firebase with config from config.js
if (window.CHATKARO_CONFIG && window.CHATKARO_CONFIG.firebaseConfig) {
  firebase.initializeApp(window.CHATKARO_CONFIG.firebaseConfig);
}
var auth = firebase.auth();
var db = firebase.firestore();

// Global state
var currentUser = null;
var myProfile = null;
var activeChat = null;
var activeChatName = null;

// Helper: Show screen
function showScreen(screenId) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) {
    screens[i].classList.remove('active');
  }
  var screen = document.getElementById('screen-' + screenId);
  if (screen) screen.classList.add('active');
}

// Helper: Close modal
function closeModal(modalId) {
  var modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('open');
}

// Helper: Close chat
function closeChat() {
  activeChat = null;
  activeChatName = null;
  if (typeof unsubscribeMessages === 'function') {
    unsubscribeMessages();
    unsubscribeMessages = null;
  }
  var chatWindow = document.getElementById('chat-window');
  if (chatWindow) chatWindow.classList.remove('active');
  var emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'flex';
}

// LOGIN FORM
var formLogin = document.getElementById('form-login');
if (formLogin) {
  formLogin.addEventListener('submit', function(e) {
    e.preventDefault();
    var email = document.getElementById('login-email').value.trim();
    var password = document.getElementById('login-password').value;
    var errorEl = document.getElementById('login-error');
    errorEl.textContent = '';

    if (!email || !password) {
      errorEl.textContent = 'Email aur password zaroori hain';
      return;
    }

    auth.signInWithEmailAndPassword(email, password).then(function(result) {
      document.getElementById('login-email').value = '';
      document.getElementById('login-password').value = '';
    }).catch(function(err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

// SIGNUP FORM
var formSignup = document.getElementById('form-signup');
if (formSignup) {
  formSignup.addEventListener('submit', function(e) {
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

    auth.createUserWithEmailAndPassword(email, password).then(function(result) {
      document.getElementById('signup-email').value = '';
      document.getElementById('signup-password').value = '';
      document.getElementById('signup-confirm').value = '';
      showScreen('login');
    }).catch(function(err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

// PROFILE FORM
var formProfile = document.getElementById('form-profile');
if (formProfile) {
  formProfile.addEventListener('submit', function(e) {
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
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function() {
      myProfile = { uid: currentUser.uid, email: currentUser.email.toLowerCase(), name: name };
      document.getElementById('profile-name').value = '';
      loadApp();
    }).catch(function(err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

// ADD CONTACT FORM
var formAddContact = document.getElementById('form-add-contact');
if (formAddContact) {
  formAddContact.addEventListener('submit', function(e) {
    e.preventDefault();
    var email = document.getElementById('add-contact-email').value.trim().toLowerCase();
    var errorEl = document.getElementById('add-contact-error');
    errorEl.textContent = '';

    if (!email) {
      errorEl.textContent = 'Email zaroori hai';
      return;
    }

    if (email === currentUser.email.toLowerCase()) {
      errorEl.textContent = 'Apna hi email add nahi kar sakte';
      return;
    }

    // Find user with this email
    db.collection('users').where('email', '==', email).limit(1).get().then(function(querySnapshot) {
      if (querySnapshot.empty) {
        errorEl.textContent = 'Ye user ChatKaro par nahi hai';
        return;
      }

      var contact = querySnapshot.docs[0].data();
      
      // Add to contacts
      db.collection('users').doc(currentUser.uid).collection('contacts').doc(contact.uid).set({
        uid: contact.uid,
        email: contact.email,
        name: contact.name
      }).then(function() {
        document.getElementById('add-contact-email').value = '';
        closeModal('modal-add-contact');
        loadContacts();
      }).catch(function(err) {
        errorEl.textContent = 'Error: ' + err.message;
      });
    }).catch(function(err) {
      errorEl.textContent = 'Error: ' + err.message;
    });
  });
}

// Get deterministic chat id for two users
function getChatId(uidA, uidB) {
  return uidA < uidB ? uidA + '_' + uidB : uidB + '_' + uidA;
}

// MESSAGE FORM
var formMessage = document.getElementById('message-form');
if (formMessage) {
  formMessage.addEventListener('submit', function(e) {
    e.preventDefault();

    if (!activeChat) return;

    var input = document.getElementById('message-input');
    var text = input.value.trim();

    if (!text) return;

    var chatId = getChatId(currentUser.uid, activeChat);

    db.collection('chats').doc(chatId).collection('messages').add({
      uid: currentUser.uid,
      type: 'text',
      text: text,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function() {
      input.value = '';
    }).catch(function(err) {
      alert('Error: ' + err.message);
    });
  });
}

// IMAGE UPLOAD (Cloudinary)
var btnAttach = document.getElementById('btn-attach');
var fileInput = document.getElementById('file-input');
if (btnAttach && fileInput) {
  btnAttach.addEventListener('click', function() {
    if (!activeChat) return;
    fileInput.click();
  });

  fileInput.addEventListener('change', function() {
    var file = fileInput.files[0];
    fileInput.value = '';
    if (!file || !activeChat) return;

    var cfg = window.CHATKARO_CONFIG;
    if (!cfg || !cfg.CLOUDINARY_CLOUD_NAME || !cfg.CLOUDINARY_UPLOAD_PRESET) {
      alert('Cloudinary configure nahi hai');
      return;
    }

    var chatId = getChatId(currentUser.uid, activeChat);
    var formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', cfg.CLOUDINARY_UPLOAD_PRESET);

    var uploadUrl = 'https://api.cloudinary.com/v1_1/' + cfg.CLOUDINARY_CLOUD_NAME + '/image/upload';

    fetch(uploadUrl, { method: 'POST', body: formData })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.secure_url) {
          throw new Error(data.error && data.error.message ? data.error.message : 'Upload fail hua');
        }
        return db.collection('chats').doc(chatId).collection('messages').add({
          uid: currentUser.uid,
          type: 'image',
          imageUrl: data.secure_url,
          timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
      })
      .catch(function(err) {
        alert('Photo bhejne mein error: ' + err.message);
      });
  });
}

// LOAD APP
function loadApp() {
  showScreen('app');
  
  // Set profile info
  var initials = myProfile.name.charAt(0).toUpperCase();
  var avatarEl = document.getElementById('my-avatar');
  if (avatarEl) avatarEl.textContent = initials;
  
  var nameEl = document.getElementById('my-name');
  if (nameEl) nameEl.textContent = myProfile.name;
  
  var emailEl = document.getElementById('my-email');
  if (emailEl) emailEl.textContent = myProfile.email;
  
  loadContacts();
  setupButtons();
}

// LOAD CONTACTS
function loadContacts() {
  var contactsList = document.getElementById('contacts-list');
  if (!contactsList) return;
  
  db.collection('users').doc(currentUser.uid).collection('contacts').onSnapshot(function(snapshot) {
    contactsList.innerHTML = '';
    
    snapshot.forEach(function(doc) {
      var contact = doc.data();
      var item = document.createElement('div');
      item.className = 'contact-item';
      item.innerHTML = '<div class="avatar">' + contact.name.charAt(0).toUpperCase() + '</div>' +
                       '<div><div class="contact-name">' + contact.name + '</div>' +
                       '<div class="contact-status">Online</div></div>';
      item.addEventListener('click', function() {
        openChat(contact.uid, contact.name);
      });
      contactsList.appendChild(item);
    });
  });
}

// OPEN CHAT
function openChat(uid, name) {
  activeChat = uid;
  activeChatName = name;
  
  var emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.style.display = 'none';
  
  var chatWindow = document.getElementById('chat-window');
  if (chatWindow) chatWindow.classList.add('active');
  
  var chatName = document.getElementById('chat-name');
  if (chatName) chatName.textContent = name;
  
  var chatStatus = document.getElementById('chat-status');
  if (chatStatus) chatStatus.textContent = 'Active now';
  
  loadMessages();
}

// LOAD MESSAGES
var unsubscribeMessages = null;
function loadMessages() {
  if (!activeChat) return;

  var messagesBox = document.getElementById('messages-box');
  if (!messagesBox) return;

  var chatId = getChatId(currentUser.uid, activeChat);

  if (unsubscribeMessages) {
    unsubscribeMessages();
    unsubscribeMessages = null;
  }

  unsubscribeMessages = db.collection('chats').doc(chatId).collection('messages')
    .orderBy('timestamp', 'asc')
    .onSnapshot(function(snapshot) {
      messagesBox.innerHTML = '';

      snapshot.forEach(function(doc) {
        var msg = doc.data();
        var msgEl = document.createElement('div');
        msgEl.className = 'message ' + (msg.uid === currentUser.uid ? 'own' : 'other');

        if (msg.type === 'image' && msg.imageUrl) {
          msgEl.innerHTML = '<div class="message-content message-image"><img src="' + msg.imageUrl + '" alt="photo" loading="lazy" /></div>';
        } else {
          msgEl.innerHTML = '<div class="message-content">' + escapeHtml(msg.text || '') + '</div>';
        }
        messagesBox.appendChild(msgEl);
      });

      // Scroll to bottom
      messagesBox.scrollTop = messagesBox.scrollHeight;
    }, function(err) {
      console.error('Messages error:', err.message);
    });
}

// Setup buttons
function setupButtons() {
  var btnAdd = document.getElementById('btn-add');
  if (btnAdd) {
    btnAdd.addEventListener('click', function() {
      var modal = document.getElementById('modal-add-contact');
      if (modal) modal.classList.add('open');
    });
  }
  
  var btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', function() {
      if (confirm('Logout karein?')) {
        auth.signOut();
      }
    });
  }
  
  var btnTheme = document.getElementById('btn-theme');
  if (btnTheme) {
    btnTheme.addEventListener('click', function() {
      var isDark = document.documentElement.style.filter === 'invert(1)';
      document.documentElement.style.filter = isDark ? 'invert(0)' : 'invert(1)';
    });
  }
}

// Escape HTML
function escapeHtml(text) {
  var map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

// AUTH STATE LISTENER
auth.onAuthStateChanged(function(user) {
  if (user) {
    currentUser = user;
    
    // Check if profile exists
    db.collection('users').doc(user.uid).get().then(function(doc) {
      if (doc.exists) {
        myProfile = doc.data();
        loadApp();
      } else {
        showScreen('profile');
      }
    }).catch(function(err) {
      console.error('Error:', err.message);
    });
  } else {
    currentUser = null;
    myProfile = null;
    activeChat = null;
    showScreen('login');
  }
});
