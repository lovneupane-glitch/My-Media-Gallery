import { auth, db } from "./firebase.js";

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";

import {
  collection,
  getDocs,
  addDoc,
  serverTimestamp,
  doc,
  getDoc,
  setDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js";

/* --------------------------------------------------
   CONFIGURATION
-------------------------------------------------- */
const cfg = window.APP_CONFIG || {};
const BUCKET = "media";
const FAVORITES_KEY = "myMediaGalleryFavorites";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const ADMIN_UID = cfg.ADMIN_UID || "he7YRHqvXlfwImoNZ6suNuu7XpJ2";

const $ = id => document.getElementById(id);
let allFiles = [];
let currentUserIsAdmin = false;
let activePage = "home";
let storageClient = null;
let driveTokenClient = null;
let driveAccessToken = null;
let driveTokenExpiry = 0;

const requiredIds = [
  "year", "creator-name", "mobile-menu", "sidebar", "sidebar-overlay",
  "close-menu", "page-title", "file-count", "home-page", "media-page",
  "favorites-page", "developer-page", "gallery", "category-gallery",
  "favorites-gallery", "search", "category-search", "media-heading",
  "admin-open", "admin-dialog", "login-panel", "upload-panel", "login-form",
  "upload-form", "logout", "media-file", "media-title", "media-description",
  "media-category", "upload-button", "progress-bar", "upload-status",
  "login-error", "status", "developer-name", "developer-role",
  "developer-about", "edit-developer", "developer-form", "dev-name-input",
  "dev-role-input", "dev-about-input", "developer-status",
  "cancel-developer", "media-viewer", "viewer-title", "viewer-content",
  "viewer-description", "viewer-download", "viewer-close", "dialog-close"
];
const missing = requiredIds.filter(id => !$(id));
if (missing.length) {
  console.error("Missing HTML elements:", missing);
  throw new Error("Some required HTML elements are missing. Check index.html.");
}

/* --------------------------------------------------
   INITIAL SETUP / HELPERS
-------------------------------------------------- */
$("year").textContent = new Date().getFullYear();
$("creator-name").textContent = cfg.CREATOR_NAME || "The site owner";
const adminDialog = $("admin-dialog");
const mediaViewer = $("media-viewer");

function showStatus(message) {
  $("status").textContent = message;
  $("status").hidden = false;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}
function mediaKind(category) {
  const value = String(category || "").toLowerCase();
  if (value === "video" || value === "videos") return "video";
  if (value === "audio" || value === "audios") return "audio";
  return "image";
}
function formatDate(value) {
  if (!value) return "Recently added";
  const date = value.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently added";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function isDriveFile(file) {
  return file.storage_provider === "google_drive" || Boolean(file.drive_file_id);
}
function driveFileId(file) {
  return file.drive_file_id || file.storage_path || "";
}
function drivePublicUrl(id) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
}

/* --------------------------------------------------
   FAVORITES
-------------------------------------------------- */
function getFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch { return []; }
}
function saveFavorites(favorites) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  updateFavoriteCount();
}
function isFavorite(id) { return getFavorites().includes(id); }
function toggleFavorite(id) {
  const favorites = getFavorites();
  const updated = favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id];
  saveFavorites(updated);
  renderAll();
  showStatus(updated.includes(id) ? "Added to Favorites." : "Removed from Favorites.");
}
function updateFavoriteCount() { $("favorite-count").textContent = getFavorites().length; }

