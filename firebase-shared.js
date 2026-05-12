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
//
//  Image files are automatically resized & re-encoded to WebP before upload:
//    - Max dimension: 1920px (preserves aspect ratio)
//    - Quality: 0.85 (visually lossless but ~70-90% smaller than JPEG)
//    - Non-image files (.glb, .gltf, PDFs, etc.) upload as-is.
//
//  This usually cuts a 5MB phone photo to 200-400KB → uploads in seconds
//  on mobile networks and loads much faster for visitors.
async function uploadFile(fileOrBlob, pathHint){
  let blob;
  if(typeof fileOrBlob === 'string' && fileOrBlob.startsWith('data:')){
    const res = await fetch(fileOrBlob);
    blob = await res.blob();
  } else {
    blob = fileOrBlob;
  }

  // Image optimisation: resize big images + convert to WebP. Anything that
  // isn't an image (or is already small) skips this and uploads unchanged.
  if(blob.type && blob.type.startsWith('image/') && !blob.type.includes('svg')){
    try {
      blob = await optimiseImage(blob);
    } catch(err){
      console.warn('[FB] image optimise failed, uploading original:', err);
      // Fall through with original blob
    }
  }

  // Generate a unique path: uploads/{timestamp}-{random}.{ext}
  const ext = guessExtFromBlobOrHint(blob, pathHint);
  const safeHint = (pathHint || 'file').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeHint}.${ext}`;
  const ref = storageRef(stg, `uploads/${fname}`);
  await uploadBytes(ref, blob, blob.type ? {
    contentType: blob.type,
    // Long browser cache (1 year) — files are content-addressed via the
    // random filename, so they never change after upload.
    cacheControl: 'public,max-age=31536000,immutable',
  } : undefined);
  return await getDownloadURL(ref);
}

// Resize & re-encode an image Blob.
//   - Keeps aspect ratio
//   - Caps longest side at MAX_DIM
//   - Output: WebP at QUALITY (PNG with transparency uses 'image/png' instead)
async function optimiseImage(blob){
  const MAX_DIM = 1920;       // longest side
  const QUALITY = 0.85;       // 0–1; 0.85 looks identical to humans for most photos

  // Decode the source image. We use createImageBitmap when available — it's
  // faster than <img> and avoids EXIF orientation issues on most browsers.
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch(_) {
    // Fallback: <img> + ObjectURL
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  const srcW = bitmap.width || bitmap.naturalWidth;
  const srcH = bitmap.height || bitmap.naturalHeight;

  // If the image is already smaller than the cap AND the source is already
  // an efficient format, skip — re-encoding could even make it bigger.
  const alreadySmall = srcW <= MAX_DIM && srcH <= MAX_DIM;
  const isEfficient  = blob.type === 'image/webp';
  if(alreadySmall && isEfficient){
    return blob;
  }

  // Compute target dimensions preserving aspect ratio
  let dstW = srcW, dstH = srcH;
  if(srcW > MAX_DIM || srcH > MAX_DIM){
    const r = Math.min(MAX_DIM / srcW, MAX_DIM / srcH);
    dstW = Math.round(srcW * r);
    dstH = Math.round(srcH * r);
  }

  // Render to canvas at target size
  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  // Better quality for downscale
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, dstW, dstH);

  // PNG with transparency? Keep PNG to avoid alpha loss
  const hasAlpha = blob.type === 'image/png' || blob.type === 'image/gif';
  const outType  = hasAlpha ? 'image/png' : 'image/webp';

  // Encode
  const result = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if(b) resolve(b); else reject(new Error('canvas.toBlob failed'));
    }, outType, QUALITY);
  });

  // Safety check: if encoding made it BIGGER (rare on small files), use original
  if(result.size >= blob.size && alreadySmall){
    return blob;
  }

  console.log(`[FB] image optimised: ${(blob.size/1024).toFixed(0)}KB → ${(result.size/1024).toFixed(0)}KB ` +
              `(${srcW}×${srcH} → ${dstW}×${dstH}, ${outType})`);
  return result;
}

function guessExtFromBlobOrHint(blob, pathHint){
  // Prefer the blob's actual type (after optimisation it might be WebP even
  // though the user uploaded a JPG).
  const t = blob.type || '';
  if(t.includes('webp')) return 'webp';
  if(t.includes('png')) return 'png';
  if(t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if(t.includes('gif')) return 'gif';
  if(t.includes('svg')) return 'svg';
  if(t.includes('gltf-binary')) return 'glb';
  if(t.includes('gltf')) return 'gltf';
  // Last resort: use the hint extension
  if(pathHint && pathHint.includes('.')){
    return pathHint.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'');
  }
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
