import os
import uuid
import json
import time
import hashlib
from pathlib import Path
from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
import chromadb
from chromadb.utils import embedding_functions
from sentence_transformers import SentenceTransformer
import anthropic
import PyPDF2
import docx
import re

# ── Config ────────────────────────────────────────────────────────────────────
BASE_DIR     = Path(__file__).parent
UPLOAD_DIR   = BASE_DIR / "uploads"
CHROMA_DIR   = BASE_DIR / "chroma_db"
CHUNK_SIZE   = 800
CHUNK_OVERLAP = 150
TOP_K        = 5

UPLOAD_DIR.mkdir(exist_ok=True)
CHROMA_DIR.mkdir(exist_ok=True)

# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024   # 50 MB

# ── Embedding model (local, free) ─────────────────────────────────────────────
print("Loading embedding model …")
embedder = SentenceTransformer("all-MiniLM-L6-v2")

def embed_fn(texts):
    return embedder.encode(texts, show_progress_bar=False).tolist()

# ── ChromaDB ──────────────────────────────────────────────────────────────────
chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
collection = chroma_client.get_or_create_collection(
    name="knowledge_base",
    metadata={"hnsw:space": "cosine"},
)

# ── Anthropic client ──────────────────────────────────────────────────────────
anthropic_client = anthropic.Anthropic()   # reads ANTHROPIC_API_KEY from env

# ── Text extraction helpers ───────────────────────────────────────────────────
def extract_text_pdf(path: Path) -> str:
    text = []
    with open(path, "rb") as f:
        reader = PyPDF2.PdfReader(f)
        for page in reader.pages:
            t = page.extract_text()
            if t:
                text.append(t)
    return "\n".join(text)

def extract_text_docx(path: Path) -> str:
    doc = docx.Document(str(path))
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip())

def extract_text_txt(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")

def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return extract_text_pdf(path)
    elif suffix in (".docx", ".doc"):
        return extract_text_docx(path)
    else:
        return extract_text_txt(path)

# ── Chunking ──────────────────────────────────────────────────────────────────
def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP):
    words  = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunk = " ".join(words[i : i + size])
        chunks.append(chunk)
        i += size - overlap
    return [c for c in chunks if len(c.strip()) > 50]

# ── Metadata store (JSON sidecar) ─────────────────────────────────────────────
META_FILE = BASE_DIR / "documents_meta.json"

def load_meta() -> dict:
    if META_FILE.exists():
        return json.loads(META_FILE.read_text())
    return {}

def save_meta(meta: dict):
    META_FILE.write_text(json.dumps(meta, indent=2))

# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/documents", methods=["GET"])
def list_documents():
    meta = load_meta()
    docs = list(meta.values())
    docs.sort(key=lambda d: d.get("uploaded_at", 0), reverse=True)
    return jsonify({"documents": docs, "total": len(docs)})

@app.route("/api/upload", methods=["POST"])
def upload_document():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    allowed = {".pdf", ".txt", ".docx", ".md"}
    suffix  = Path(file.filename).suffix.lower()
    if suffix not in allowed:
        return jsonify({"error": f"Unsupported type: {suffix}. Allowed: {', '.join(allowed)}"}), 400

    doc_id   = str(uuid.uuid4())
    filename = f"{doc_id}{suffix}"
    save_path = UPLOAD_DIR / filename
    file.save(str(save_path))

    # Extract + chunk
    try:
        text   = extract_text(save_path)
        chunks = chunk_text(text)
    except Exception as e:
        save_path.unlink(missing_ok=True)
        return jsonify({"error": f"Text extraction failed: {e}"}), 500

    if not chunks:
        save_path.unlink(missing_ok=True)
        return jsonify({"error": "No readable text found in document"}), 400

    # Embed + store in ChromaDB
    try:
        ids        = [f"{doc_id}_chunk_{i}" for i in range(len(chunks))]
        embeddings = embed_fn(chunks)
        metadatas  = [{"doc_id": doc_id, "filename": file.filename,
                        "chunk_index": i, "total_chunks": len(chunks)}
                       for i in range(len(chunks))]
        collection.add(ids=ids, embeddings=embeddings,
                        documents=chunks, metadatas=metadatas)
    except Exception as e:
        save_path.unlink(missing_ok=True)
        return jsonify({"error": f"Embedding failed: {e}"}), 500

    # Save metadata
    meta = load_meta()
    meta[doc_id] = {
        "id":           doc_id,
        "filename":     file.filename,
        "stored_name":  filename,
        "suffix":       suffix,
        "chunk_count":  len(chunks),
        "char_count":   len(text),
        "uploaded_at":  time.time(),
    }
    save_meta(meta)

    return jsonify({
        "message":     "Document uploaded and indexed successfully",
        "doc_id":      doc_id,
        "filename":    file.filename,
        "chunk_count": len(chunks),
    }), 201