/* --------------------------------------------------
   NAVIGATION
-------------------------------------------------- */
const pageIds = {
  home: "home-page", Photos: "media-page", Videos: "media-page",
  Audio: "media-page", favorites: "favorites-page", developer: "developer-page"
};
function openPage(page) {
  if (!pageIds[page]) return;
  activePage = page;
  document.querySelectorAll(".page").forEach(section => section.classList.remove("active"));
  $(pageIds[page]).classList.add("active");
  document.querySelectorAll("[data-page]").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  const titles = {
    home: "Home", Photos: "Photos", Videos: "Videos", Audio: "Audio",
    favorites: "Favorites", developer: "Developer Information"
  };
  $("page-title").textContent = titles[page];
  if (["Photos", "Videos", "Audio"].includes(page)) {
    $("media-heading").textContent = page;
    $("category-search").value = "";
    renderCategory();
  }
  if (page === "favorites") renderFavorites();
  closeSidebar();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.addEventListener("click", event => {
  const button = event.target.closest("[data-page]");
  if (!button) return;
  event.preventDefault();
  openPage(button.dataset.page);
});
function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebar-overlay").classList.add("active");
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-overlay").classList.remove("active");
}
$("mobile-menu").addEventListener("click", openSidebar);
$("close-menu").addEventListener("click", closeSidebar);
$("sidebar-overlay").addEventListener("click", closeSidebar);

/* --------------------------------------------------
   SUPABASE (LEGACY MEDIA)
-------------------------------------------------- */
const supabaseConfigured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes("YOUR-PROJECT") && !cfg.SUPABASE_ANON_KEY.includes("YOUR_");
if (supabaseConfigured && window.supabase) {
  storageClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    accessToken: async () => {
      if (!auth.currentUser) throw new Error("Administrator login required.");
      return await auth.currentUser.getIdToken();
    }
  });
} else {
  console.warn("Supabase is not configured. Existing Supabase-hosted items can still display.");
}

