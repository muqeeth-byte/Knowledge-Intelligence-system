# ◈ KIS — Knowledge Intelligence System

A production-grade RAG (Retrieval-Augmented Generation) application that lets you upload documents and ask intelligent, source-cited questions about them.

---

## Architecture

```
Documents (PDF/TXT/DOCX/MD)
        ↓
  Parse & Chunk text
        ↓
  Embed via SentenceTransformers (all-MiniLM-L6-v2)
        ↓
  Store in ChromaDB (vector store)
        ↓
User Question → Embed → Vector Search → Top-K Chunks
        ↓
  RAG Prompt Builder → Claude (claude-sonnet-4-20250514)
        ↓
  Answer + Source Citations → Web UI
```

## Stack

| Layer | Technology |
|---|---|
| LLM | Anthropic Claude (claude-sonnet-4-20250514) |
| Embeddings | SentenceTransformers `all-MiniLM-L6-v2` (local, free) |
| Vector Store | ChromaDB (persistent, local) |
| Backend | Flask + Flask-CORS |
| Frontend | Vanilla JS + CSS (no build step needed) |
| PDF parsing | PyPDF2 |
| DOCX parsing | python-docx |

---

## Setup & Run

### 1. Prerequisites
- Python 3.9+
- An Anthropic API key ([get one here](https://console.anthropic.com))

### 2. Set your API key
```bash
export ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### 3. Run
```bash
chmod +x start.sh
./start.sh
```

Or manually:
```bash
pip install -r requirements.txt
python app.py
```

### 4. Open
Visit **http://localhost:5000** in your browser.

---

## Usage

1. **Upload** — Drag & drop or browse for PDF, TXT, DOCX, or MD files
2. **Wait** — Documents are parsed, chunked, embedded, and indexed in ChromaDB
3. **Ask** — Type any question about your documents
4. **Filter** — Click documents in the library to restrict search to specific files
5. **Read citations** — Every answer shows which documents were retrieved and their relevance scores

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/documents` | List all indexed documents |
| `POST` | `/api/upload` | Upload and index a document |
| `POST` | `/api/ask` | Ask a question (RAG pipeline) |
| `DELETE` | `/api/documents/:id` | Delete a document and its vectors |
| `GET` | `/api/stats` | System statistics |

### Example: Ask a question via curl
```bash
curl -X POST http://localhost:5000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What are the key findings?"}'
```

### Example: Filter by document
```bash
curl -X POST http://localhost:5000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Summarize this", "doc_ids": ["<doc-id>"]}'
```

---

## Configuration

Edit these constants in `app.py`:

```python
CHUNK_SIZE    = 800   # words per chunk
CHUNK_OVERLAP = 150   # word overlap between chunks
TOP_K         = 5     # chunks retrieved per query
```