@app.route("/api/ask", methods=["POST"])
def ask_question():
    body = request.get_json(silent=True) or {}
    question = (body.get("question") or "").strip()
    doc_ids  = body.get("doc_ids") or []   # optional filter

    if not question:
        return jsonify({"error": "Question is required"}), 400

    # Embed question
    q_embedding = embed_fn([question])[0]

    # Build where filter
    where = None
    if doc_ids:
        if len(doc_ids) == 1:
            where = {"doc_id": doc_ids[0]}
        else:
            where = {"$or": [{"doc_id": d} for d in doc_ids]}

    # Vector search
    try:
        results = collection.query(
            query_embeddings=[q_embedding],
            n_results=min(TOP_K, collection.count()),
            where=where,
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        return jsonify({"error": f"Retrieval failed: {e}"}), 500

    chunks    = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]

    if not chunks:
        return jsonify({"answer": "No relevant documents found. Please upload documents first.",
                         "sources": []}), 200

    # Build RAG prompt
    context_parts = []
    for i, (chunk, meta) in enumerate(zip(chunks, metadatas)):
        context_parts.append(
            f"[Source {i+1} — {meta['filename']}, chunk {meta['chunk_index']+1}/{meta['total_chunks']}]\n{chunk}"
        )
    context = "\n\n---\n\n".join(context_parts)

    system_prompt = (
        "You are an expert Knowledge Intelligence Assistant. "
        "Answer questions accurately and concisely using ONLY the provided context. "
        "Always cite which source(s) your answer comes from using [Source N] notation. "
        "If the answer cannot be found in the context, say so clearly. "
        "Format your response with clear structure using markdown when helpful."
    )

    user_prompt = f"""Context from the knowledge base:

{context}

---

Question: {question}

Please provide a comprehensive, well-structured answer based on the context above."""

    try:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1500,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        answer = response.content[0].text
    except Exception as e:
        return jsonify({"error": f"LLM call failed: {e}"}), 500

    # Build source list
    sources = []
    seen    = set()
    for meta, dist in zip(metadatas, distances):
        key = meta["doc_id"]
        if key not in seen:
            seen.add(key)
            sources.append({
                "filename":    meta["filename"],
                "doc_id":      meta["doc_id"],
                "relevance":   round((1 - dist) * 100, 1),
                "chunk_index": meta["chunk_index"],
            })

    return jsonify({"answer": answer, "sources": sources,
                     "chunks_retrieved": len(chunks)})

@app.route("/api/documents/<doc_id>", methods=["DELETE"])
def delete_document(doc_id):
    meta = load_meta()
    if doc_id not in meta:
        return jsonify({"error": "Document not found"}), 404

    info = meta[doc_id]

    # Remove from ChromaDB
    try:
        existing = collection.get(where={"doc_id": doc_id})
        if existing["ids"]:
            collection.delete(ids=existing["ids"])
    except Exception:
        pass

    # Remove file
    file_path = UPLOAD_DIR / info["stored_name"]
    file_path.unlink(missing_ok=True)

    del meta[doc_id]
    save_meta(meta)

    return jsonify({"message": "Document deleted successfully"})

@app.route("/api/stats", methods=["GET"])
def stats():
    meta       = load_meta()
    total_docs = len(meta)
    total_chunks = sum(d.get("chunk_count", 0) for d in meta.values())
    total_chars  = sum(d.get("char_count",  0) for d in meta.values())
    return jsonify({
        "total_documents": total_docs,
        "total_chunks":    total_chunks,
        "total_characters": total_chars,
        "vector_count":    collection.count(),
    })

if __name__ == "__main__":
    app.run(debug=True, port=5000)