/* --------------------------------------------------
   GOOGLE DRIVE OAUTH + RESUMABLE UPLOADS
-------------------------------------------------- */
function getDriveToken() {
  return new Promise((resolve, reject) => {
    try {
      if (!cfg.GOOGLE_CLIENT_ID) throw new Error("Google Client ID is missing in config.js.");
      if (!window.google?.accounts?.oauth2) throw new Error("Google sign-in library did not load. Refresh and try again.");
      if (driveAccessToken && Date.now() < driveTokenExpiry - 60000) {
        resolve(driveAccessToken);
        return;
      }
      driveTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: cfg.GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: response => {
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }
          driveAccessToken = response.access_token;
          driveTokenExpiry = Date.now() + (Number(response.expires_in || 3600) * 1000);
          resolve(driveAccessToken);
        },
        error_callback: error => reject(new Error(error?.message || "Google authorization was cancelled."))
      });
      driveTokenClient.requestAccessToken({ prompt: "" });
    } catch (error) { reject(error); }
  });
}
async function driveRequest(url, options = {}) {
  const token = await getDriveToken();
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Drive error (${response.status}): ${body.slice(0, 500)}`);
  }
  return response;
}
async function makeDriveFilePublic(fileId) {
  const response = await driveRequest(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" })
  });
  return response.json();
}
async function uploadDriveResumable(file, onProgress) {
  const token = await getDriveToken();
  const metadata = { name: file.name, mimeType: file.type || "application/octet-stream" };
  const start = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,size,webViewLink`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": metadata.mimeType,
      "X-Upload-Content-Length": String(file.size)
    },
    body: JSON.stringify(metadata)
  });
  if (!start.ok) throw new Error(`Could not start Google Drive upload (${start.status}): ${(await start.text()).slice(0, 400)}`);
  const sessionUrl = start.headers.get("Location");
  if (!sessionUrl) throw new Error("Google Drive did not return a resumable upload URL.");

  const chunkSize = 8 * 1024 * 1024; // 8 MiB; multiple of 256 KiB
  let offset = 0;
  let finalData = null;
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);
    const chunk = file.slice(offset, end);
    let response = null;
    let resumeFromServer = false;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        response = await fetch(sessionUrl, {
          method: "PUT",
          headers: { "Content-Range": `bytes ${offset}-${end - 1}/${file.size}` },
          body: chunk
        });
      } catch (networkError) {
        response = null;
      }

      if (response && (response.status === 308 || response.ok)) break;
      if (response && response.status >= 400 && response.status < 500) {
        throw new Error(`Google Drive chunk upload failed (${response.status}): ${(await response.text()).slice(0, 400)}`);
      }

      // Recover the acknowledged byte position after a dropped connection or server error.
      const probe = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes */${file.size}` }
      });
      if (probe.status === 308) {
        const range = probe.headers.get("Range");
        offset = range ? Number(range.match(/-(\\d+)$/)?.[1] || -1) + 1 : 0;
        resumeFromServer = true;
        break;
      }
      if (probe.ok) {
        finalData = await probe.json();
        offset = file.size;
        break;
      }
      if (probe.status >= 400 && probe.status < 500) {
        throw new Error(`Could not resume upload (${probe.status}): ${(await probe.text()).slice(0, 400)}`);
      }
    }

    if (finalData?.id) break;
    if (resumeFromServer) {
      onProgress(Math.min(92, Math.round((offset / file.size) * 92)));
      continue;
    }
    if (!response) throw new Error("Upload connection failed repeatedly. Please try again.");
    if (response.status === 308) {
      const range = response.headers.get("Range");
      offset = range ? Number(range.match(/-(\\d+)$/)?.[1] || -1) + 1 : end;
      onProgress(Math.min(92, Math.round((offset / file.size) * 92)));
      continue;
    }
    if (response.ok) {
      finalData = await response.json();
      offset = end;
      onProgress(94);
      break;
    }
    throw new Error(`Google Drive upload failed (${response.status}).`);
  }
  if (!finalData?.id) throw new Error("Google Drive upload did not return a file ID.");
  await makeDriveFilePublic(finalData.id);
  onProgress(98);
  return finalData;
}

/* --------------------------------------------------
   MEDIA CARDS + RENDERING
-------------------------------------------------- */
function createMediaCard(file) {
  const kind = mediaKind(file.category);
  const url = safeUrl(file.public_url || (isDriveFile(file) ? drivePublicUrl(driveFileId(file)) : ""));
  if (!url) return "";
  const card = document.createElement("article");
  card.className = "media-card";
  let preview = "";
  if (kind === "image") {
    preview = `<img src="${escapeHtml(url)}" alt="${escapeHtml(file.title)}" loading="lazy">`;
  } else if (kind === "video" && isDriveFile(file)) {
    preview = `<iframe class="drive-preview" src="https://drive.google.com/file/d/${encodeURIComponent(driveFileId(file))}/preview" title="${escapeHtml(file.title || "Video preview")}" allow="autoplay"></iframe>`;
  } else if (kind === "video") {
    preview = `<video src="${escapeHtml(url)}" controls preload="metadata"></video>`;
  } else if (isDriveFile(file)) {
    preview = `<iframe class="drive-preview drive-audio-preview" src="https://drive.google.com/file/d/${encodeURIComponent(driveFileId(file))}/preview" title="${escapeHtml(file.title || "Audio preview")}"></iframe>`;
  } else {
    preview = `<div class="audio-art">♫</div><audio src="${escapeHtml(url)}" controls preload="metadata"></audio>`;
  }
  const adminControls = currentUserIsAdmin
    ? `<button type="button" class="delete-media-button" data-action="delete" data-id="${escapeHtml(file.id)}">Delete</button>`
    : "";
  card.innerHTML = `
    <div class="preview">${preview}</div>
    <div class="media-card-content">
      <p class="media-date">${escapeHtml(formatDate(file.created_at))}</p>
      <h3>${escapeHtml(file.title || "Untitled")}</h3>
      <p>${escapeHtml(file.description || "No description provided.")}</p>
      <button type="button" data-action="preview" data-id="${escapeHtml(file.id)}">View</button>
      <button type="button" data-action="favorite" data-id="${escapeHtml(file.id)}">
        ${isFavorite(file.id) ? "♥ Saved" : "♡ Favorite"}
      </button>
      <a class="download" href="${escapeHtml(url)}" download="${escapeHtml(file.original_name || file.title || "media")}" target="_blank" rel="noopener">↓ Download</a>
      ${adminControls}
    </div>`;
  return card;
}
function displayFiles(container, files) {
  container.innerHTML = "";
  if (!files.length) {
    container.innerHTML = `<p class="empty-state">No media found.</p>`;
    return;
  }
  files.forEach(file => {
    const card = createMediaCard(file);
    if (card) container.appendChild(card);
  });
}
async function loadFiles() {
  $("gallery").innerHTML = `<p class="empty-state">Loading media...</p>`;
  try {
    const snapshot = await getDocs(collection(db, "media_files"));
    allFiles = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    allFiles.sort((a, b) => {
      const dateA = a.created_at?.toMillis ? a.created_at.toMillis() : new Date(a.created_at || 0).getTime();
      const dateB = b.created_at?.toMillis ? b.created_at.toMillis() : new Date(b.created_at || 0).getTime();
      return dateB - dateA;
    });
    $("file-count").textContent = `${allFiles.length} items`;
    renderAll();
  } catch (error) {
    console.error("Firestore error:", error);
    $("gallery").innerHTML = `<p class="empty-state">Could not load media. Check Firestore permissions.</p>`;
    showStatus(error.message);
  }
}
function renderHome() {
  const query = $("search").value.trim().toLowerCase();
  displayFiles($("gallery"), allFiles.filter(file =>
    [file.title, file.description, file.category].some(value => String(value || "").toLowerCase().includes(query))
  ));
}
function renderCategory() {
  const category = mediaKind(activePage);
  const query = $("category-search").value.trim().toLowerCase();
  displayFiles($("category-gallery"), allFiles.filter(file =>
    mediaKind(file.category) === category &&
    [file.title, file.description].some(value => String(value || "").toLowerCase().includes(query))
  ));
}
function renderFavorites() {
  const favorites = getFavorites();
  displayFiles($("favorites-gallery"), allFiles.filter(file => favorites.includes(file.id)));
}
function renderAll() {
  renderHome();
  renderFavorites();
  if (["Photos", "Videos", "Audio"].includes(activePage)) renderCategory();
  updateFavoriteCount();
}
$("search").addEventListener("input", renderHome);
$("category-search").addEventListener("input", renderCategory);

/* --------------------------------------------------
   DELETE MEDIA (ADMIN ONLY)
-------------------------------------------------- */
async function deleteMedia(file) {
  if (!currentUserIsAdmin || !auth.currentUser || auth.currentUser.uid !== ADMIN_UID) {
    throw new Error("Administrator access is required.");
  }
  if (!window.confirm(`Delete "${file.title || file.original_name || "this media"}"? This cannot be undone.`)) return;
  showStatus("Deleting media...");
  const reference = doc(db, "media_files", file.id);

  // Delete the binary object first. Keep the Firestore record if storage deletion fails.
  if (isDriveFile(file)) {
    const id = driveFileId(file);
    if (!id) throw new Error("Google Drive file ID is missing. Firestore record was kept.");
    await driveRequest(`${DRIVE_API}/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  } else {
    if (!storageClient) throw new Error("Supabase is not configured; cannot delete this legacy file. Firestore record was kept.");
    if (!file.storage_path) throw new Error("Supabase storage path is missing. Firestore record was kept.");
    const { error } = await storageClient.storage.from(BUCKET).remove([file.storage_path]);
    if (error) throw error;
  }

  await deleteDoc(reference);
  allFiles = allFiles.filter(item => item.id !== file.id);
  const favs = getFavorites().filter(id => id !== file.id);
  saveFavorites(favs);
  $("file-count").textContent = `${allFiles.length} items`;
  renderAll();
  showStatus("Media file and Firestore record deleted.");
}

