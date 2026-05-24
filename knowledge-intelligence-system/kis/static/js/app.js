/* ── State ────────────────────────────────────────────────────────── */
let documents    = [];
let selectedDocs = new Set();
let isAsking     = false;

/* ── Init ────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  setupDragDrop();
  setupFileInput();
  loadDocuments();
  loadStats();
});

/* ── Stats ───────────────────────────────────────────────────────── */
async function loadStats() {
  try {
    const res  = await fetch("/api/stats");
    const data = await res.json();
    document.getElementById("statDocs").textContent    = data.total_documents;
    document.getElementById("statChunks").textContent  = data.total_chunks;
    document.getElementById("statVectors").textContent = data.vector_count;
  } catch {}
}

/* ── Document Library ────────────────────────────────────────────── */
async function loadDocuments() {
  try {
    const res  = await fetch("/api/documents");
    const data = await res.json();
    documents  = data.documents;
    renderDocList();
  } catch {
    toast("Failed to load document library", "error");
  }
}

function renderDocList() {
  const list = document.getElementById("docList");
  document.getElementById("docCount").textContent = documents.length;

  if (!documents.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">◻</div>
        <p>No documents indexed yet.<br/>Upload your first file above.</p>
      </div>`;
    return;
  }

  list.innerHTML = documents.map(doc => {
    const ext       = doc.suffix?.replace(".", "") || "txt";
    const selected  = selectedDocs.has(doc.id) ? "selected" : "";
    const date      = new Date(doc.uploaded_at * 1000).toLocaleDateString();
    const size      = formatSize(doc.char_count);
    return `
      <div class="doc-item ${selected}" onclick="toggleDoc('${doc.id}')" data-id="${doc.id}">
        <div class="doc-icon ${ext}">${ext.toUpperCase()}</div>
        <div class="doc-info">
          <div class="doc-name" title="${doc.filename}">${doc.filename}</div>
          <div class="doc-meta">${doc.chunk_count} chunks · ${size} · ${date}</div>
        </div>
        <button class="doc-del" title="Delete" onclick="deleteDoc(event,'${doc.id}')">×</button>
      </div>`;
  }).join("");
}

function formatSize(chars) {
  if (chars > 100000) return (chars / 1000).toFixed(0) + "K chars";
  return chars.toLocaleString() + " chars";
}

function toggleDoc(id) {
  if (selectedDocs.has(id)) selectedDocs.delete(id);
  else selectedDocs.add(id);
  renderDocList();
  updateFilterStatus();
}

function updateFilterStatus() {
  const el = document.getElementById("filterStatus");
  if (selectedDocs.size === 0) {
    el.textContent = "Searching all documents";
  } else {
    el.textContent = `Filtering ${selectedDocs.size} selected document${selectedDocs.size > 1 ? "s" : ""}`;
    el.style.color = "var(--amber)";
  }
  if (selectedDocs.size === 0) el.style.color = "";
}

async function deleteDoc(e, id) {
  e.stopPropagation();
  try {
    const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error();
    selectedDocs.delete(id);
    toast("Document deleted", "success");
    await loadDocuments();
    await loadStats();
  } catch {
    toast("Failed to delete document", "error");
  }
}

/* ── Upload ──────────────────────────────────────────────────────── */
function setupDragDrop() {
  const zone = document.getElementById("uploadZone");
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("drag-over");
    handleFiles(Array.from(e.dataTransfer.files));
  });
}

function setupFileInput() {
  document.getElementById("fileInput").addEventListener("change", e => {
    handleFiles(Array.from(e.target.files));
    e.target.value = "";
  });
}

async function handleFiles(files) {
  for (const file of files) {
    await uploadFile(file);
  }
}

async function uploadFile(file) {
  const queue   = document.getElementById("uploadQueue");
  const itemId  = "q_" + Math.random().toString(36).slice(2);

  queue.insertAdjacentHTML("beforeend", `
    <div class="queue-item" id="${itemId}">
      <div class="q-name">${file.name}</div>
      <div class="q-status uploading" id="${itemId}_s">Uploading…</div>
      <div class="q-progress"><div class="q-progress-bar" id="${itemId}_p" style="width:30%"></div></div>
    </div>`);

  const formData = new FormData();
  formData.append("file", file);

  try {
    document.getElementById(`${itemId}_p`).style.width = "60%";
    const res  = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Upload failed");

    document.getElementById(`${itemId}_p`).style.width = "100%";
    document.getElementById(`${itemId}_s`).textContent  = `✓ ${data.chunk_count} chunks`;
    document.getElementById(`${itemId}_s`).className    = "q-status done";

    toast(`"${file.name}" indexed — ${data.chunk_count} chunks`, "success");
    await loadDocuments();
    await loadStats();

  } catch (err) {
    document.getElementById(`${itemId}_p`).style.background = "var(--red)";
    document.getElementById(`${itemId}_s`).textContent = `✗ ${err.message}`;
    document.getElementById(`${itemId}_s`).className   = "q-status error";
    toast(err.message, "error");
  }

  setTimeout(() => document.getElementById(itemId)?.remove(), 5000);
}

/* ── Q&A ─────────────────────────────────────────────────────────── */
function handleKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askQuestion(); }
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

async function askQuestion() {
  if (isAsking) return;
  const input    = document.getElementById("questionInput");
  const question = input.value.trim();
  if (!question) return;

  isAsking = true;
  input.value = "";
  autoResize(input);
  document.getElementById("sendBtn").disabled = true;

  // Remove welcome message if present
  document.querySelector(".welcome-msg")?.remove();

  const chat = document.getElementById("chatMessages");

  // User bubble
  appendMessage("user", question);

  // Typing indicator
  const typingId = "typing_" + Date.now();
  chat.insertAdjacentHTML("beforeend", `
    <div class="msg assistant" id="${typingId}">
      <div class="msg-label">KIS</div>
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>`);
  chat.scrollTop = chat.scrollHeight;

  try {
    const body = { question };
    if (selectedDocs.size > 0) body.doc_ids = Array.from(selectedDocs);

    const res  = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    document.getElementById(typingId)?.remove();

    if (!res.ok) throw new Error(data.error || "Query failed");

    appendAssistantMessage(data.answer, data.sources, data.chunks_retrieved);

  } catch (err) {
    document.getElementById(typingId)?.remove();
    appendMessage("assistant", `⚠ ${err.message}`);
    toast(err.message, "error");
  }

  isAsking = false;
  document.getElementById("sendBtn").disabled = false;
  input.focus();
}

function appendMessage(role, text) {
  const chat  = document.getElementById("chatMessages");
  const label = role === "user" ? "You" : "KIS";
  chat.insertAdjacentHTML("beforeend", `
    <div class="msg ${role}">
      <div class="msg-label">${label}</div>
      <div class="msg-bubble">${escapeHtml(text)}</div>
    </div>`);
  chat.scrollTop = chat.scrollHeight;
}

function appendAssistantMessage(answer, sources, chunksRetrieved) {
  const chat = document.getElementById("chatMessages");

  const sourcesHtml = sources?.length ? `
    <div class="msg-sources">
      ${sources.map(s => `
        <div class="source-tag">
          ◈ ${escapeHtml(s.filename)}
          <span class="rel">${s.relevance}%</span>
        </div>`).join("")}
    </div>` : "";

  chat.insertAdjacentHTML("beforeend", `
    <div class="msg assistant">
      <div class="msg-label">KIS · ${chunksRetrieved || 0} chunks retrieved</div>
      <div class="msg-bubble">${renderMarkdown(answer)}</div>
      ${sourcesHtml}
    </div>`);
  chat.scrollTop = chat.scrollHeight;
}

function clearChat() {
  const chat = document.getElementById("chatMessages");
  chat.innerHTML = `
    <div class="welcome-msg">
      <div class="welcome-icon">◈</div>
      <h2>Ready to Answer</h2>
      <p>Upload documents on the left, then ask anything about their content. KIS retrieves the most relevant passages and generates cited, precise answers.</p>
      <div class="feature-pills">
        <span>Semantic Search</span>
        <span>Context-Aware</span>
        <span>Source Citations</span>
        <span>Multi-Document</span>
      </div>
    </div>`;
}

/* ── Markdown renderer (lightweight) ─────────────────────────────── */
function renderMarkdown(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // headings
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm,  "<h2>$1</h2>")
    .replace(/^# (.+)$/gm,   "<h1>$1</h1>")
    // bold / italic
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,     "<em>$1</em>")
    // inline code
    .replace(/`(.+?)`/g, "<code>$1</code>")
    // bullets
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>")
    // numbered lists
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    // paragraphs
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br/>")
    .replace(/^(.+)$/, "<p>$1</p>");
}

/* ── Helpers ─────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
