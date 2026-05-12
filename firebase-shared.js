// ════════════════════════════════════════════════════════════════════════════
//  firebase-shared.js
//  Shared Firebase init + database/storage/auth abstraction for both
//  index.html (customer-facing) and admin.html (CMS).
//
//  Loaded as a regular <script> with type="module" — exposes one global
//  object: window.FB with these methods:
//
//    FB.getDB() ............ synchronous read of current DB (from memory cache)
//    FB.saveDB(db) ......... save full DB to Firestore
//    FB.onDBChange(cb) ..... subscribe to realtime updates from Firestore
//    FB.uploadFile(...) .... upload to Firebase Storage, returns public URL
//    FB.deleteFile(url) .... delete a previously-uploaded file
//    FB.signIn(email,pw) ... admin login via Firebase Auth
//    FB.signOut() .......... admin logout
//    FB.onAuthChange(cb) ... subscribe to auth state changes
//    FB.currentUser() ...... current logged-in user (or null)
//    FB.ready() ............ promise that resolves after initial DB load
//
//  DB shape: identical to the previous localStorage `yyy_db` value. The whole
//  DB is stored in ONE Firestore document at `app/db` for simplicity (a few KB
//  to ~1 MB of mostly-text data). Images are referenced by URL pointing to
//  Firebase Storage, NOT stored inline as base64.
// ════════════════════════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";

// ─── CONFIG (PUBLIC — safe to commit; protection is via Security Rules) ────
const firebaseConfig = {
  apiKey: "AIzaSyCTPhpdN7eynONWvTXCWocLvuwT3K3AWVU",
  authDomain: "yingyingying-sg.firebaseapp.com",
  projectId: "yingyingying-sg",
  storageBucket: "yingyingying-sg.firebasestorage.app",
  messagingSenderId: "451804767814",
  appId: "1:451804767814:web:c83a8b59d8f43803a78c47"
};

// ─── INIT ──────────────────────────────────────────────────────────────────
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs   = getFirestore(app);
const stg  = getStorage(app);

// ─── STATE ─────────────────────────────────────────────────────────────────
// In-memory mirror of the current DB. Updated whenever Firestore changes.
let _db = null;
let _dbListeners = [];       // callbacks for DB changes
let _authListeners = [];     // callbacks for auth changes
let _readyResolve;
const _readyPromise = new Promise(res => { _readyResolve = res; });
let _isReady = false;

const DB_DOC = doc(fs, 'app', 'db');

// ─── DB API ────────────────────────────────────────────────────────────────
function getDB(){ return _db || {}; }

async function saveDB(newDb){
  // Persist whole document. Firestore writes are atomic per-document.
  _db = newDb;
  try {
    await setDoc(DB_DOC, newDb);
  } catch(err){
    console.error('[FB] saveDB failed:', err);
    throw err;
  }
  // Don't manually fire listeners — Firestore onSnapshot will do that
}

function onDBChange(cb){
  _dbListeners.push(cb);
  if(_db) cb(_db);   // fire immediately if we already have data
  return () => {     // unsubscribe function
    _dbListeners = _dbListeners.filter(x => x !== cb);
  };
}

// Subscribe to realtime updates from Firestore.
// Whenever the document changes, _db is updated and listeners are notified.
onSnapshot(DB_DOC, (snap) => {
  if(snap.exists()){
    _db = snap.data();
  } else {
    _db = null;   // doc doesn't exist yet — first run
  }
  _dbListeners.forEach(cb => {
    try { cb(_db); } catch(err){ console.error('[FB] listener error:', err); }
  });
  if(!_isReady){
    _isReady = true;
    _readyResolve(_db);
  }
}, (err) => {
  console.error('[FB] onSnapshot error:', err);
  // Still mark as ready so the page can proceed (with no data)
  if(!_isReady){
    _isReady = true;
    _readyResolve(null);
  }
});

function ready(){ return _readyPromise; }

// ─── STORAGE API ───────────────────────────────────────────────────────────
//  Upload a File (or Blob, or data URL) to a path under /uploads/.
//  Returns the public download URL.
async function uploadFile(fileOrBlob, pathHint){
  let blob;
  if(typeof fileOrBlob === 'string' && fileOrBlob.startsWith('data:')){
    // data URL → convert to Blob
    const res = await fetch(fileOrBlob);
    blob = await res.blob();
  } else {
    blob = fileOrBlob;
  }
  // Generate a unique path: uploads/{timestamp}-{random}.{ext}
  const ext = (pathHint && pathHint.includes('.')) ? pathHint.split('.').pop().toLowerCase() : guessExt(blob.type);
  const safeHint = (pathHint || 'file').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeHint}.${ext}`;
  const ref = storageRef(stg, `uploads/${fname}`);
  await uploadBytes(ref, blob, blob.type ? {contentType: blob.type} : undefined);
  return await getDownloadURL(ref);
}

function guessExt(mimeType){
  if(!mimeType) return 'bin';
  if(mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if(mimeType.includes('png')) return 'png';
  if(mimeType.includes('webp')) return 'webp';
  if(mimeType.includes('gif')) return 'gif';
  if(mimeType.includes('gltf-binary')) return 'glb';
  if(mimeType.includes('gltf')) return 'gltf';
  return 'bin';
}

async function deleteFile(url){
  // Only delete if it's actually a Firebase Storage URL
  if(!url || typeof url !== 'string') return;
  if(!url.includes('firebasestorage.googleapis.com') && !url.includes('firebasestorage.app')){
    return;   // not our file
  }
  try {
    // Extract path from URL — URLs look like:
    // https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded-path>?alt=media&token=...
    const m = url.match(/\/o\/([^?]+)/);
    if(!m) return;
    const path = decodeURIComponent(m[1]);
    await deleteObject(storageRef(stg, path));
  } catch(err){
    // 404 etc. — don't crash, just log
    console.warn('[FB] deleteFile:', err.code || err.message);
  }
}

// ─── AUTH API ──────────────────────────────────────────────────────────────
async function signInUser(email, password){
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

async function signOutUser(){
  await signOut(auth);
}

function onAuthChange(cb){
  _authListeners.push(cb);
  return onAuthStateChanged(auth, cb);
}

function currentUser(){ return auth.currentUser; }

// ─── EXPOSE GLOBALLY ───────────────────────────────────────────────────────
window.FB = {
  getDB, saveDB, onDBChange, ready,
  uploadFile, deleteFile,
  signIn: signInUser,
  signOut: signOutUser,
  onAuthChange,
  currentUser,
};

// Optional debug helper
window.FB._app = app;
window.FB._auth = auth;
window.FB._fs = fs;
window.FB._stg = stg;

console.log('[FB] firebase-shared.js loaded');