/* --------------------------------------------------
   MEDIA ACTIONS + VIEWER
-------------------------------------------------- */
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const file = allFiles.find(item => item.id === button.dataset.id);
  if (!file) return;
  if (button.dataset.action === "favorite") toggleFavorite(file.id);
  if (button.dataset.action === "preview") openViewer(file);
  if (button.dataset.action === "delete") {
    button.disabled = true;
    try { await deleteMedia(file); }
    catch (error) {
      console.error("Delete error:", error);
      showStatus(`Delete failed: ${error.message}`);
      button.disabled = false;
    }
  }
});
function openViewer(file) {
  const url = safeUrl(file.public_url || (isDriveFile(file) ? drivePublicUrl(driveFileId(file)) : ""));
  if (!url) return;
  const kind = mediaKind(file.category);
  $("viewer-title").textContent = file.title || "Media Preview";
  $("viewer-description").textContent = file.description || "";
  let content = "";
  if (kind === "image") content = `<img src="${escapeHtml(url)}" alt="${escapeHtml(file.title)}">`;
  else if (isDriveFile(file)) content = `<iframe class="drive-viewer" src="https://drive.google.com/file/d/${encodeURIComponent(driveFileId(file))}/preview" title="${escapeHtml(file.title || "Media preview")}" allow="autoplay" allowfullscreen></iframe>`;
  else if (kind === "video") content = `<video src="${escapeHtml(url)}" controls autoplay></video>`;
  else content = `<audio src="${escapeHtml(url)}" controls autoplay></audio>`;
  $("viewer-content").innerHTML = content;
  $("viewer-download").href = url;
  $("viewer-download").download = file.original_name || file.title || "media";
  mediaViewer.showModal();
}
function closeViewer() {
  $("viewer-content").innerHTML = "";
  mediaViewer.close();
}
$("viewer-close").addEventListener("click", closeViewer);

