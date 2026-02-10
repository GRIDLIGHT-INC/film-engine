# GRIDLIGHT API Reference

Complete endpoint reference for all Gridlight gateway APIs. Use this document when building applications that connect to the Gridlight AI engine.

**Version:** 0.6.2 (LIGHTcYCLES)

---

## Connection

```
Base URL: http://localhost:8080    (default)
          http://192.168.4.192:8080  (network access)
          http://<your-host>:8080    (custom deployment)

Authentication: Bearer token in Authorization header
Default Token:  dev-token (change in production)
```

All requests require:
```
Authorization: Bearer <API_TOKEN>
Content-Type: application/json       (for JSON endpoints)
```

---

## Table of Contents

1. [Core RAG & Query](#1-core-rag--query)
2. [Chat & Conversation](#2-chat--conversation)
3. [File Upload & Training](#3-file-upload--training)
4. [Image Generation](#4-image-generation)
5. [Video Generation](#5-video-generation) *(GRD-1182)*
6. [Music Generation](#6-music-generation) *(feature/music-generation)*
7. [3D Generation](#7-3d-generation) *(feature/3d-generation - planned)*
8. [User Memory System](#8-user-memory-system)
9. [MCP Integration](#9-mcp-integration) *(GRD-220)*
10. [Agent Management](#10-agent-management)
11. [Reindexing & Migration](#11-reindexing--migration)
12. [Data Sources & Databases](#12-data-sources--databases)
13. [Evaluation & Experiments](#13-evaluation--experiments)
14. [License Management](#14-license-management)
15. [Health & Diagnostics](#15-health--diagnostics)
16. [Cluster & Workers](#16-cluster--workers)
17. [Analytics & Monitoring](#17-analytics--monitoring)
18. [Session Management](#18-session-management)
19. [Streaming (SSE) Pattern](#19-streaming-sse-pattern)

---

## 1. Core RAG & Query

### POST /neon

Primary RAG query endpoint. Embeds the question, retrieves relevant documents, reranks, and generates an answer with citations.

**Request:**
```json
{
    "question": "What is our PTO policy?",
    "domain": "HR",
    "stream": true,
    "limit": 10,
    "access_tier": "internal",
    "include_sources": true,
    "store_interaction": true,
    "force_external": false,
    "categories": ["hr-policies"],
    "entity_ids": ["entity-uuid"],
    "entity_type_filter": ["person", "org"],
    "include_audio": false,
    "query_mode": "hybrid",
    "max_tokens": 4096,
    "format": "text",
    "user_id": "user-123",
    "app_id": "my-app"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `question` | string | Yes | - | Query text |
| `domain` | string | No | - | Data isolation boundary |
| `stream` | bool | No | `true` | Enable SSE streaming |
| `limit` | int | No | auto | Max documents to retrieve |
| `access_tier` | string | No | - | `public` \| `internal` \| `restricted` |
| `include_sources` | bool | No | `true` | Return source citations |
| `store_interaction` | bool | No | `true` | Save for learning |
| `force_external` | bool | No | `false` | Force external web search |
| `categories` | string[] | No | - | Filter by categories |
| `entity_ids` | string[] | No | - | Entity ID filters |
| `entity_type_filter` | string[] | No | - | `person` \| `org` \| `location` \| `date` \| `product` \| `concept` |
| `include_audio` | bool | No | `false` | Enable TTS audio output |
| `query_mode` | string | No | - | Query mode override |
| `max_tokens` | int | No | - | Per-request token limit |
| `format` | string | No | `"text"` | `"json"` \| `"text"` |
| `user_id` | string | No | - | For user memory lookup |
| `app_id` | string | No | - | Per-app memory config |

**Response (non-streaming):**
```json
{
    "answer": "Our PTO policy allows...",
    "sources": [
        {
            "id": 12345,
            "score": 0.92,
            "payload": {
                "source": "pto-policy.docx",
                "section": "Section 3",
                "domain": "HR",
                "content": "Relevant excerpt..."
            }
        }
    ],
    "question": "What is our PTO policy?",
    "overall_confidence": 0.89,
    "confidence_level": "high",
    "is_confident": true,
    "entities": [],
    "relationships": [],
    "memory_used": false,
    "memory_count": 0,
    "external_used": false
}
```

**Streaming:** See [SSE Pattern](#19-streaming-sse-pattern).

---

### POST /query

Low-level vector similarity search. Pass a pre-computed embedding vector.

**Request:**
```json
{
    "vector": [0.123, -0.456, 0.789, "...768 or 1024 floats"],
    "top_k": 5
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `vector` | float[] | Yes | - | Embedding vector |
| `top_k` | int | No | `5` | Max results |

**Response:**
```json
{
    "hits": [
        {
            "id": 12345,
            "score": 0.95,
            "payload": { "source": "file.pdf", "domain": "HR", "text": "..." }
        }
    ]
}
```

---

### POST /query-text

Text-based query (server-side embedding).

**Request:**
```json
{
    "text": "PTO policy details",
    "top_k": 5,
    "domain": "HR"
}
```

---

### POST /query/optimized

Optimized query with advanced retrieval options.

**Request:**
```json
{
    "question": "What are the Q4 targets?",
    "domain": "Finance",
    "top_k": 10
}
```

---

## 2. Chat & Conversation

### POST /chat/intelligent

Stateful multi-turn conversation with context awareness, expertise adaptation, and learning insights.

**Request:**
```json
{
    "question": "Can you explain more about the benefits?",
    "conversation_history": [
        {
            "question": "What is our PTO policy?",
            "answer": "Our PTO policy allows 20 days...",
            "timestamp": "2024-01-15T10:30:00Z",
            "entities_mentioned": ["PTO", "vacation"],
            "user_feedback": 0.9
        }
    ],
    "user_context": {
        "user_id": "user-123",
        "session_id": "session-abc",
        "previous_queries": ["PTO policy", "sick leave"],
        "expertise_level": "Intermediate",
        "preferred_response_style": "Conversational"
    },
    "preferences": {
        "max_response_length": 500,
        "include_sources": true,
        "include_related_topics": true,
        "preferred_languages": ["en"],
        "content_filters": []
    },
    "include_enhanced_features": true,
    "include_conversation_context": true,
    "include_learning_insights": true,
    "stream": true
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `question` | string | Yes | - | User question |
| `conversation_history` | array | No | `[]` | Previous Q&A turns |
| `user_context` | object | No | - | User profile and session |
| `preferences` | object | No | - | Response preferences |
| `include_enhanced_features` | bool | No | `false` | Entities, follow-ups |
| `include_conversation_context` | bool | No | `false` | Topic progression |
| `include_learning_insights` | bool | No | `false` | Learning opportunities |
| `stream` | bool | No | `true` | Enable SSE streaming |

**`expertise_level`:** `Beginner` | `Intermediate` | `Expert` | `Adaptive`
**`preferred_response_style`:** `Conversational` | `Professional` | `Technical` | `Educational` | `Adaptive`

**Response:** Same structure as `/neon` with additional conversation context fields.

---

## 3. File Upload & Training

### POST /upload-structured

Upload a file for RAG indexing. The file is parsed, chunked, embedded, and stored.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | binary | Yes | File to upload |
| `metadata` | JSON string | Yes | Upload metadata (see below) |

**Metadata JSON:**
```json
{
    "source": "quarterly_report.pdf",
    "path": "documents/quarterly_report.pdf",
    "domain": "Finance",
    "access_tier": "internal",
    "pii": false,
    "uploaded_at": "2024-01-15T10:30:00Z",
    "size": 524288,
    "type": ".pdf",
    "category": ["reports", "financial"],
    "description": "Q4 2024 quarterly report",
    "chunk_size_limit": 512
}
```

**Supported file types:**
| Category | Extensions |
|----------|-----------|
| Documents | `.docx`, `.pdf`, `.txt`, `.md` |
| Spreadsheets | `.csv`, `.xlsx`, `.xls` |
| Code | `.js`, `.py`, `.java`, `.rs`, `.go`, `.ts` |
| Data | `.json`, `.xml` |

**Response:**
```json
{
    "status": "success",
    "file_id": "550e8400-e29b-41d4-a716-446655440000",
    "chunks_stored": 15,
    "file_size": 524288,
    "chunks_created": 15
}
```

**JavaScript example:**
```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('metadata', JSON.stringify({
    source: file.name,
    path: `uploads/${file.name}`,
    domain: 'Finance',
    access_tier: 'internal',
    pii: false,
    uploaded_at: new Date().toISOString(),
    size: file.size,
    type: file.name.substring(file.name.lastIndexOf('.'))
}));

const response = await fetch(`${BASE_URL}/upload-structured`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    body: formData
});
```

---

### POST /upload-async

Async file upload. Returns immediately with a job ID for tracking.

**Request:** `multipart/form-data` (same as `/upload-structured` plus optional `priority`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | binary | Yes | File to upload |
| `metadata` | JSON string | Yes | Upload metadata |
| `priority` | string | No | `interactive` \| `normal` \| `background` |

**Response:**
```json
{
    "status": "accepted",
    "job_id": "550e8400-e29b-41d4-a716-446655440000",
    "message": "Upload queued for background processing"
}
```

---

### GET /upload-status/:job_id

Check async upload progress.

**Response:**
```json
{
    "job_id": "550e8400-...",
    "status": "processing",
    "progress": 0.65,
    "chunks_processed": 10,
    "chunks_total": 15
}
```

**Status values:** `queued` | `processing` | `completed` | `failed`

---

### GET /upload-queue/stats

Get upload queue statistics.

**Response:**
```json
{
    "queued": 3,
    "processing": 1,
    "completed_today": 25,
    "failed_today": 0
}
```

---

### POST /train

Train Gridlight with raw text or pre-computed embeddings.

**Request:**
```json
{
    "type": "TextChunk",
    "text": "The company was founded in 2020...",
    "payload": {
        "domain": "HR",
        "access_tier": "internal",
        "pii": false,
        "source": "company-overview.txt",
        "path": "documents/company-overview.txt"
    }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | `TextChunk` \| `TableDesc` \| `Metric` \| `Column` \| `TsSegment` \| `ImageDesc` \| `Insight` \| `Prediction` |
| `text` | string | No | - | Text to embed (for server-compute) |
| `embedding` | float[] | No | - | Pre-computed embedding vector |
| `payload` | object | Yes | - | Metadata (must include `domain`, `access_tier`, `pii`) |
| `blob_zstd` | string | No | - | Base64-encoded zstd-compressed blob |

**Response:**
```json
{
    "status": "success",
    "record_id": "550e8400-...",
    "embedding_model": "bge-large-en-v1.5"
}
```

---

## 4. Image Generation

### POST /image

Generate images from text prompts. Supports text-to-image, image-to-image, and inpainting.

**Request:**
```json
{
    "prompt": "A futuristic cityscape at sunset, cyberpunk style",
    "negative_prompt": "blurry, low quality",
    "model": "sdxl",
    "width": 1024,
    "height": 1024,
    "steps": 50,
    "guidance_scale": 9.0,
    "seed": 42,
    "stream": true,
    "nsfw_filter": true,
    "domain": "marketing",
    "category": ["brand-assets"],
    "init_image": "<base64-encoded-image>",
    "strength": 0.7,
    "mask_image": "<base64-encoded-mask>",
    "gpu_count": 1
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Text description of desired image |
| `negative_prompt` | string | No | - | What to exclude |
| `model` | string | No | `"sdxl"` | Model: `sdxl`, `flux`, etc. |
| `width` | int | No | `1024` | Image width in pixels |
| `height` | int | No | `1024` | Image height in pixels |
| `steps` | int | No | `50` | Inference steps (1-100) |
| `guidance_scale` | float | No | `9.0` | CFG scale (1.0-20.0) |
| `seed` | int | No | random | Reproducible generation |
| `stream` | bool | No | `true` | SSE streaming for progress |
| `nsfw_filter` | bool | No | - | Content filtering |
| `domain` | string | No | - | Data isolation |
| `category` | string[] | No | - | Categorization |
| `init_image` | string | No | - | Base64 image for img2img |
| `strength` | float | No | - | img2img strength (0.0-1.0) |
| `mask_image` | string | No | - | Base64 mask for inpainting |
| `gpu_count` | int | No | `1` | Multi-GPU (1+) |

**Response:**
```json
{
    "status": "success",
    "image_urls": ["http://<host>:8080/images/img_abc123.png"],
    "seed": 42,
    "model_used": "sdxl",
    "generation_time_ms": 45000,
    "resolution_tier": 4
}
```

**Chat command:** Type `/image <prompt>` in gridlight-chat to generate inline.

---

### GET /images/:filename

Serve a generated image file.

**Supported formats:** `.png`, `.jpg`, `.webp`

**Response:** Binary image data with appropriate `Content-Type` header.

---

## 5. Video Generation

> **Branch:** GRD-1182 (video-generation)

### POST /video

Generate video from text, image, or existing video.

**Request:**
```json
{
    "prompt": "A drone shot flying over a mountain lake at golden hour",
    "negative_prompt": "shaky, blurry, low quality",
    "model": "auto",
    "mode": "text2video",
    "width": 768,
    "height": 512,
    "fps": 24,
    "duration_seconds": 5.0,
    "steps": 8,
    "guidance_scale": 1.0,
    "seed": 42,
    "stream": true,
    "quality_preset": "standard",
    "init_image": "<base64-image>",
    "init_video": "<base64-video>",
    "strength": 0.8,
    "nsfw_filter": true,
    "domain": "marketing",
    "category": ["brand-videos"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Text description |
| `negative_prompt` | string | No | - | What to exclude |
| `model` | string | No | `"auto"` | Model selection |
| `mode` | string | No | `"text2video"` | `text2video` \| `image2video` \| `video2video` |
| `width` | int | No | `768` | Video width (max 3840) |
| `height` | int | No | `512` | Video height (max 2160) |
| `fps` | int | No | `24` | Frames per second: `8` \| `16` \| `24` |
| `duration_seconds` | float | No | `5.0` | Duration (0-60 seconds) |
| `steps` | int | No | `8` | Inference steps |
| `guidance_scale` | float | No | `1.0` | CFG scale |
| `seed` | int | No | random | Reproducible generation |
| `stream` | bool | No | `true` | SSE streaming for progress |
| `quality_preset` | string | No | - | Quality level |
| `init_image` | string | No | - | Base64 image (max 10MB) for image2video |
| `init_video` | string | No | - | Base64 video for video2video |
| `strength` | float | No | - | Conditioning strength (0.0-1.0) |
| `nsfw_filter` | bool | No | - | Content filtering |
| `domain` | string | No | - | Data isolation |
| `category` | string[] | No | - | Categorization |

**Response:**
```json
{
    "status": "success",
    "video_url": "http://<host>:8080/videos/vid_abc123.mp4",
    "seed": 42,
    "model_used": "ltx-2",
    "generation_time_ms": 120000
}
```

---

### POST /video/production

Multi-clip video stitching. Combine 1-20 shots into a production video.

**Request:**
```json
{
    "shots": [
        {
            "prompt": "Wide establishing shot of a city skyline",
            "duration_seconds": 3.0
        },
        {
            "prompt": "Close-up of people walking in the street",
            "duration_seconds": 4.0
        }
    ],
    "width": 768,
    "height": 512,
    "fps": 24,
    "model": "auto",
    "stream": true
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `shots` | array | Yes | - | 1-20 shot definitions |
| `shots[].prompt` | string | Yes | - | Shot description |
| `shots[].duration_seconds` | float | Yes | - | Shot duration |
| `width` | int | No | `768` | Video width |
| `height` | int | No | `512` | Video height |
| `fps` | int | No | `24` | Frames per second |
| `model` | string | No | `"auto"` | Model selection |
| `stream` | bool | No | `true` | SSE streaming |

---

### GET /videos/:filename

Serve a generated video file with chunked transfer encoding.

**Supported formats:** `.mp4`, `.webm`

**Response:** Binary video data with appropriate `Content-Type` and `Cache-Control: public, max-age=86400`.

---

## 6. Music Generation

> **Branch:** feature/music-generation

### POST /music

Generate music from text prompts using AudioGen.

**Request:**
```json
{
    "prompt": "Upbeat electronic dance music with heavy bass",
    "duration_s": 15.0,
    "seed": 42,
    "stream": true,
    "temperature": 1.0,
    "top_k": 250,
    "top_p": 0.0,
    "cfg_coeff": 3.0
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | Yes | - | Music description |
| `duration_s` | float | No | `15.0` | Duration in seconds (1-30) |
| `seed` | int | No | random | Reproducible generation |
| `stream` | bool | No | `true` | SSE streaming for progress |
| `temperature` | float | No | `1.0` | Sampling temperature |
| `top_k` | int | No | `250` | Top-K sampling |
| `top_p` | float | No | `0.0` | Top-P (nucleus) sampling |
| `cfg_coeff` | float | No | `3.0` | Classifier-free guidance coefficient |

**Response:**
```json
{
    "status": "success",
    "audio_url": "http://<host>:8080/music/audio_abc123.wav",
    "seed": 42,
    "generation_time_ms": 30000
}
```

---

### GET /music/:filename

Serve a generated audio file.

**Supported formats:** `.wav`, `.mp3`, `.flac`, `.ogg`

**Response:** Binary audio data with appropriate `Content-Type`.

---

## 7. 3D Generation

> **Branch:** feature/3d-generation (planned, not yet implemented)

### POST /3d/generate *(planned)*

Generate 3D models from text or image prompts.

```json
{
    "prompt": "A medieval castle with stone walls",
    "image_base64": "<optional base64 reference image>",
    "pipeline": "triposr",
    "format": "glb",
    "quality": "standard",
    "auto_rig": false,
    "seed": 42,
    "domain": "assets",
    "stream": true
}
```

### GET /3d/job/:job_id *(planned)*
### GET /3d/job/:job_id/stream *(planned)*
### GET /3d/assets/:asset_id *(planned)*
### GET /3d/assets *(planned)*
### POST /3d/from-image *(planned)*
### POST /3d/batch *(planned)*

---

## 8. User Memory System

The memory system stores per-user facts, preferences, and context. When a query routes through memory-first classification with high confidence (>0.7), the RAG pipeline is skipped for faster responses.

### POST /remember

Store a memory for a user.

**Request:**
```json
{
    "user_id": "user-123",
    "content": "I am a 50 year old man, 5'8\" and 180 pounds",
    "memory_type": "fact",
    "importance": 0.9,
    "app_id": "my-app",
    "tenant_id": "tenant-uuid",
    "expires_in": "30d"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `user_id` | string | Yes | - | User identifier |
| `content` | string | Yes | - | Memory content (1-5000 chars) |
| `memory_type` | string | No | `"fact"` | `fact` \| `preference` \| `context` \| `interaction` |
| `importance` | float | No | `0.9` | Importance weight (0.0-1.0) |
| `app_id` | string | No | - | Per-app memory isolation |
| `tenant_id` | string | No | - | Multi-tenant isolation (UUID) |
| `expires_in` | string | No | `null` (never) | `"24h"` \| `"7d"` \| `"30d"` \| `null` |

**Response:**
```json
{
    "status": "stored",
    "memory_id": "550e8400-...",
    "user_id": "user-123",
    "created_at": "2024-01-15T10:30:00Z",
    "expires_at": "2024-02-14T10:30:00Z"
}
```

---

### POST /forget

Delete user memories.

**Request:**
```json
{
    "user_id": "user-123",
    "memory_id": "550e8400-...",
    "content_match": "180 pounds",
    "tenant_id": "tenant-uuid"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `user_id` | string | Yes | - | User identifier |
| `memory_id` | string | No | - | Specific memory UUID to delete |
| `content_match` | string | No | - | Delete by content substring match |
| `tenant_id` | string | No | - | Multi-tenant isolation |

Provide either `memory_id` (delete one) or `content_match` (delete matching).

**Response:**
```json
{
    "status": "deleted",
    "count": 1
}
```

---

### GET /memories

List memories for a user.

**Query Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `user_id` | string | Yes | - | User identifier |
| `tenant_id` | string | No | - | Multi-tenant filter |
| `memory_type` | string | No | - | Filter by type |
| `limit` | int | No | `100` | Max memories returned |

**Example:** `GET /memories?user_id=user-123&memory_type=fact&limit=50`

**Response:**
```json
{
    "memories": [
        {
            "id": "550e8400-...",
            "user_id": "user-123",
            "content": "I am a 50 year old man",
            "memory_type": "fact",
            "importance": 0.9,
            "created_at": "2024-01-15T10:30:00Z",
            "expires_at": null
        }
    ],
    "total": 5
}
```

---

### GET /memory/stats

Get memory statistics for a user.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | string | Yes | User identifier |
| `tenant_id` | string | No | Multi-tenant filter |

**Example:** `GET /memory/stats?user_id=user-123`

**Response:**
```json
{
    "user_id": "user-123",
    "stats": {
        "total": 50,
        "by_type": {
            "facts": 25,
            "preferences": 15,
            "context": 7,
            "interaction": 3
        },
        "average_importance": 0.85,
        "oldest_memory_age_days": 180,
        "expiring_soon": 2
    }
}
```

---

## 9. MCP Integration

> **Branch:** GRD-220 (MCP-integration)

Model Context Protocol integration for connecting external tools and services.

### GET /mcp/servers

List all registered MCP servers.

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | string | No | Filter by owner |

**Response:**
```json
{
    "servers": [
        {
            "id": "server-uuid",
            "name": "GitHub Tools",
            "transport": "http",
            "url": "https://mcp.github.com/v1",
            "enabled": true,
            "tools_count": 12,
            "health": "healthy"
        }
    ]
}
```

---

### POST /mcp/servers

Register a new MCP server.

**Request:**
```json
{
    "name": "GitHub Tools",
    "transport": {
        "type": "http",
        "url": "https://mcp.github.com/v1",
        "auth": {
            "type": "bearer",
            "token": "ghp_xxxx"
        }
    },
    "timeout_secs": 30,
    "enabled": true,
    "user_id": "user-123"
}
```

For STDIO transport:
```json
{
    "name": "Local Python Tool",
    "transport": {
        "type": "stdio",
        "command": "python",
        "args": ["-m", "my_tool_server"],
        "env": { "MY_VAR": "value" }
    },
    "enabled": true
}
```

---

### DELETE /mcp/servers/:id

Remove an MCP server.

**Query Parameters:** `user_id` (optional)

---

### POST /mcp/servers/:id/test

Test connectivity to an MCP server.

**Response:**
```json
{
    "status": "healthy",
    "latency_ms": 150,
    "tools_available": 12,
    "capabilities": { "tools": true, "resources": false, "prompts": false }
}
```

---

### GET /mcp/health

Overall MCP subsystem health.

**Response:**
```json
{
    "enabled": true,
    "servers_total": 5,
    "servers_healthy": 4,
    "servers_unhealthy": 1
}
```

---

### GET /tools

List all available tools (built-in + agent + MCP).

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | No | `agent` \| `mcp` \| `builtin` |
| `query` | string | No | Search filter |

**Response:**
```json
{
    "tools": [
        {
            "name": "github_search",
            "description": "Search GitHub repositories",
            "source": "mcp",
            "server_id": "server-uuid",
            "input_schema": { "type": "object", "properties": { "query": { "type": "string" } } }
        }
    ]
}
```

---

### POST /apps/:slug/connections/:conn_id/execute

Execute a tool through the app-to-connection bridge.

**Request:**
```json
{
    "tool_name": "github_search",
    "arguments": {
        "query": "gridlight bugs"
    }
}
```

**Response:**
```json
{
    "success": true,
    "content": [
        { "type": "text", "text": "Found 5 results..." }
    ],
    "latency_ms": 250
}
```

---

## 10. Agent Management

### POST /agents/register

Register a compute agent with the gateway.

**Request:**
```json
{
    "agent_id": "agent-gpu-01",
    "host": "192.168.4.100",
    "port": 9000,
    "backend": "Cuda",
    "gpu_model": "NVIDIA RTX 4090",
    "vram_gb": 24.0,
    "gpu_count": 2,
    "total_vram_gb": 48.0,
    "per_gpu_vram_gb": [24.0, 24.0],
    "cpu_cores": 16,
    "roles": ["Infer", "Embed", "Rerank"],
    "models_cached": ["qwen3-32b", "bge-large-en-v1.5"],
    "queue_depth": 4,
    "latency_p50_ms": 150.0,
    "reported_tflops": 82.6,
    "metadata": { "location": "rack-3" }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `agent_id` | string | Yes | - | Unique agent ID |
| `host` | string | Yes | - | Agent host/IP |
| `port` | int | Yes | - | Agent service port |
| `backend` | string | Yes | - | `Metal` \| `Cuda` \| `Rocm` \| `Vulkan` \| `Cpu` \| `openvino` \| `coreml` \| `xdna` \| `hexagon` |
| `roles` | string[] | Yes | - | `Infer` \| `Embed` \| `Rerank` \| `Verify` \| `imagegen` \| `videogen` \| `audiogen` \| `gen3d` \| `meshprocess` |
| `models_cached` | string[] | Yes | - | Currently loaded models |
| `queue_depth` | int | Yes | - | Processing queue depth |
| `latency_p50_ms` | float | Yes | - | Median latency |
| `gpu_model` | string | No | - | GPU model name |
| `vram_gb` | float | No | - | Single GPU VRAM |
| `gpu_count` | int | No | - | Number of GPUs |
| `total_vram_gb` | float | No | - | Total VRAM |
| `cpu_cores` | int | No | - | CPU count |
| `reported_tflops` | float | No | - | Agent TFLOP capacity |
| `metadata` | object | No | `{}` | Custom key-value metadata |

**Response:**
```json
{
    "status": "registered",
    "agent_id": "agent-gpu-01"
}
```

---

### GET /agents/list

List all registered agents.

**Response:**
```json
{
    "agents": [
        {
            "agent_id": "agent-gpu-01",
            "host": "192.168.4.100",
            "port": 9000,
            "roles": ["Infer", "Embed"],
            "backend": "Cuda",
            "gpu_model": "NVIDIA RTX 4090",
            "status": "active",
            "last_heartbeat": "2024-01-15T10:30:00Z"
        }
    ]
}
```

---

### GET /agents/stats

Agent statistics summary.

### POST /agents/heartbeat

Agent heartbeat ping.

**Request:**
```json
{
    "agent_id": "agent-gpu-01",
    "queue_depth": 2,
    "latency_p50_ms": 140.0
}
```

### POST /agents/unregister

Unregister an agent.

**Request:**
```json
{
    "agent_id": "agent-gpu-01"
}
```

### POST /agents/tflop-report

Report TFLOP usage from an agent.

**Request:**
```json
{
    "agent_id": "agent-gpu-01",
    "tflops_used": 5.2,
    "operation": "inference",
    "duration_ms": 1500
}
```

### GET /agents/activity

Get agent activity log.

### GET /agents/activity/recent

Get recent agent activity.

### GET /agents/activity/stats

Get agent activity statistics.

---

## 11. Reindexing & Migration

### POST /reindex

Start a reindex job.

**Request:**
```json
{
    "job_type": "incremental",
    "target_id": "Finance",
    "batch_size": 8,
    "dry_run": false,
    "re_embed": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `job_type` | string | No | `"document"` | `document` \| `domain` \| `full` \| `incremental` \| `migrate` |
| `target_id` | string | Conditional | - | Document ID or domain name (required for `document`/`domain`) |
| `batch_size` | int | No | `8` | Chunks per batch (1-50) |
| `dry_run` | bool | No | `false` | Preview without executing |
| `re_embed` | bool | No | `false` | Re-compute embeddings (for `migrate`) |

**Response:**
```json
{
    "status": "started",
    "job_id": "550e8400-...",
    "job_type": "incremental",
    "estimated_chunks": 1500,
    "batch_size": 8
}
```

---

### GET /reindex/status/:job_id

Check reindex job status.

### POST /reindex/pause/:job_id

Pause a running reindex job.

### POST /reindex/resume/:job_id

Resume a paused reindex job.

### GET /reindex/stats

Get reindex queue statistics.

---

### GET /migration/history

List all migrations.

### GET /migration/:migration_id

Get migration details.

### POST /migration/:migration_id/rollback

Rollback a specific migration.

---

## 12. Data Sources & Databases

### POST /connect-database

Connect an external database for RAG ingestion.

**Request:**
```json
{
    "database_config": {
        "db_type": "postgres",
        "host": "db.example.com",
        "port": 5432,
        "username": "reader",
        "password": "secret",
        "database": "analytics",
        "ssl": true
    },
    "domain": "Analytics",
    "access_tier": "restricted",
    "pii": false,
    "ingestion_mode": "FullImport",
    "connection_name": "Analytics DB",
    "table_limit": 50,
    "categories": ["databases"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `database_config` | object | Yes | - | Connection details |
| `database_config.db_type` | string | Yes | - | `postgres` \| `mysql` \| `snowflake` \| etc. |
| `domain` | string | Yes | - | Data isolation |
| `access_tier` | string | Yes | - | `public` \| `internal` \| `restricted` |
| `pii` | bool | Yes | - | Contains PII |
| `ingestion_mode` | string | No | `"FullImport"` | `FullImport` \| `Fallback` |
| `connection_name` | string | No | - | Human-readable name |
| `table_limit` | int | No | - | Max tables to import |

**Response:**
```json
{
    "status": "connected",
    "connection_id": "550e8400-...",
    "tables_found": 25,
    "tables_imported": 20
}
```

---

### POST /sources/register

Register an external web source for crawling.

**Request:**
```json
{
    "id": "company-docs",
    "kind": "LinkList",
    "links": [
        "https://docs.example.com/guide",
        "https://docs.example.com/api"
    ],
    "enabled": true,
    "crawl_mode": "Immediate",
    "domain": "Docs",
    "access_tier": "internal",
    "categories": ["documentation"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | - | Unique source ID |
| `kind` | string | No | `"LinkList"` | `LinkList` \| `HttpApi` |
| `links` | string[] | Conditional | - | URLs to crawl (for LinkList) |
| `base_url` | string | Conditional | - | API base URL (for HttpApi) |
| `search_path` | string | No | - | Search endpoint path (for HttpApi) |
| `headers` | object | No | - | HTTP headers |
| `enabled` | bool | No | `false` | Enable source |
| `crawl_mode` | string | No | `"OnDemand"` | `Immediate` \| `OnDemand` |
| `domain` | string | No | - | Data isolation |
| `access_tier` | string | No | - | Access level |

---

### GET /sources

List registered sources.

### GET /chunks/:chunk_id

Retrieve a specific stored chunk.

### GET /resources/stats

Get resource statistics.

---

## 13. Evaluation & Experiments

### POST /evaluate

Run retrieval accuracy evaluation.

**Request:**
```json
{
    "test_cases": [
        {
            "query": "What is the PTO policy?",
            "expected_doc_ids": ["doc-123", "doc-456"],
            "domain": "HR"
        }
    ],
    "domain": "HR",
    "top_k": 10
}
```

**Response:**
```json
{
    "evaluation_id": "eval-uuid",
    "test_case_count": 5,
    "avg_precision": 0.85,
    "avg_recall": 0.92,
    "avg_f1": 0.88,
    "avg_mrr": 0.90,
    "per_case_results": [
        {
            "query": "What is the PTO policy?",
            "precision": 0.90,
            "recall": 1.0,
            "f1": 0.95,
            "mrr": 1.0,
            "retrieved_count": 10,
            "expected_count": 2,
            "hits": 2
        }
    ]
}
```

---

### GET /evaluations

Get evaluation history.

---

### POST /experiments

Create an A/B test experiment.

**Request:**
```json
{
    "name": "reranker-comparison",
    "description": "Compare BGE vs cross-encoder reranking",
    "variants": [
        { "id": "a", "name": "BGE Reranker", "config": { "reranker": "bge" }, "weight": 50 },
        { "id": "b", "name": "Cross-Encoder", "config": { "reranker": "cross-encoder" }, "weight": 50 }
    ],
    "traffic_percentage": 100,
    "domain_filter": ["HR"]
}
```

### GET /experiments

List all experiments.

### GET /experiments/:id

Get experiment details.

### POST /experiments/:id/start

Start an experiment.

### POST /experiments/:id/pause

Pause an experiment.

### POST /experiments/:id/complete

Complete (finish) an experiment.

### GET /experiments/:id/results

Get experiment results with metrics.

---

## 14. License Management

### GET /license/status

Get current license status.

**Response:**
```json
{
    "valid": true,
    "tier": "enterprise",
    "tflops_allocated": 500.0,
    "tflops_used": 125.3,
    "expires_at": "2025-12-31T23:59:59Z"
}
```

### GET /license/analytics

License usage analytics.

### GET /license/allocation

Get TFLOP allocation settings.

### PUT /license/allocation

Update TFLOP allocation.

**Request:**
```json
{
    "tflops_ceiling": 500.0,
    "per_agent_limit": 100.0
}
```

### GET /license/debug

License debug information.

### POST /license/install

Install a new license.

**Request:**
```json
{
    "license_key": "GRID-XXXX-XXXX-XXXX"
}
```

### POST /license/test-heartbeat

Test license heartbeat.

### POST /license/allocation-changed

Notify of allocation changes.

---

## 15. Health & Diagnostics

### GET /healthz

Health check endpoint. Returns `200 OK` when the gateway is running.

**Response:**
```json
{
    "status": "ok",
    "version": "0.6.2"
}
```

### GET /VERSION

Get gateway version.

**Response:** `"0.6.2"`

### GET /debug/status

Debug status information.

### GET /debug/performance

Performance metrics and profiling data.

### GET /features

List enabled feature flags.

---

## 16. Cluster & Workers

### GET /cluster/status

Cluster status overview.

### GET /cluster/services

List cluster services.

### POST /cluster/discovery

Trigger service discovery.

### GET /workers/status

Worker status information.

### GET /workers/live

Live worker connections (WebSocket/SSE).

---

## 17. Analytics & Monitoring

### POST /analytics

Submit analytics event.

### GET /metrics/realtime

Real-time system metrics.

### GET /retrieval-metrics

Retrieval performance dashboard metrics.

### GET /throttle/status

Throttle status for dashboard.

### GET /tflops/realtime

Real-time TFLOP statistics.

**Response:**
```json
{
    "total_tflops": 500.0,
    "used_tflops": 125.3,
    "available_tflops": 374.7,
    "utilization_pct": 25.06,
    "per_agent": [
        { "agent_id": "agent-01", "tflops": 82.6, "utilization_pct": 65.0 }
    ]
}
```

---

### POST /predict

Schedule a prediction job.

### GET /predict

List predictions.

### DELETE /predict

Disable predictions.

### DELETE /predict/{job_id}

Delete a specific prediction.

---

### GET /ingestion/stats

Get ingestion statistics.

---

### POST /graph/updates

Submit graph updates.

### GET /graph/live

Live graph updates (SSE).

---

### POST /ml/entities

ML entity extraction.

### POST /entity/resolution

Entity resolution.

---

### POST /dev/save-sample

Save a sample (dev only).

---

## 18. Session Management

### POST /sessions/cleanup

Clean up expired sessions.

### POST /sessions/clear

Clear all sessions.

---

## 19. Streaming (SSE) Pattern

Endpoints that support `"stream": true` return Server-Sent Events (SSE).

**Content-Type:** `text/event-stream`

**Event format:**
```
data: {"token": "The "}

data: {"token": "answer "}

data: {"token": "is..."}

data: {"sources": [{"document": "policy.pdf", "score": 0.92}]}

data: [DONE]
```

**JavaScript implementation:**
```javascript
const response = await fetch(`${BASE_URL}/neon`, {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        question: "What is our PTO policy?",
        domain: "HR",
        stream: true
    })
});

const contentType = response.headers.get('content-type') || '';
if (contentType.includes('text/event-stream') && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;

                try {
                    const parsed = JSON.parse(data);
                    if (parsed.token) {
                        fullText += parsed.token;
                        updateUI(fullText);
                    }
                    if (parsed.sources) {
                        displaySources(parsed.sources);
                    }
                } catch (e) {
                    console.warn('Parse error:', e);
                }
            }
        }
    }
}
```

---

## Quick Reference: All Endpoints

| Method | Path | Category | Description |
|--------|------|----------|-------------|
| **GET** | `/healthz` | Health | Health check |
| **GET** | `/VERSION` | Health | API version |
| **GET** | `/debug/status` | Health | Debug status |
| **GET** | `/debug/performance` | Health | Performance metrics |
| **GET** | `/features` | Health | Feature flags |
| **POST** | `/neon` | Query | Primary RAG query |
| **POST** | `/query` | Query | Vector search |
| **POST** | `/query-text` | Query | Text search |
| **POST** | `/query/optimized` | Query | Optimized query |
| **POST** | `/chat/intelligent` | Chat | Multi-turn conversation |
| **POST** | `/upload-structured` | Upload | Sync file upload |
| **POST** | `/upload-async` | Upload | Async file upload |
| **GET** | `/upload-status/:job_id` | Upload | Upload progress |
| **GET** | `/upload-queue/stats` | Upload | Queue stats |
| **POST** | `/train` | Training | Text/embedding training |
| **POST** | `/image` | Image | Generate image |
| **GET** | `/images/:filename` | Image | Serve image |
| **POST** | `/video` | Video | Generate video |
| **POST** | `/video/production` | Video | Multi-clip video |
| **GET** | `/videos/:filename` | Video | Serve video |
| **POST** | `/music` | Music | Generate music |
| **GET** | `/music/:filename` | Music | Serve audio |
| **POST** | `/remember` | Memory | Store memory |
| **POST** | `/forget` | Memory | Delete memory |
| **GET** | `/memories` | Memory | List memories |
| **GET** | `/memory/stats` | Memory | Memory stats |
| **GET** | `/mcp/servers` | MCP | List MCP servers |
| **POST** | `/mcp/servers` | MCP | Add MCP server |
| **DELETE** | `/mcp/servers/:id` | MCP | Remove MCP server |
| **POST** | `/mcp/servers/:id/test` | MCP | Test MCP server |
| **GET** | `/mcp/health` | MCP | MCP health |
| **GET** | `/tools` | MCP | List all tools |
| **POST** | `/apps/:slug/connections/:conn_id/execute` | MCP | Execute tool |
| **POST** | `/agents/register` | Agents | Register agent |
| **GET** | `/agents/list` | Agents | List agents |
| **GET** | `/agents/stats` | Agents | Agent stats |
| **POST** | `/agents/heartbeat` | Agents | Agent heartbeat |
| **POST** | `/agents/unregister` | Agents | Unregister agent |
| **POST** | `/agents/tflop-report` | Agents | TFLOP report |
| **GET** | `/agents/activity` | Agents | Activity log |
| **GET** | `/agents/activity/recent` | Agents | Recent activity |
| **GET** | `/agents/activity/stats` | Agents | Activity stats |
| **POST** | `/reindex` | Reindex | Start reindex |
| **GET** | `/reindex/status/:job_id` | Reindex | Job status |
| **POST** | `/reindex/pause/:job_id` | Reindex | Pause job |
| **POST** | `/reindex/resume/:job_id` | Reindex | Resume job |
| **GET** | `/reindex/stats` | Reindex | Queue stats |
| **GET** | `/migration/history` | Migration | List migrations |
| **GET** | `/migration/:migration_id` | Migration | Migration details |
| **POST** | `/migration/:migration_id/rollback` | Migration | Rollback |
| **POST** | `/connect-database` | Sources | Connect database |
| **POST** | `/sources/register` | Sources | Register source |
| **GET** | `/sources` | Sources | List sources |
| **GET** | `/chunks/:chunk_id` | Sources | Get chunk |
| **GET** | `/resources/stats` | Sources | Resource stats |
| **POST** | `/evaluate` | Evaluation | Run evaluation |
| **GET** | `/evaluations` | Evaluation | Evaluation history |
| **GET** | `/ingestion/stats` | Evaluation | Ingestion stats |
| **POST** | `/experiments` | Experiments | Create experiment |
| **GET** | `/experiments` | Experiments | List experiments |
| **GET** | `/experiments/:id` | Experiments | Get experiment |
| **POST** | `/experiments/:id/start` | Experiments | Start experiment |
| **POST** | `/experiments/:id/pause` | Experiments | Pause experiment |
| **POST** | `/experiments/:id/complete` | Experiments | Complete experiment |
| **GET** | `/experiments/:id/results` | Experiments | Get results |
| **GET** | `/license/status` | License | License status |
| **GET** | `/license/analytics` | License | License analytics |
| **GET** | `/license/allocation` | License | Get allocation |
| **PUT** | `/license/allocation` | License | Update allocation |
| **GET** | `/license/debug` | License | License debug |
| **POST** | `/license/install` | License | Install license |
| **POST** | `/license/test-heartbeat` | License | Test heartbeat |
| **POST** | `/license/allocation-changed` | License | Allocation changed |
| **GET** | `/cluster/status` | Cluster | Cluster status |
| **GET** | `/cluster/services` | Cluster | Cluster services |
| **POST** | `/cluster/discovery` | Cluster | Trigger discovery |
| **GET** | `/workers/status` | Cluster | Worker status |
| **GET** | `/workers/live` | Cluster | Live workers |
| **POST** | `/analytics` | Monitoring | Submit analytics |
| **GET** | `/metrics/realtime` | Monitoring | Real-time metrics |
| **GET** | `/retrieval-metrics` | Monitoring | Retrieval metrics |
| **GET** | `/throttle/status` | Monitoring | Throttle status |
| **GET** | `/tflops/realtime` | Monitoring | Real-time TFLOPs |
| **POST** | `/predict` | Monitoring | Schedule prediction |
| **GET** | `/predict` | Monitoring | List predictions |
| **DELETE** | `/predict` | Monitoring | Disable predictions |
| **DELETE** | `/predict/{job_id}` | Monitoring | Delete prediction |
| **POST** | `/graph/updates` | Graph | Graph updates |
| **GET** | `/graph/live` | Graph | Live graph |
| **POST** | `/ml/entities` | ML | Entity extraction |
| **POST** | `/entity/resolution` | ML | Entity resolution |
| **POST** | `/sessions/cleanup` | Sessions | Cleanup sessions |
| **POST** | `/sessions/clear` | Sessions | Clear sessions |
| **POST** | `/dev/save-sample` | Dev | Save sample |

**Total: 93 endpoints (dev) + 7 MCP + 3 video + 2 music = 105 endpoints**