/* --------------------------------------------------
   ADMIN LOGIN
-------------------------------------------------- */
function showAdmin(isLoggedIn) {
  $("login-panel").hidden = isLoggedIn;
  $("upload-panel").hidden = !isLoggedIn;
  $("login-error").textContent = "";
}
$("admin-open").addEventListener("click", () => {
  showAdmin(currentUserIsAdmin);
  adminDialog.showModal();
});
$("dialog-close").addEventListener("click", () => adminDialog.close());
$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("login-error").textContent = "Checking login...";
  try {
    await signInWithEmailAndPassword(auth, $("admin-email").value.trim(), $("admin-password").value);
    $("login-error").textContent = "Login successful. Verifying administrator access...";
  } catch (error) {
    console.error("Login error:", error);
    $("login-error").textContent = "Login failed: " + error.message;
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await signOut(auth);
    showAdmin(false);
    adminDialog.close();
    showStatus("You have signed out.");
  } catch (error) { showStatus(error.message); }
});

/* --------------------------------------------------
   AUTH STATE
-------------------------------------------------- */
onAuthStateChanged(auth, async user => {
  currentUserIsAdmin = false;
  if (user) {
    try {
      const token = await user.getIdTokenResult(true);
      currentUserIsAdmin = user.uid === ADMIN_UID && token.claims.role === "authenticated";
    } catch (error) {
      console.error("Could not verify administrator claim:", error);
    }
  }
  $("edit-developer").hidden = !currentUserIsAdmin;
  if (adminDialog.open) showAdmin(currentUserIsAdmin);
  if (currentUserIsAdmin) loadDeveloperInfo();
  renderAll();
});

/* --------------------------------------------------
   UPLOAD NEW MEDIA TO GOOGLE DRIVE
-------------------------------------------------- */
$("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("media-file").files[0];
  const user = auth.currentUser;
  if (!user || !currentUserIsAdmin || user.uid !== ADMIN_UID) {
    $("upload-status").textContent = "Administrator access is required.";
    return;
  }
  if (!file) return;
  const category = $("media-category").value;
  const expectedType = { Photos: "image/", Videos: "video/", Audio: "audio/" }[category];
  if (!expectedType || !file.type.startsWith(expectedType)) {
    $("upload-status").textContent = "Please select a file matching the selected category.";
    return;
  }
  if (!cfg.GOOGLE_CLIENT_ID) {
    $("upload-status").textContent = "Google Client ID is missing from config.js.";
    return;
  }

  const button = $("upload-button");
  const progress = $("progress-bar");
  button.disabled = true;
  progress.value = 0;
  $("upload-status").textContent = "Connecting to Google Drive...";
  let uploadedDriveId = null;

  try {
    await getDriveToken();
    const uploaded = await uploadDriveResumable(file, value => {
      progress.value = value;
      $("upload-status").textContent = `Uploading to Google Drive... ${value}%`;
    });
    uploadedDriveId = uploaded.id;

    $("upload-status").textContent = "Saving media information...";
    await addDoc(collection(db, "media_files"), {
      title: $("media-title").value.trim(),
      description: $("media-description").value.trim(),
      category: mediaKind(category),
      original_name: file.name,
      storage_provider: "google_drive",
      drive_file_id: uploaded.id,
      storage_path: uploaded.id,
      public_url: drivePublicUrl(uploaded.id),
      mime_type: file.type || uploaded.mimeType || "application/octet-stream",
      file_size: file.size,
      created_at: serverTimestamp()
    });
    progress.value = 100;
    $("upload-status").textContent = "Upload successful!";
    $("upload-form").reset();
    await loadFiles();
  } catch (error) {
    console.error("Upload error:", error);
    $("upload-status").textContent = "Upload failed: " + error.message;
    // If the Drive file uploaded but the Firestore write failed, leave the file in Drive
    // so no data is silently lost. The ID is logged for manual recovery.
    if (uploadedDriveId) console.warn("Drive file uploaded but Firestore save failed. Drive file ID:", uploadedDriveId);
  } finally {
    button.disabled = false;
  }
});

/* --------------------------------------------------
   DEVELOPER INFORMATION
-------------------------------------------------- */
async function loadDeveloperInfo() {
  try {
    const reference = doc(db, "site_info", "developer");
    const snapshot = await getDoc(reference);
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    $("developer-name").textContent = data.name || "Website Developer";
    $("developer-role").textContent = data.role || "";
    $("developer-about").textContent = data.about || "";
    $("dev-name-input").value = data.name || "";
    $("dev-role-input").value = data.role || "";
    $("dev-about-input").value = data.about || "";
  } catch (error) {
    console.error("Developer information loading error:", error);
    $("developer-status").textContent = "Could not load developer information.";
  }
}
$("edit-developer").addEventListener("click", () => {
  if (!currentUserIsAdmin) return;
  $("developer-form").hidden = false;
  $("developer-status").textContent = "";
});
$("cancel-developer").addEventListener("click", () => {
  $("developer-form").hidden = true;
  loadDeveloperInfo();
});
$("developer-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUserIsAdmin || !auth.currentUser) {
    $("developer-status").textContent = "Administrator access is required.";
    return;
  }
  $("developer-status").textContent = "Saving information...";
  try {
    await setDoc(doc(db, "site_info", "developer"), {
      name: $("dev-name-input").value.trim(),
      role: $("dev-role-input").value.trim(),
      about: $("dev-about-input").value.trim(),
      updated_at: serverTimestamp()
    }, { merge: true });
    $("developer-name").textContent = $("dev-name-input").value.trim();
    $("developer-role").textContent = $("dev-role-input").value.trim();
    $("developer-about").textContent = $("dev-about-input").value.trim();
    $("developer-form").hidden = true;
    $("developer-status").textContent = "Developer information saved.";
  } catch (error) {
    console.error("Developer information save error:", error);
    $("developer-status").textContent = "Could not save: " + error.message;
  }
});

/* --------------------------------------------------
   START WEBSITE
-------------------------------------------------- */
updateFavoriteCount();
openPage("home");
loadFiles();
loadDeveloperInfo();
